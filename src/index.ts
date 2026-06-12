import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

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
