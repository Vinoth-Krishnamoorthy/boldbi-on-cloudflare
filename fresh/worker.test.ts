import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
} }));
import worker, { BoldBIContainer } from "./worker";

function setup() {
  const postgresFetch = vi.fn(async () => new Response("postgres-proxy"));
  const boldbiFetch = vi.fn(async () => new Response("boldbi"));
  const destroyBoldBI = vi.fn(async () => {});
  const env = {
    BOLDBI_RESET_TOKEN: undefined as string | undefined,
    TUNNEL_TOKEN: "test-token-with-more-than-thirty-two-characters",
    POSTGRES_PASSWORD: "test-only-password",
    POSTGRES_CONTAINER: { getByName: vi.fn(() => ({ fetch: postgresFetch })) },
    BOLDBI_CONTAINER: { getByName: vi.fn(() => ({ fetch: boldbiFetch, destroy: destroyBoldBI })) },
  };
  // These tests exercise routing/authentication without starting container VMs.
  const fetch = (path: string, init?: RequestInit) =>
    worker.fetch(new Request("https://app.example" + path, init), env as never);
  return { env, fetch, postgresFetch, boldbiFetch, destroyBoldBI };
}

describe("fresh routing security", () => {
  it("fails closed before secrets have been configured", async () => {
    const { env, fetch } = setup();
    env.TUNNEL_TOKEN = "";
    expect((await fetch("/")).status).toBe(503);
    expect(env.BOLDBI_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  it("does not start a database for unauthorized calls", async () => {
    const { env, fetch } = setup();
    expect((await fetch("/_internal/postgres/tunnel")).status).toBe(401);
    expect((await fetch("/_internal/postgres/health", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect(env.POSTGRES_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  it("forwards an authorized tunnel request with its authentication header", async () => {
    const { env, fetch, postgresFetch } = setup();
    const authorization = "Bearer " + env.TUNNEL_TOKEN;
    await fetch("/_internal/postgres/tunnel", { headers: { Authorization: authorization, Upgrade: "websocket" } });
    expect(env.POSTGRES_CONTAINER.getByName).toHaveBeenCalledWith("postgres-fresh");
    expect(postgresFetch.mock.calls[0][0].headers.get("Authorization")).toBe(authorization);
  });

  it("restricts private endpoints and methods", async () => {
    const { env, fetch } = setup();
    const headers = { Authorization: "Bearer " + env.TUNNEL_TOKEN };
    expect((await fetch("/_internal/delete", { headers })).status).toBe(404);
    expect((await fetch("/_internal/postgres/health", { headers, method: "POST" })).status).toBe(405);
    expect(env.POSTGRES_CONTAINER.getByName).not.toHaveBeenCalled();
  });

  it("uses a single stable BoldBI identity for application routes", async () => {
    const { env, fetch } = setup();
    await fetch("/");
    await fetch("/bi");
    expect(env.BOLDBI_CONTAINER.getByName.mock.calls).toEqual([["boldbi-fresh"], ["boldbi-fresh"]]);
  });
});

describe("HTTPS dashboard resources behind the Worker", () => {
  it("upgrades insecure HTML subresources while retaining the original CSP and HTML", async () => {
    const { fetch, boldbiFetch } = setup();
    const html = '<script src="http://app.example/bi/designer/scripts/designerlocalization.js"></script>';
    boldbiFetch.mockResolvedValueOnce(new Response(html, { headers: {
      "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'",
    } }));
    const response = await fetch("/bi/site/site1/dashboards/example", { headers: {
      "X-Forwarded-Proto": "http", "X-Forwarded-Host": "untrusted.example",
    } });
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");
    expect(await response.text()).toBe(html);
    const request = boldbiFetch.mock.calls[0][0];
    expect(request.headers.get("X-Forwarded-Proto")).toBe("https");
    expect(request.headers.get("X-Forwarded-Host")).toBe("app.example");
  });

  it("keeps same-host application redirects on HTTPS", async () => {
    const { fetch, boldbiFetch } = setup();
    boldbiFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: {
      Location: "http://app.example/ums/startup?returnUrl=%2Fbi",
    } }));
    const response = await fetch("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://app.example/ums/startup?returnUrl=%2Fbi");
  });

  it("preserves static resource streams and redirects to other hosts", async () => {
    const { fetch, boldbiFetch } = setup();
    const script = new Response("compressed-placeholder", { headers: { "Content-Type": "text/javascript", "Content-Encoding": "gzip" } });
    const external = new Response(null, { status: 302, headers: { Location: "http://other.example/login" } });
    boldbiFetch.mockResolvedValueOnce(script).mockResolvedValueOnce(external);
    expect(await fetch("/bi/cdn/scripts/example.js")).toBe(script);
    expect(await fetch("/external-login")).toBe(external);
  });

  it("preserves application WebSocket upgrades", async () => {
    const { fetch, boldbiFetch } = setup();
    const upgraded = { status: 101, webSocket: {} } as Response;
    boldbiFetch.mockResolvedValueOnce(upgraded);
    expect(await fetch("/bi/designer/helper", { headers: { Upgrade: "websocket" } })).toBe(upgraded);
  });

  it("allows plain HTTP local development without forcing HTTPS subresources", async () => {
    const { env, boldbiFetch } = setup();
    const page = new Response("<html>local development</html>", { headers: { "Content-Type": "text/html" } });
    boldbiFetch.mockResolvedValueOnce(page);
    expect(await worker.fetch(new Request("http://localhost:8787/"), env as never)).toBe(page);
    expect(boldbiFetch.mock.calls[0][0].headers.get("X-Forwarded-Proto")).toBe("http");
  });
});

describe("explicit BoldBI disk reset", () => {
  const target = "boldbi-fresh";
  const resetToken = "independent-reset-credential-at-least-32-characters";

  it("cannot be authorized using the tunnel or diagnostic credential", async () => {
    const { env, fetch, destroyBoldBI } = setup();
    expect((await fetch("/_internal/boldbi/reset", { method: "POST" })).status).toBe(401);
    env.BOLDBI_RESET_TOKEN = resetToken;
    
    for (const token of [env.TUNNEL_TOKEN]) {
      expect((await fetch("/_internal/boldbi/reset", { method: "POST", headers: {
        Authorization: "Bearer " + token, "X-Reset-Target": target,
      } })).status).toBe(401);
    }
    expect(destroyBoldBI).not.toHaveBeenCalled();
  });

  it("requires both POST and the fixed BoldBI target", async () => {
    const { env, fetch, destroyBoldBI } = setup();
    env.BOLDBI_RESET_TOKEN = resetToken;
    const headers = { Authorization: "Bearer " + resetToken };
    expect((await fetch("/_internal/boldbi/reset", { headers })).status).toBe(405);
    expect((await fetch("/_internal/boldbi/reset", { method: "POST", headers })).status).toBe(400);
    expect((await fetch("/_internal/boldbi/reset", { method: "POST", headers: { ...headers, "X-Reset-Target": "postgres-fresh" } })).status).toBe(400);
    expect(destroyBoldBI).not.toHaveBeenCalled();
  });

  it("destroys only the existing BoldBI instance and leaves PostgreSQL untouched", async () => {
    const { env, fetch, destroyBoldBI, boldbiFetch } = setup();
    env.BOLDBI_RESET_TOKEN = resetToken;
    const response = await fetch("/_internal/boldbi/reset", { method: "POST", headers: {
      Authorization: "Bearer " + resetToken, "X-Reset-Target": target,
    } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, postgresReset: false, restartOnNextRequest: true });
    expect(destroyBoldBI).toHaveBeenCalledOnce();
    expect(env.BOLDBI_CONTAINER.getByName).toHaveBeenCalledWith("boldbi-fresh");
    expect(env.POSTGRES_CONTAINER.getByName).not.toHaveBeenCalled();
    expect(boldbiFetch).not.toHaveBeenCalled();
  });

  it("does not report success when destruction cannot be confirmed", async () => {
    const { env, fetch, destroyBoldBI } = setup();
    env.BOLDBI_RESET_TOKEN = resetToken;
    destroyBoldBI.mockRejectedValueOnce(new Error("runtime error"));
    const response = await fetch("/_internal/boldbi/reset", { method: "POST", headers: {
      Authorization: "Bearer " + resetToken, "X-Reset-Target": target,
    } });
    expect(response.status).toBe(502);
    expect(env.POSTGRES_CONTAINER.getByName).not.toHaveBeenCalled();
  });
});

describe("PostgreSQL startup readiness", () => {
  it("waits through startup 503 responses and preserves the WebSocket upgrade", async () => {
    vi.useFakeTimers();
    try {
      const { env, fetch, postgresFetch } = setup();
      // Node's Response cannot represent Cloudflare's WebSocket response.
      const upgraded = { status: 101, webSocket: {} } as Response;
      const first = new Response("PostgreSQL is not listening yet", { status: 503 });
      const second = new Response("PostgreSQL is not listening yet", { status: 503 });
      postgresFetch.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(upgraded);
      const pending = fetch("/_internal/postgres/tunnel", { headers: {
        Authorization: "Bearer " + env.TUNNEL_TOKEN, Upgrade: "websocket",
      } });
      await vi.runAllTimersAsync();
      expect(await pending).toBe(upgraded);
      expect(first.body?.locked).toBe(false);
      expect(first.bodyUsed).toBe(true);
      expect(second.bodyUsed).toBe(true);
      expect(postgresFetch).toHaveBeenCalledTimes(3);
      expect(env.POSTGRES_CONTAINER.getByName).toHaveBeenCalledOnce();
      for (const [request] of postgresFetch.mock.calls) {
        expect(request.headers.get("Upgrade")).toBe("websocket");
        expect(request.headers.get("Authorization")).toBe("Bearer " + env.TUNNEL_TOKEN);
      }
    } finally { vi.useRealTimers(); }
  });

  it("does not retry authentication failures from the database proxy", async () => {
    const { env, fetch, postgresFetch } = setup();
    const denied = new Response("Unauthorized", { status: 401 });
    postgresFetch.mockResolvedValueOnce(denied);
    expect(await fetch("/_internal/postgres/tunnel", { headers: { Authorization: "Bearer " + env.TUNNEL_TOKEN } })).toBe(denied);
    expect(postgresFetch).toHaveBeenCalledOnce();
  });

  it("returns the final 503 after bounded retries instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    try {
      const { env, fetch, postgresFetch } = setup();
      postgresFetch.mockImplementation(async () => new Response("Still starting", { status: 503 }));
      const pending = fetch("/_internal/postgres/health", { headers: { Authorization: "Bearer " + env.TUNNEL_TOKEN } });
      await vi.runAllTimersAsync();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Still starting");
      expect(postgresFetch).toHaveBeenCalledTimes(8);
    } finally { vi.useRealTimers(); }
  });
});

