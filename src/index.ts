import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json({ limit: "100kb" }));

// Pause guard: refuses non-idempotent methods with 503 except
// /admin/unpause, so an operator can always recover.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!paused) return next();
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (req.path === "/api/v1/admin/unpause") return next();
  res.status(503).json({
    error: "service_paused",
    message: "StableRoute backend is paused",
    requestId: (req as Request & { id?: string }).id,
  });
});

// Per-IP sliding-window rate limiter: 60 requests per 60 second window.
const RATE_LIMIT_PER_WINDOW = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();
app.use((req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (bucket.length >= RATE_LIMIT_PER_WINDOW) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({
      error: "rate_limited",
      message: `more than ${RATE_LIMIT_PER_WINDOW} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`,
      requestId: (req as Request & { id?: string }).id,
    });
    return;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  next();
});

// Request timing — emits a single structured log per finished request
// and sets Server-Timing.
app.use((req: Request, res: Response, next: NextFunction) => {
  const startNs = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (process.env.NODE_ENV !== "test") {
      console.log(
        JSON.stringify({
          requestId: (req as Request & { id?: string }).id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(ms * 10) / 10,
        })
      );
    }
  });
  next();
});

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

// Attach an X-Request-Id to every response, echoing the caller's value
// when present (so a gateway/load-balancer chain stays correlated) and
// minting a fresh UUID otherwise. Surfaced as `req.id` so handlers and
// the error middleware can quote it in their JSON bodies.
app.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = req.header("x-request-id");
  const id = incoming && incoming.length <= 200 ? incoming : randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader("X-Request-Id", id);
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "stableroute-backend" });
});

let paused = false;
app.post("/api/v1/admin/pause", (_req: Request, res: Response) => {
  paused = true;
  res.json({ paused });
});
app.post("/api/v1/admin/unpause", (_req: Request, res: Response) => {
  paused = false;
  res.json({ paused });
});
app.get("/api/v1/admin/status", (_req: Request, res: Response) => {
  res.json({ paused });
});

app.get("/api/v1/metrics", (_req: Request, res: Response) => {
  const lines = [
    "# HELP stableroute_pairs_total Number of registered pairs.",
    "# TYPE stableroute_pairs_total gauge",
    `stableroute_pairs_total ${pairRegistry.size}`,
    "# HELP stableroute_paused 1 if paused, 0 otherwise.",
    "# TYPE stableroute_paused gauge",
    `stableroute_paused ${paused ? 1 : 0}`,
  ];
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(lines.join("\n") + "\n");
});

app.get("/api/v1/stats", (_req: Request, res: Response) => {
  res.json({
    totalPairs: pairRegistry.size,
    paused,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pair registry
// ─────────────────────────────────────────────────────────────────────────────
//
// In-memory mirror of the on-chain DataKey::Pair(source, dest) set the
// router contract maintains. The settlement worker fans out from the
// contract to this Map on startup and on every pair-registration event.
// Process restart resets the map; persistence lands with the database
// adapter.
const pairRegistry = new Set<string>();
const pairKey = (source: string, dest: string) => `${source}::${dest}`;

/**
 * List every registered (source, destination) pair.
 * Response: { pairs: [{ source, destination }, ...] }
 */
app.get("/api/v1/pairs", (_req: Request, res: Response) => {
  const pairs = Array.from(pairRegistry).map((k) => {
    const [source, destination] = k.split("::");
    return { source, destination };
  });
  res.json({ pairs });
});

/**
 * Register a pair (test-only / operator surface; will move behind an
 * admin auth guard once the gateway lands). Body: { source, destination }.
 * Returns 201 on first-write, 200 on idempotent re-write.
 */
app.post("/api/v1/pairs", (req: Request, res: Response) => {
  const { source, destination } = req.body ?? {};
  const requestId = (req as Request & { id?: string }).id;
  if (!isAssetCode(source) || !isAssetCode(destination)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "source and destination must be 1-12 character strings",
      requestId,
    });
  }
  if (source === destination) {
    return res.status(400).json({
      error: "invalid_request",
      message: "source and destination must differ",
      requestId,
    });
  }
  const key = pairKey(source, destination);
  const isNew = !pairRegistry.has(key);
  pairRegistry.add(key);
  res.status(isNew ? 201 : 200).json({ source, destination, registered: true });
});

// Asset symbols are short uppercase identifiers (USDC, EURC, XLM, …).
// Cap at 12 chars (Stellar's max alphanumeric asset code) and reject
// anything that is not a single string so an array param can't smuggle
// through as a "truthy" value.
const isAssetCode = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 12;

// Quote amount: a base-units integer string. Parsed via BigInt so we
// never lose precision on amounts above Number.MAX_SAFE_INTEGER.
const parseAmount = (v: unknown): bigint | null => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,38}$/.test(v)) return null;
  try {
    const n = BigInt(v);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
};

app.get("/api/v1/quote", (req: Request, res: Response) => {
  const { source_asset, dest_asset, amount } = req.query;
  const requestId = (req as Request & { id?: string }).id;

  if (!source_asset || !dest_asset || !amount) {
    return res.status(400).json({
      error: "invalid_request",
      message:
        "Missing required query params: source_asset, dest_asset, amount",
      requestId,
    });
  }
  if (!isAssetCode(source_asset) || !isAssetCode(dest_asset)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "source_asset and dest_asset must be 1-12 character strings",
      requestId,
    });
  }
  if (source_asset === dest_asset) {
    return res.status(400).json({
      error: "invalid_request",
      message: "source_asset and dest_asset must differ",
      requestId,
    });
  }
  const parsedAmount = parseAmount(amount);
  if (parsedAmount === null) {
    return res.status(400).json({
      error: "invalid_request",
      message:
        "amount must be a positive integer string with no leading zero",
      requestId,
    });
  }

  res.json({
    source_asset,
    dest_asset,
    amount: parsedAmount.toString(),
    estimated_rate: "1.0",
    route: [source_asset, dest_asset],
  });
});

// Unknown route: structured 404 echoing the request id.
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "not_found",
    message: `No route for ${req.method} ${req.path}`,
    requestId: (req as Request & { id?: string }).id,
  });
});

// Final 4-arg error handler. Any handler that throws or calls next(err)
// lands here; the response shape is the same canonical
// { error, message, requestId } as the explicit 400 / 404 bodies so
// clients can branch on `error` uniformly.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message =
    err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json({
    error: "internal_error",
    message,
    requestId: (req as Request & { id?: string }).id,
  });
});

export default app;
