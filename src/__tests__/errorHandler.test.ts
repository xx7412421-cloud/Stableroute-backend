import request from "supertest";
import app from "../index";

const jsonLimitBytes = 100 * 1024;

const makePayloadBody = (targetBytes: number) => {
  const emptyBody = JSON.stringify({ payload: "" });
  const payloadLength = targetBytes - Buffer.byteLength(emptyBody);

  if (payloadLength < 0) {
    throw new Error("target body size is too small");
  }

  return JSON.stringify({ payload: "x".repeat(payloadLength) });
};

const expectNoInternalDetails = (body: Record<string, unknown>) => {
  expect(body).not.toHaveProperty("stack");
  expect(body).not.toHaveProperty("type");
  expect(body).not.toHaveProperty("status");
  expect(body).not.toHaveProperty("statusCode");
};

describe("error handler", () => {
  it("returns the canonical 413 response with requestId for bodies over 100 KiB", async () => {
    const requestId = "payload-too-large-test";

    const res = await request(app)
      .post("/api/v1/pairs")
      .set("Content-Type", "application/json")
      .set("X-Request-Id", requestId)
      .send(makePayloadBody(jsonLimitBytes + 1));

    expect(res.status).toBe(413);
    expect(res.headers["x-request-id"]).toBe(requestId);
    expect(res.body).toMatchObject({
      error: "payload_too_large",
      message: "request body exceeds the 100 KiB limit",
      requestId,
    });
    expectNoInternalDetails(res.body);
  });

  it("accepts a JSON body exactly at the 100 KiB limit and reaches route validation", async () => {
    const requestId = "payload-at-limit-test";

    const res = await request(app)
      .post("/api/v1/pairs")
      .set("Content-Type", "application/json")
      .set("X-Request-Id", requestId)
      .send(makePayloadBody(jsonLimitBytes));

    expect(res.status).toBe(400);
    expect(res.headers["x-request-id"]).toBe(requestId);
    expect(res.body).toMatchObject({
      error: "invalid_request",
      message: "source and destination must be 1-12 character strings",
      requestId,
    });
    expectNoInternalDetails(res.body);
  });

  it("returns the canonical 500 response with method and path for generic parser failures", async () => {
    const requestId = "generic-error-test";

    const res = await request(app)
      .post("/api/v1/pairs")
      .set("Content-Type", "application/json")
      .set("X-Request-Id", requestId)
      .send("{");

    expect(res.status).toBe(500);
    expect(res.headers["x-request-id"]).toBe(requestId);
    expect(res.body).toMatchObject({
      error: "internal_error",
      method: "POST",
      path: "/api/v1/pairs",
      requestId,
    });
    expect(res.body.message).toBeTruthy();
    expectNoInternalDetails(res.body);
  });
});
