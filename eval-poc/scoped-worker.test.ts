import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const handlers = vi.hoisted(() => ({
  normal: vi.fn(async (_request: Request) => new Response("normal")),
  eval: vi.fn(async (_request: Request) => new Response("eval")),
}));
vi.mock("../fresh-poc/worker", () => ({ default: { fetch: handlers.normal }, BoldBIContainer: class {}, PostgresContainer: class {} }));
vi.mock("./worker", () => ({ default: { fetch: handlers.eval }, BoldBIEvalContainer: class {} }));
import worker from "../deployment-worker";

describe("separate deployment scopes", () => {
  it("normal mode ignores a stale eval cookie and uses only the normal handler", async () => {
    handlers.normal.mockClear(); handlers.eval.mockClear();
    const response = await worker.fetch(new Request("https://poc.example/", { headers: { Cookie: "__Host-boldbi_eval=1" } }), { DEPLOYMENT_MODE: "normal" } as never);
    expect(await response.text()).toBe("normal");
    expect(handlers.eval).not.toHaveBeenCalled();
  });
  it("eval mode selects eval without depending on normal database credentials", async () => {
    handlers.normal.mockClear(); handlers.eval.mockClear();
    const response = await worker.fetch(new Request("https://poc.example/", { headers: { Cookie: "session=kept; __Host-boldbi_eval=0" } }), { DEPLOYMENT_MODE: "eval" } as never);
    expect(await response.text()).toBe("eval");
    expect(handlers.normal).not.toHaveBeenCalled();
    expect(handlers.eval.mock.calls[0][0].headers.get("Cookie")).toBe("session=kept; __Host-boldbi_eval=1");
  });
  it("eval mode never forwards the separate database tunnel or diagnostics", async () => {
    handlers.normal.mockClear(); handlers.eval.mockClear();
    const response = await worker.fetch(new Request("https://poc.example/_poc/postgres/tunnel"), { DEPLOYMENT_MODE: "eval" } as never);
    expect(response.status).toBe(404);
    expect(handlers.normal).not.toHaveBeenCalled();
    expect(handlers.eval).not.toHaveBeenCalled();
  });
  it("normal and eval configs publish exactly two and one images respectively", () => {
    const normal = JSON.parse(readFileSync("fresh-poc/wrangler.normal.jsonc", "utf8"));
    const evaluation = JSON.parse(readFileSync("eval-poc/wrangler.eval.jsonc", "utf8"));
    expect(normal.containers.map((value: { class_name: string }) => value.class_name)).toEqual(["BoldBIContainer", "PostgresContainer"]);
    expect(evaluation.containers.map((value: { class_name: string }) => value.class_name)).toEqual(["BoldBIEvalContainer"]);
    expect(normal.vars.DEPLOYMENT_MODE).toBe("normal");
    expect(evaluation.vars.DEPLOYMENT_MODE).toBe("eval");
    for (const config of [normal, evaluation]) {
      expect(config.name).toBe("ticket287457");
      expect(Object.keys(config.exports).sort()).toEqual(["BoldBIContainer", "BoldBIEvalContainer", "PostgresContainer"].sort());
      expect(Object.values(config.exports).every(value => !(value as { state?: string }).state)).toBe(true);
    }
  });
});
