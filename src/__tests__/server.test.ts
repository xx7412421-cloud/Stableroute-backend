import http from "node:http";
import app from "../index";

describe("Server startup", () => {
  let server: http.Server;
  let port: number;

  afterEach(() => {
    if (server) server.close();
  });

  it("starts and responds to health check", async () => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        port = addr.port;
      }
    });

    await new Promise<void>((resolve) => server.on("listening", resolve));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", service: "stableroute-backend" });
  });

  it("handles graceful shutdown on close", async () => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        port = addr.port;
      }
    });

    await new Promise<void>((resolve) => server.on("listening", resolve));

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });


});
