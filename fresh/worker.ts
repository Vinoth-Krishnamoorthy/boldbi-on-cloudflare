import { Container } from "@cloudflare/containers";
import diagnosticSource from "./Read-BoldBIDiagnostics.py";

const diagnosticPath = "/_poc/boldbi/diagnostics";
const diagnosticVersion = "2026-10-19-v2";
interface DiagnosticResult { status: number; body: string; }
interface FreshEnv {
  BOLDBI_CONTAINER: DurableObjectNamespace<BoldBIContainer>;
  POSTGRES_CONTAINER: DurableObjectNamespace<PostgresContainer>;
  POC_TUNNEL_TOKEN: string;
  POSTGRES_PASSWORD: string;
  POC_DIAGNOSTIC_TOKEN?: string;
  POC_BOLDBI_RESET_TOKEN?: string;
}

async function fetchPostgresAfterStartup(
  postgres: Pick<DurableObjectStub<PostgresContainer>, "fetch">,
  request: Request,
): Promise<Response> {
  // The HTTP proxy can listen on 8081 before initdb makes PostgreSQL ready.
  // Retry only a rejected handshake/health GET, never an established SQL stream.
  const delays = [500, 1000, 2000, 4000, 4000, 4000, 4000];
  for (let attempt = 0; ; attempt++) {
    const response = await postgres.fetch(request.clone());
    if (response.status !== 503 || attempt === delays.length) return response;
    await response.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, delays[attempt]));
  }
}

function secureApplicationResponse(response: Response, publicUrl: URL): Response {
  if (publicUrl.protocol !== "https:" || response.status === 101) return response;
  const html = /\btext\/html\b/i.test(response.headers.get("Content-Type") ?? "");
  let upgradedLocation: string | undefined;
  const location = response.headers.get("Location");
  if (location) {
    try {
      const target = new URL(location, publicUrl);
      if (target.protocol === "http:" && target.host === publicUrl.host) {
        target.protocol = "https:";
        upgradedLocation = target.href;
      }
    } catch { /* Preserve application-specific Location values we cannot parse. */ }
  }
  if (!html && !upgradedLocation) return response;
  // Keep the response streamed. Do not rewrite compressed JS/CSS response bodies.
  const secured = new Response(response.body, response);
  if (html && !secured.headers.get("Content-Security-Policy")?.includes("upgrade-insecure-requests")) {
    // Legacy application URLs can still contain http after edge TLS termination.
    // Add an enforcing policy while retaining any existing application policy.
    secured.headers.append("Content-Security-Policy", "upgrade-insecure-requests");
  }
  if (upgradedLocation) secured.headers.set("Location", upgradedLocation);
  return secured;
}

export class BoldBIContainer extends Container<FreshEnv> {
  defaultPort = 80;
  sleepAfter = "6h";
  enableInternet = true;

  // This RPC method is reached only through the authenticated Worker route.
  // The executable and source are fixed; caller input is never executed.
  async readConnectionDiagnostics(workerOrigin: string): Promise<DiagnosticResult> {
    const workerHost = new URL(workerOrigin).hostname;
    const container = this.ctx.container;
    if (!container?.running) return { status: 503, body: JSON.stringify({ error: "Open BoldBI first; the diagnostic does not start a stopped container." }) };
    // Warm PostgreSQL and report its readiness separately from BoldBI's proxy.
    // This check uses the Worker's current token; it does not change secrets.
    let workerPostgresHealth: { httpStatus: number | null; ready: boolean; error?: string };
    try {
      const response = await fetchPostgresAfterStartup(this.env.POSTGRES_CONTAINER.getByName("postgres-fresh"), new Request(
        new URL("/_poc/postgres/health", workerOrigin).href,
        { headers: { Authorization: `Bearer ${this.env.POC_TUNNEL_TOKEN}` } },
      ));
      workerPostgresHealth = { httpStatus: response.status, ready: response.status === 200 };
      await response.body?.cancel();
    } catch {
      workerPostgresHealth = { httpStatus: null, ready: false, error: "Worker could not reach the PostgreSQL proxy." };
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.env.POC_TUNNEL_TOKEN));
    const expectedTokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const controller = new AbortController();
    let completed = false;
    const timeout = setTimeout(() => { if (!completed) controller.abort(); }, 45000);
    const safeError = (message: string) => {
      for (const secret of [this.env.POC_TUNNEL_TOKEN, this.env.POSTGRES_PASSWORD, this.env.POC_DIAGNOSTIC_TOKEN]) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
      return message.slice(0, 2000);
    };
    try {
      const process = await container.exec(["python3", "-c", diagnosticSource], {
        signal: controller.signal, env: { POC_EXPECTED_TOKEN_SHA256: expectedTokenHash, POC_EXPECTED_HOST: workerHost },
      });
      const markCompleted = () => { completed = true; clearTimeout(timeout); };
      void process.exitCode.then(markCompleted, markCompleted);
      const output = await process.output();
      if (output.exitCode !== 0) return { status: 502, body: JSON.stringify({
        error: "The fixed diagnostic command failed.", exitCode: output.exitCode,
        detail: safeError(new TextDecoder().decode(output.stderr)),
      }) };
      // Parse first to reject malformed diagnostic output. Preserve complete JSON.
      let raw = new TextDecoder().decode(output.stdout);
      for (const secret of [this.env.POC_TUNNEL_TOKEN, this.env.POSTGRES_PASSWORD, this.env.POC_DIAGNOSTIC_TOKEN]) {
        if (secret) raw = raw.replaceAll(secret, "[redacted]");
      }
      const body = { ...JSON.parse(raw), diagnosticVersion, workerPostgresHealth };
      return { status: 200, body: JSON.stringify(body) };
    } catch (error) {
      return { status: 502, body: JSON.stringify({
        error: "Container diagnostic execution failed.",
        kind: error instanceof Error ? error.name : "UnknownError",
        detail: safeError(error instanceof Error ? error.message : String(error)),
      }) };
    } finally { completed = true; clearTimeout(timeout); }
  }

  override async fetch(request: Request): Promise<Response> {
    // The caller's valid Worker hostname supplies the public TLS tunnel URL.
    const tunnel = new URL("/_poc/postgres/tunnel", request.url);
    tunnel.protocol = "https:";
    await this.start({ envVars: {
      POC_TUNNEL_URL: tunnel.href,
      POC_TUNNEL_TOKEN: this.env.POC_TUNNEL_TOKEN,
    } });
    return super.fetch(request);
  }
}

export class PostgresContainer extends Container<FreshEnv> {
  defaultPort = 8081;
  sleepAfter = "6h";
  enableInternet = false;
  envVars = {
    POSTGRES_USER: "postgres", POSTGRES_DB: "postgres",
    POSTGRES_PASSWORD: this.env.POSTGRES_PASSWORD,
    POC_TUNNEL_TOKEN: this.env.POC_TUNNEL_TOKEN,
  };
}

export default {
  async fetch(request: Request, env: FreshEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/_poc/health") return Response.json({ ok: true, service: "boldbi-postgres-poc" });
    if (path === "/_poc/boldbi/reset") {
      // Destructive operation: separate credential, POST only, one fixed target.
      // The tunnel and diagnostic credentials cannot authorize this operation.
      const token = env.POC_BOLDBI_RESET_TOKEN;
      if (!token || token.length < 32 || request.headers.get("Authorization") !== `Bearer ${token}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      if (request.headers.get("X-POC-Reset-Target") !== "boldbi-fresh") {
        return new Response("The fixed BoldBI reset target is required.", { status: 400 });
      }
      try {
        await env.BOLDBI_CONTAINER.getByName("boldbi-fresh").destroy();
      } catch {
        return Response.json({ error: "The BoldBI reset could not be confirmed. Check its state before attempting another reset." }, { status: 502 });
      }
      return Response.json({ ok: true, application: "boldbi-fresh", restartOnNextRequest: true, postgresReset: false }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === diagnosticPath) {
      const expected = env.POC_DIAGNOSTIC_TOKEN || env.POC_TUNNEL_TOKEN;
      if (!expected || expected.length < 32 || request.headers.get("Authorization") !== `Bearer ${expected}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      const result = await env.BOLDBI_CONTAINER.getByName("boldbi-fresh").readConnectionDiagnostics(new URL(request.url).origin);
      return new Response(result.body, { status: result.status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
    }
    if (!env.POC_TUNNEL_TOKEN || env.POC_TUNNEL_TOKEN.length < 32 || !env.POSTGRES_PASSWORD) {
      return new Response("Configure POC_TUNNEL_TOKEN and POSTGRES_PASSWORD first.", { status: 503 });
    }
    if (path.startsWith("/_poc/")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.POC_TUNNEL_TOKEN}`) return new Response("Unauthorized", { status: 401 });
      if (path !== "/_poc/postgres/tunnel" && path !== "/_poc/postgres/health") return new Response("Not found", { status: 404 });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      return fetchPostgresAfterStartup(env.POSTGRES_CONTAINER.getByName("postgres-fresh"), request);
    }
    const publicUrl = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", publicUrl.protocol.slice(0, -1));
    headers.set("X-Forwarded-Host", publicUrl.host);
    const response = await env.BOLDBI_CONTAINER.getByName("boldbi-fresh").fetch(new Request(request, { headers }));
    return secureApplicationResponse(response, publicUrl);
  },
};
