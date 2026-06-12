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
});
