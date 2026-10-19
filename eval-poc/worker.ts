import { Container } from "@cloudflare/containers";
import legacy from "../fresh-poc/worker";
export { BoldBIContainer, PostgresContainer } from "../fresh-poc/worker";

type EvalEnv = Parameters<typeof legacy.fetch>[1] & {
  BOLDBI_EVAL_CONTAINER: DurableObjectNamespace<BoldBIEvalContainer>;
  EVAL_DB_PASSWORD: string;
  EVAL_ADMIN_PASSWORD: string;
  EVAL_ADMIN_EMAIL?: string;
};
const selector = "__Host-boldbi_eval";

export class BoldBIEvalContainer extends Container<EvalEnv> {
  defaultPort = 80;
  // The SDK default, http://ping/, enters BoldBI's hostname-dependent login
  // redirects. This endpoint returns HTTP 200 without entering that flow.
  pingEndpoint = "localhost/health-check";
  sleepAfter = "6h";
  enableInternet = true;
  envVars = {
    BOLD_SERVICES_DB_TYPE: "postgresql",
    BOLD_SERVICES_DB_HOST: "localhost",
    BOLD_SERVICES_POSTGRESQL_MAINTENANCE_DB: "postgres",
    BOLD_SERVICES_DB_USER: "postgres",
    BOLD_SERVICES_DB_PASSWORD: this.env.EVAL_DB_PASSWORD,
    BOLD_SERVICES_USER_EMAIL: this.env.EVAL_ADMIN_EMAIL || "testuser@boldbi.com",
    BOLD_SERVICES_USER_PASSWORD: this.env.EVAL_ADMIN_PASSWORD,
    BOLD_SERVICES_REVERSE_PROXY: "true",
    BOLD_SERVICES_CONSOLE_LOG_ENABLED: "true",
  };

  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts({
      // The SDK probes readiness with HTTP, not a raw TCP connection.
      // PostgreSQL's binary protocol on 5432 cannot answer that probe.
      ports: [80],
      cancellationOptions: { instanceGetTimeoutMS: 120000, portReadyTimeoutMS: 300000 },
    });
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: EvalEnv): Promise<Response> {
    const url = new URL(request.url);
    // Existing database tunnels, diagnostics and reset routes always retain
    // their original handler and authentication, even in an eval browser.
    if (url.pathname.startsWith("/_poc/")) return legacy.fetch(request, env);
    if (url.pathname === "/_eval/start" || url.pathname === "/_eval/leave") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (url.protocol !== "https:") return new Response("Use HTTPS.", { status: 400 });
      const enter = url.pathname === "/_eval/start";
      return new Response(null, { status: 303, headers: {
        Location: "/", "Cache-Control": "no-store",
        "Set-Cookie": `${selector}=${enter ? "1" : ""}; Path=/; Secure; HttpOnly; SameSite=Lax${enter ? "" : "; Max-Age=0"}`,
      } });
    }
    if (url.pathname.startsWith("/_eval/")) return new Response("Not found", { status: 404 });
    const evalSelected = (request.headers.get("Cookie") || "").split(";").some(value => value.trim() === `${selector}=1`);
    if (!evalSelected) return legacy.fetch(request, env);
    if (!env.EVAL_DB_PASSWORD || !env.EVAL_ADMIN_PASSWORD) return new Response("Configure the eval secrets first.", { status: 503 });
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
    headers.set("X-Forwarded-Host", url.host);
    // The application does not need to receive our deployment-selector cookie.
    headers.set("Cookie", (headers.get("Cookie") || "").split(";").filter(value => !value.trim().startsWith(`${selector}=`)).join(";"));
    const response = await env.BOLDBI_EVAL_CONTAINER.getByName("boldbi-eval").fetch(new Request(request, { headers }));
    if (response.status === 101) return response;
    const secured = new Response(response.body, response);
    // Cookies select the backend, so shared caches must not mix applications.
    secured.headers.set("Cache-Control", "private, no-store");
    if (url.protocol === "https:") {
      if (/\btext\/html\b/i.test(secured.headers.get("Content-Type") || "")) {
        secured.headers.append("Content-Security-Policy", "upgrade-insecure-requests");
      }
      const location = secured.headers.get("Location");
      if (location) {
        const target = new URL(location, url);
        if (target.host === url.host && target.protocol === "http:") {
          target.protocol = "https:";
          secured.headers.set("Location", target.href);
        }
      }
    }
    return secured;
  },
};
