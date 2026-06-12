import request from "supertest";
import app from "../index";

describe("StableRoute Backend", () => {
  it("GET /health returns 200 and status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "stableroute-backend" });
  });

  it("GET /api/v1/quote with params returns quote", async () => {
    const res = await request(app)
      .get("/api/v1/quote")
      .query({ source_asset: "USDC", dest_asset: "EURC", amount: "100" });
    expect(res.status).toBe(200);
    expect(res.body.source_asset).toBe("USDC");
    expect(res.body.dest_asset).toBe("EURC");
    expect(res.body.route).toEqual(["USDC", "EURC"]);
  });

  it("GET /api/v1/quote without params returns 400 with canonical error shape", async () => {
    const res = await request(app).get("/api/v1/quote");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.message).toMatch(/Missing required query params/);
    expect(res.body.requestId).toBeTruthy();
  });

  it("attaches a fresh X-Request-Id when caller omits it", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("echoes the caller-provided X-Request-Id when present", async () => {
    const caller = "stableroute-trace-xyz-1";
    const res = await request(app)
      .get("/health")
      .set("X-Request-Id", caller);
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe(caller);
  });

  it("returns a structured 404 with requestId for unknown routes", async () => {
    const res = await request(app).get("/api/v1/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(res.body.message).toContain("/api/v1/this-route-does-not-exist");
    expect(res.body.requestId).toBeTruthy();
  });

  describe("GET /api/v1/quote validation", () => {
    it("rejects source_asset == dest_asset", async () => {
      const res = await request(app)
        .get("/api/v1/quote")
        .query({ source_asset: "USDC", dest_asset: "USDC", amount: "100" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must differ/);
    });

    it("rejects asset codes longer than 12 chars", async () => {
      const res = await request(app)
        .get("/api/v1/quote")
        .query({
          source_asset: "USDC",
          dest_asset: "THIRTEENLETTERS",
          amount: "100",
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/1-12 character strings/);
    });

    it("rejects array-form asset params (param pollution)", async () => {
      // Express parses ?source_asset=USDC&source_asset=EURC into an array.
      const res = await request(app)
        .get("/api/v1/quote")
        .query("source_asset=USDC&source_asset=EURC&dest_asset=XLM&amount=10");
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/1-12 character strings/);
    });

    it.each([
      ["zero", "0"],
      ["negative", "-5"],
      ["leading zero", "0100"],
      ["non-numeric", "abc"],
      ["decimal", "1.5"],
      ["empty", ""],
    ])("rejects amount that is %s", async (_label, amount) => {
      const res = await request(app)
        .get("/api/v1/quote")
        .query({ source_asset: "USDC", dest_asset: "EURC", amount });
      expect(res.status).toBe(400);
    });

    it("accepts a very large positive amount via BigInt parsing", async () => {
      // 10^25 — far above Number.MAX_SAFE_INTEGER (~9.007 * 10^15)
      const huge = "10000000000000000000000000";
      const res = await request(app)
        .get("/api/v1/quote")
        .query({ source_asset: "USDC", dest_asset: "EURC", amount: huge });
      expect(res.status).toBe(200);
      expect(res.body.amount).toBe(huge);
    });
  });
});
