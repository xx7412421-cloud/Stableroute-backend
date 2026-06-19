import { createHash, randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());

type RequestWithId = Request & { id?: string };
type ErrorResponseExtra = Record<string, unknown>;

/**
 * Read the request id attached by the correlation middleware.
 */
const getRequestId = (req: Request): string | undefined => (req as RequestWithId).id;

/**
 * Send the canonical API error body used by explicit handlers and middleware.
 */
const sendError = (
  res: Response,
  req: Request,
  status: number,
  error: string,
  message: string,
  extra: ErrorResponseExtra = {}
) => res.status(status).json({ error, message, ...extra, requestId: getRequestId(req) });

// Attach an X-Request-Id before body parsing so parser errors can still
// return the canonical error shape with a correlation id.
app.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = req.header("x-request-id");
  const id = incoming && incoming.length <= 200 ? incoming : randomUUID();
  (req as RequestWithId).id = id;
  res.setHeader("X-Request-Id", id);
  next();
});

app.use(express.json({ limit: "100kb" }));

// Pause guard: refuses non-idempotent methods with 503 except
// /admin/unpause, so an operator can always recover.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!paused) return next();
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (req.path === "/api/v1/admin/unpause") return next();
  sendError(res, req, 503, "service_paused", "StableRoute backend is paused");
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
    sendError(
      res,
      req,
      429,
      "rate_limited",
      `more than ${RATE_LIMIT_PER_WINDOW} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`
    );
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
          requestId: getRequestId(req),
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

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "stableroute-backend" });
});

app.get("/api/v1/openapi.json", (_req: Request, res: Response) => {
  res.json({
    openapi: "3.0.3",
    info: { title: "StableRoute Backend", version: "1.0.0" },
    paths: {
      "/health": { get: { summary: "Shallow health" } },
      "/api/v1/health/deep": { get: { summary: "Deep health" } },
      "/api/v1/metrics": { get: { summary: "Prometheus metrics" } },
      "/api/v1/stats": { get: { summary: "Aggregate snapshot" } },
      "/api/v1/events": { get: { summary: "Audit log" } },
      "/api/v1/pairs": { get: { summary: "List pairs" }, post: { summary: "Register pair" } },
      "/api/v1/pairs/{source}/{destination}": {
        get: { summary: "Read pair" },
        delete: { summary: "Unregister pair" },
      },
      "/api/v1/pairs/{source}/{destination}/info": { get: { summary: "Pair aggregate" } },
      "/api/v1/pairs/{source}/{destination}/fee_bps": { patch: { summary: "Set fee" } },
      "/api/v1/pairs/{source}/{destination}/min": { patch: { summary: "Set min amount" } },
      "/api/v1/pairs/{source}/{destination}/max": { patch: { summary: "Set max amount" } },
      "/api/v1/pairs/{source}/{destination}/liquidity": { patch: { summary: "Set liquidity" } },
      "/api/v1/quote": { get: { summary: "Get a route quote" } },
      "/api/v1/quote/bulk": { post: { summary: "Bulk quote" } },
      "/api/v1/api-keys": { get: {}, post: {} },
      "/api/v1/api-keys/{prefix}": { delete: {} },
      "/api/v1/webhooks": { get: {}, post: {} },
      "/api/v1/webhooks/{id}": { delete: {} },
      "/api/v1/admin/pause": { post: {} },
      "/api/v1/admin/unpause": { post: {} },
      "/api/v1/admin/status": { get: {} },
    },
  });
});

app.get("/api/v1/health/deep", (_req: Request, res: Response) => {
  const m = process.memoryUsage();
  res.json({
    status: paused ? "paused" : "ok",
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(m.rss / 1024 / 1024),
      heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
    },
    pid: process.pid,
    node: process.version,
  });
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
// Per-pair metadata mirroring DataKey::PairFeeBps / Min / Max / Liquidity.
type PairMeta = {
  feeBps: number;
  minAmount: string;
  maxAmount: string;
  liquidity: string;
};
const pairMeta = new Map<string, PairMeta>();
const defaultMeta = (): PairMeta => ({
  feeBps: 0,
  minAmount: "0",
  maxAmount: "0",
  liquidity: "0",
});

type AppEvent = { id: string; ts: number; type: string; payload: Record<string, unknown> };
const eventLog: AppEvent[] = [];
const EVENT_LOG_CAP = 10_000;
function recordEvent(type: string, payload: Record<string, unknown>) {
  eventLog.push({ id: randomUUID(), ts: Date.now(), type, payload });
  if (eventLog.length > EVENT_LOG_CAP) eventLog.shift();
}

app.get("/api/v1/events", (req: Request, res: Response) => {
  const since = Number(req.query.since ?? 0);
  const limit = Math.min(EVENT_LOG_CAP, Math.max(1, Number(req.query.limit ?? 100)));
  const items = eventLog.filter((e) => e.ts >= since).slice(-limit);
  res.json({ items });
});

type ApiKeyRecord = { label: string; createdAt: number };
const apiKeyStore = new Map<string, ApiKeyRecord>();

app.delete("/api/v1/api-keys/:prefix", (req: Request, res: Response) => {
  const { prefix } = req.params;
  let found: string | undefined;
  for (const k of apiKeyStore.keys()) if (k.slice(0, 8) === prefix) { found = k; break; }
  if (!found) {
    sendError(res, req, 404, "not_found", `no key with prefix ${prefix}`);
    return;
  }
  apiKeyStore.delete(found);
  res.status(204).send();
});

app.get("/api/v1/api-keys", (_req: Request, res: Response) => {
  const items = Array.from(apiKeyStore.entries()).map(([k, m]) => ({
    prefix: k.slice(0, 8),
    label: m.label,
    createdAt: m.createdAt,
  }));
  res.json({ items });
});

app.post("/api/v1/api-keys", (req: Request, res: Response) => {
  const { label } = req.body ?? {};
  if (typeof label !== "string" || label.length === 0 || label.length > 64) {
    sendError(res, req, 400, "invalid_request", "label must be 1-64 chars");
    return;
  }
  const key = `srk_${randomUUID().replace(/-/g, "")}`;
  apiKeyStore.set(key, { label, createdAt: Date.now() });
  res.status(201).json({ key, label });
});

type WebhookRecord = { url: string; events: string[]; createdAt: number };
const webhookStore = new Map<string, WebhookRecord>();

app.delete("/api/v1/webhooks/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  if (!webhookStore.has(id)) {
    sendError(res, req, 404, "not_found", `webhook ${id} not found`);
    return;
  }
  webhookStore.delete(id);
  res.status(204).send();
});

app.get("/api/v1/webhooks", (_req: Request, res: Response) => {
  const items = Array.from(webhookStore.entries()).map(([id, m]) => ({ id, ...m }));
  res.json({ items });
});

app.post("/api/v1/webhooks", (req: Request, res: Response) => {
  const { url, events } = req.body ?? {};
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2048) {
    sendError(res, req, 400, "invalid_request", "url must be http(s), <=2048 chars");
    return;
  }
  if (!Array.isArray(events) || events.length === 0 || events.some((e) => typeof e !== "string")) {
    sendError(res, req, 400, "invalid_request", "events must be a non-empty string array");
    return;
  }
  const id = `wh_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  webhookStore.set(id, { url, events, createdAt: Date.now() });
  res.status(201).json({ id, url, events });
});

/** Aggregate read of every per-pair slot in one round-trip. */
app.get("/api/v1/pairs/:source/:destination/info", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  const k = pairKey(source, destination);
  res.json({
    source,
    destination,
    registered: pairRegistry.has(k),
    ...(pairMeta.get(k) ?? defaultMeta()),
  });
});

app.patch("/api/v1/pairs/:source/:destination/liquidity", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  const k = pairKey(source, destination);
  if (!pairRegistry.has(k)) {
    sendError(res, req, 404, "not_found", "pair not registered");
    return;
  }
  const { liquidity } = req.body ?? {};
  if (typeof liquidity !== "string" || !/^[0-9]{1,39}$/.test(liquidity)) {
    sendError(res, req, 400, "invalid_request", "liquidity must be a non-negative integer string");
    return;
  }
  const meta = pairMeta.get(k) ?? defaultMeta();
  meta.liquidity = liquidity;
  pairMeta.set(k, meta);
  res.json({ source, destination, ...meta });
});

app.patch("/api/v1/pairs/:source/:destination/max", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  const k = pairKey(source, destination);
  if (!pairRegistry.has(k)) {
    sendError(res, req, 404, "not_found", "pair not registered");
    return;
  }
  const { maxAmount } = req.body ?? {};
  if (typeof maxAmount !== "string" || !/^[1-9][0-9]{0,38}$/.test(maxAmount)) {
    sendError(res, req, 400, "invalid_request", "maxAmount must be a positive integer string");
    return;
  }
  const meta = pairMeta.get(k) ?? defaultMeta();
  meta.maxAmount = maxAmount;
  pairMeta.set(k, meta);
  res.json({ source, destination, ...meta });
});

app.patch("/api/v1/pairs/:source/:destination/min", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  const k = pairKey(source, destination);
  if (!pairRegistry.has(k)) {
    sendError(res, req, 404, "not_found", "pair not registered");
    return;
  }
  const { minAmount } = req.body ?? {};
  if (typeof minAmount !== "string" || !/^[0-9]{1,39}$/.test(minAmount)) {
    sendError(res, req, 400, "invalid_request", "minAmount must be a non-negative integer string");
    return;
  }
  const meta = pairMeta.get(k) ?? defaultMeta();
  meta.minAmount = minAmount;
  pairMeta.set(k, meta);
  res.json({ source, destination, ...meta });
});

app.patch("/api/v1/pairs/:source/:destination/fee_bps", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  const k = pairKey(source, destination);
  if (!pairRegistry.has(k)) {
    sendError(res, req, 404, "not_found", "pair not registered");
    return;
  }
  const { feeBps } = req.body ?? {};
  if (typeof feeBps !== "number" || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
    sendError(res, req, 400, "invalid_request", "feeBps must be an integer in [0,1000]");
    return;
  }
  const meta = pairMeta.get(k) ?? defaultMeta();
  meta.feeBps = feeBps;
  pairMeta.set(k, meta);
  res.json({ source, destination, ...meta });
});

/** Unregister a pair. */
app.delete("/api/v1/pairs/:source/:destination", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  const k = pairKey(source, destination);
  if (!pairRegistry.has(k)) {
    sendError(res, req, 404, "not_found", `pair ${source}->${destination} is not registered`);
    return;
  }
  pairRegistry.delete(k);
  recordEvent("pair.unregistered", { source, destination });
  res.status(204).send();
});

/** Read a single registered pair. */
app.get("/api/v1/pairs/:source/:destination", (req: Request, res: Response) => {
  const { source, destination } = req.params;
  if (!pairRegistry.has(pairKey(source, destination))) {
    sendError(res, req, 404, "not_found", `pair ${source}->${destination} is not registered`);
    return;
  }
  res.json({ source, destination, registered: true });
});

app.get("/api/v1/admin/status", (_req: Request, res: Response) => {
  res.json({ paused });
});

const config: Record<string, number> = {
  rateLimitPerWindow: 60,
  rateLimitWindowMs: 60_000,
  bulkMaxItems: 100,
  eventLogCap: 10_000,
};
app.get("/api/v1/config", (_req: Request, res: Response) => res.json({ config }));
app.patch("/api/v1/config", (req: Request, res: Response) => {
  const allowed = ["rateLimitPerWindow", "rateLimitWindowMs", "bulkMaxItems"] as const;
  for (const k of allowed) {
    if (k in (req.body ?? {})) {
      const v = req.body[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        sendError(res, req, 400, "invalid_request", `${k} must be positive integer`);
        return;
      }
      config[k] = v;
    }
  }
  res.json({ config });
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
app.get("/api/v1/pairs", (req: Request, res: Response) => {
  const pairs = Array.from(pairRegistry).map((k) => {
    const [source, destination] = k.split("::");
    return { source, destination };
  });
  const body = JSON.stringify({ pairs });
  const etag = `W/"${createHash("sha1").update(body).digest("base64").slice(0, 16)}"`;
  if (req.header("if-none-match") === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("ETag", etag);
  res.type("application/json").send(body);
});

/**
 * Register a pair (test-only / operator surface; will move behind an
 * admin auth guard once the gateway lands). Body: { source, destination }.
 * Returns 201 on first-write, 200 on idempotent re-write.
 */
app.post("/api/v1/pairs", (req: Request, res: Response) => {
  const { source, destination } = req.body ?? {};
  if (!isAssetCode(source) || !isAssetCode(destination)) {
    return sendError(
      res,
      req,
      400,
      "invalid_request",
      "source and destination must be 1-12 character strings"
    );
  }
  if (source === destination) {
    return sendError(res, req, 400, "invalid_request", "source and destination must differ");
  }
  const key = pairKey(source, destination);
  const isNew = !pairRegistry.has(key);
  pairRegistry.add(key);
  recordEvent(isNew ? "pair.registered" : "pair.refreshed", { source, destination });
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

app.post("/api/v1/quote/bulk", (req: Request, res: Response) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    sendError(res, req, 400, "invalid_request", "items must be 1-100 entries");
    return;
  }
  const results = items.map((it: { source_asset?: unknown; dest_asset?: unknown; amount?: unknown }, i: number) => {
    const { source_asset, dest_asset, amount } = it ?? {};
    if (!isAssetCode(source_asset) || !isAssetCode(dest_asset) || parseAmount(amount) === null || source_asset === dest_asset) {
      return { index: i, ok: false, error: "invalid_item" };
    }
    return {
      index: i,
      ok: true,
      source_asset,
      dest_asset,
      amount: String(amount),
      estimated_rate: "1.0",
    };
  });
  res.json({ results });
});

app.get("/api/v1/quote", (req: Request, res: Response) => {
  const { source_asset, dest_asset, amount } = req.query;

  if (!source_asset || !dest_asset || !amount) {
    return sendError(
      res,
      req,
      400,
      "invalid_request",
      "Missing required query params: source_asset, dest_asset, amount"
    );
  }
  if (!isAssetCode(source_asset) || !isAssetCode(dest_asset)) {
    return sendError(
      res,
      req,
      400,
      "invalid_request",
      "source_asset and dest_asset must be 1-12 character strings"
    );
  }
  if (source_asset === dest_asset) {
    return sendError(res, req, 400, "invalid_request", "source_asset and dest_asset must differ");
  }
  const parsedAmount = parseAmount(amount);
  if (parsedAmount === null) {
    return sendError(
      res,
      req,
      400,
      "invalid_request",
      "amount must be a positive integer string with no leading zero"
    );
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
  sendError(res, req, 404, "not_found", `No route for ${req.method} ${req.path}`);
});

// Final 4-arg error handler. Any handler that throws or calls next(err)
// lands here; the response shape is the same canonical
// { error, message, requestId } as the explicit 400 / 404 bodies so
// clients can branch on `error` uniformly.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large") {
    sendError(res, req, 413, "payload_too_large", "request body exceeds the 100 KiB limit");
    return;
  }
  const message =
    err instanceof Error ? err.message : "Unexpected server error";
  sendError(res, req, 500, "internal_error", message, {
    method: req.method,
    path: req.path,
  });
});

export default app;
