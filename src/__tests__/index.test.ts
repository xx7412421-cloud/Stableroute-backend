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

  describe("/api/v1/pairs", () => {
    it("starts empty and registers a new pair with 201", async () => {
      const list1 = await request(app).get("/api/v1/pairs");
      expect(list1.status).toBe(200);
      const initialCount = list1.body.pairs.length;

      const reg = await request(app)
        .post("/api/v1/pairs")
        .send({ source: "PAIR_A", destination: "PAIR_B" });
      expect(reg.status).toBe(201);
      expect(reg.body).toEqual({
        source: "PAIR_A",
        destination: "PAIR_B",
        registered: true,
      });

      const list2 = await request(app).get("/api/v1/pairs");
      expect(list2.body.pairs.length).toBe(initialCount + 1);
      expect(list2.body.pairs).toContainEqual({
        source: "PAIR_A",
        destination: "PAIR_B",
      });
    });

    it("is idempotent: re-registering returns 200", async () => {
      await request(app)
        .post("/api/v1/pairs")
        .send({ source: "IDEM_A", destination: "IDEM_B" });
      const second = await request(app)
        .post("/api/v1/pairs")
        .send({ source: "IDEM_A", destination: "IDEM_B" });
      expect(second.status).toBe(200);
    });

    it("rejects source == destination with 400", async () => {
      const res = await request(app)
        .post("/api/v1/pairs")
        .send({ source: "USDC", destination: "USDC" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must differ/);
    });

    it("rejects too-long asset codes with 400", async () => {
      const res = await request(app)
        .post("/api/v1/pairs")
        .send({ source: "USDC", destination: "THIRTEENLETTERS" });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/1-12 character strings/);
    });
  });

  it("creates an api key and revokes it by prefix", async () => {
    const create = await request(app)
      .post("/api/v1/api-keys")
      .send({ label: "test" });
    expect(create.status).toBe(201);
    expect(create.body.key).toMatch(/^srk_/);
    const prefix = create.body.key.slice(0, 8);
    const list = await request(app).get("/api/v1/api-keys");
    expect(list.body.items.some((k: { prefix: string }) => k.prefix === prefix)).toBe(true);
    const del = await request(app).delete(`/api/v1/api-keys/${prefix}`);
    expect(del.status).toBe(204);
  });

  it("GET /api/v1/stats returns totalPairs and paused", async () => {
    const res = await request(app).get("/api/v1/stats");
    expect(res.status).toBe(200);
    expect(typeof res.body.totalPairs).toBe("number");
    expect(typeof res.body.paused).toBe("boolean");
  });

  it("GET /api/v1/metrics returns prometheus text", async () => {
    const res = await request(app).get("/api/v1/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/stableroute_pairs_total/);
    expect(res.text).toMatch(/stableroute_paused/);
  });

  it("admin/pause blocks writes and unpause restores", async () => {
    await request(app).post("/api/v1/admin/pause");
    const blocked = await request(app)
      .post("/api/v1/pairs")
      .send({ source: "PAU", destination: "SED" });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toBe("service_paused");
    await request(app).post("/api/v1/admin/unpause");
    const ok = await request(app)
      .post("/api/v1/pairs")
      .send({ source: "PAU", destination: "SED" });
    expect(ok.status === 200 || ok.status === 201).toBe(true);
  });

  describe("pair-meta endpoints", () => {
    it("registers a pair then patches its fee_bps", async () => {
      await request(app)
        .post("/api/v1/pairs")
        .send({ source: "USD", destination: "EUR" });
      const set = await request(app)
        .patch("/api/v1/pairs/USD/EUR/fee_bps")
        .send({ feeBps: 50 });
      expect(set.status).toBe(200);
      expect(set.body.feeBps).toBe(50);

      const info = await request(app).get("/api/v1/pairs/USD/EUR/info");
      expect(info.status).toBe(200);
      expect(info.body.feeBps).toBe(50);
    });
    it("rejects PATCH /fee_bps when pair is not registered", async () => {
      const res = await request(app)
        .patch("/api/v1/pairs/AAA/BBB/fee_bps")
        .send({ feeBps: 5 });
      expect(res.status).toBe(404);
    });
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
