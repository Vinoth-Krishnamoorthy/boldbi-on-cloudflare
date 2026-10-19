import { describe, it, expect, vi } from "vitest";
const readiness = vi.hoisted(() => vi.fn(async function(this: { pingEndpoint?: string }, options: { ports: number[] }) {
  if (options.ports.some(port => port !== 80)) throw new Error("HTTP readiness cannot probe the PostgreSQL binary protocol.");
  if (this.pingEndpoint !== "localhost/health-check") throw new Error("The default ping hostname enters BoldBI's login redirects.");
}));
vi.mock("@cloudflare/containers", () => ({ Container: class {
  env: Record<string, string>;
  constructor(_ctx: unknown, env: Record<string, string>) { this.env = env; }
  startAndWaitForPorts = readiness;
  async fetch(_request: Request) { return new Response("container-origin"); }
} }));
const original = vi.hoisted(() => vi.fn(async () => new Response("original")));
vi.mock("../fresh-poc/worker", () => ({ default: { fetch: original }, BoldBIContainer: class {}, PostgresContainer: class {} }));
import worker, { BoldBIEvalContainer } from "./worker";

function setup() {
  original.mockClear();
  const evalFetch = vi.fn(async (_request: Request) => new Response("eval", { headers: { "Content-Type": "text/html" } }));
  const getByName = vi.fn(() => ({ fetch: evalFetch }));
  const env = { BOLDBI_EVAL_CONTAINER: { getByName }, EVAL_DB_PASSWORD: "test-db", EVAL_ADMIN_PASSWORD: "test-admin" };
  const fetch = (path: string, cookie = "", method = "GET") => worker.fetch(new Request(`https://poc.example${path}`, { method, headers: { Cookie: cookie } }), env as never);
  return { fetch, evalFetch, getByName, env };
}
describe("same Worker eval routing", () => {
  it("checks HTTP readiness without sending HTTP probes to PostgreSQL", async () => {
    readiness.mockClear();
    const container = new BoldBIEvalContainer({} as never, {
      EVAL_DB_PASSWORD: "test-db", EVAL_ADMIN_PASSWORD: "test-admin",
    } as never);
    const response = await container.fetch(new Request("https://poc.example/"));
    expect(await response.text()).toBe("container-origin");
    expect(readiness).toHaveBeenCalledOnce();
    expect(readiness.mock.calls[0][0].ports).toEqual([80]);
    expect(container.pingEndpoint).toBe("localhost/health-check");
  });
  it("keeps ordinary requests on the original application", async () => {
    const { fetch, evalFetch } = setup();
    expect(await (await fetch("/bi/")).text()).toBe("original");
    expect(evalFetch).not.toHaveBeenCalled();
  });
  it("selects eval without starting it on the selector redirect", async () => {
    const { fetch, evalFetch } = setup();
    const response = await fetch("/_eval/start");
    expect(response.status).toBe(303);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-boldbi_eval=1; Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(evalFetch).not.toHaveBeenCalled();
  });
  it("routes absolute application paths to eval and preserves HTTPS", async () => {
    const { fetch, evalFetch, getByName } = setup();
    const response = await fetch("/ums/theme/styles/application?theme=light", "other=ok; __Host-boldbi_eval=1");
    expect(getByName).toHaveBeenCalledWith("boldbi-eval");
    const request = evalFetch.mock.calls[0][0];
    expect(request.headers.get("X-Forwarded-Proto")).toBe("https");
    expect(request.headers.get("Cookie")).toBe("other=ok");
    expect(response.headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(original).not.toHaveBeenCalled();
  });
  it("always delegates the existing tunnel and diagnostics even with an eval cookie", async () => {
    const { fetch, evalFetch } = setup();
    await fetch("/_poc/postgres/tunnel", "__Host-boldbi_eval=1");
    expect(original).toHaveBeenCalled();
    expect(evalFetch).not.toHaveBeenCalled();
  });
  it("clears the selector when leaving eval", async () => {
    const { fetch } = setup();
    expect((await fetch("/_eval/leave")).headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
  it("requires an exact cookie and configured eval secrets", async () => {
    const { fetch, env, evalFetch } = setup();
    await fetch("/", "fake__Host-boldbi_eval=1");
    expect(evalFetch).not.toHaveBeenCalled();
    env.EVAL_DB_PASSWORD = "";
    expect((await fetch("/", "__Host-boldbi_eval=1")).status).toBe(503);
  });
});
