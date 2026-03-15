import express, { Request, Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "stableroute-backend" });
});

app.get("/api/v1/quote", (req: Request, res: Response) => {
  const { source_asset, dest_asset, amount } = req.query;
  if (!source_asset || !dest_asset || !amount) {
    return res.status(400).json({
      error: "Missing required query params: source_asset, dest_asset, amount",
    });
  }
  res.json({
    source_asset,
    dest_asset,
    amount: String(amount),
    estimated_rate: "1.0",
    route: [source_asset, dest_asset],
  });
});

export default app;
