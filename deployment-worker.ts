import normal from "./fresh-poc/worker";
import evaluation from "./eval-poc/worker";

// Keep previously provisioned namespaces declared in either deployment mode.
// Image publication is controlled separately by each config's containers list.
export { BoldBIContainer, PostgresContainer } from "./fresh-poc/worker";
export { BoldBIEvalContainer } from "./eval-poc/worker";

type ScopedEnv = Parameters<typeof evaluation.fetch>[1] & {
  DEPLOYMENT_MODE: "normal" | "eval";
};

export default {
  async fetch(request: Request, env: ScopedEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (env.DEPLOYMENT_MODE === "normal") {
      if (path.startsWith("/_eval/")) return new Response("Not found", { status: 404 });
      return normal.fetch(request, env);
    }
    if (env.DEPLOYMENT_MODE !== "eval") return new Response("Deployment mode is not configured.", { status: 503 });
    // An eval-only request must never wake the separate PostgreSQL container.
    if (path.startsWith("/_poc/") || path === "/_eval/leave") return new Response("Not found", { status: 404 });
    const headers = new Headers(request.headers);
    const cookies = (headers.get("Cookie") || "").split(";")
      .map(value => value.trim()).filter(value => value && !value.startsWith("__Host-boldbi_eval="));
    cookies.push("__Host-boldbi_eval=1");
    headers.set("Cookie", cookies.join("; "));
    // Reuse the eval handler's forwarded HTTPS headers, streamed responses,
    // CSP and redirect handling; select eval for every browser/API request.
    return evaluation.fetch(new Request(request, { headers }), env);
  },
};
