# Bold BI with a separate PostgreSQL container

Deploys Bold BI and PostgreSQL 17 as two Cloudflare Containers behind one Worker
(`boldbi-fresh`). This folder is self-contained.

## How it works

The two containers cannot reach each other on a private network, so a small Go
proxy (`proxy/`) carries PostgreSQL traffic over an authenticated WebSocket:

```text
Bold BI  ->  127.0.0.1:15432  (Go proxy client, inside the Bold BI container)
         ->  WSS  <worker-url>/_poc/postgres/tunnel   (Bearer POC_TUNNEL_TOKEN)
         ->  Worker  ->  PostgreSQL container: Go proxy server :8081
         ->  127.0.0.1:5432  PostgreSQL 17
```

PostgreSQL still checks its own username/password; the token authenticates the
transport. The Worker also adds the HTTPS headers, redirect upgrade and
`upgrade-insecure-requests` policy Bold BI needs behind Cloudflare's TLS edge.

## 1. Prerequisites

- Node.js 22 or later, and a running Docker engine
- A Cloudflare account and an API token that can edit Workers, Containers and the registry

```powershell
$env:CLOUDFLARE_API_TOKEN = '<token>'
Set-Location fresh
npm install
```

Edit `wrangler.jsonc`: set `account_id` to your account. Change `name`
(`boldbi-fresh`) if you want a different Worker name and URL.

## 2. Set secrets

```powershell
npx wrangler secret put POSTGRES_PASSWORD
npx wrangler secret put POC_TUNNEL_TOKEN      # at least 32 random characters
```

Optional: `POC_DIAGNOSTIC_TOKEN` (own credential for the diagnostics route) and
`POC_BOLDBI_RESET_TOKEN` (at least 32 characters, enables the reset route).

## 3. Deploy

```powershell
npm run deploy
npx wrangler containers list
```

Wait until both applications show Ready (0 instances). Instances start on demand.

## 4. Start the containers

Set `$url` to the Worker URL printed by the deploy. Start PostgreSQL first:

```powershell
$url = 'https://boldbi-fresh.<your-subdomain>.workers.dev'
$h = @{ Authorization = "Bearer <POC_TUNNEL_TOKEN>" }
Invoke-RestMethod "$url/_poc/postgres/health" -Headers $h -TimeoutSec 180
```

Expect `ok` and `postgresTcpReachable` to be `True`. Then open
`<url>/ums/startup` in a browser; this starts Bold BI. Allow a few minutes.
`npx wrangler containers list` should show both applications active.

## 5. Configure Bold BI

| Field | Value |
| --- | --- |
| Server type | PostgreSQL |
| Server name / port | `127.0.0.1` / `15432` |
| Maintenance database / user | `postgres` / `postgres` |
| Password | your `POSTGRES_PASSWORD` |
| Database | a new name, e.g. `bold_services` |
| SSL | off (the tunnel itself uses WSS) |

Complete administrator, license and site setup, then open a dashboard to verify.

## 6. Updates, diagnostics and tests

- Code-only update: `npm run deploy:worker` (keeps the current images).
- Image change: `npm run deploy`.
- `GET <url>/_poc/boldbi/diagnostics` with `Authorization: Bearer <POC_DIAGNOSTIC_TOKEN or POC_TUNNEL_TOKEN>` returns a read-only connection report.
- Checks: `npm run check`, `npm test`, `python -m unittest test_boldbi_diagnostics`, and `go test ./...` inside `proxy/`.

Container storage is temporary: stopping or replacing an instance discards
application and database files.

## 7. Reset or uninstall

List the applications and note the IDs of `boldbi-fresh-boldbicontainer` and
`boldbi-fresh-postgrescontainer` (names follow your Worker name):

```powershell
npx wrangler containers list
npx wrangler containers delete <boldbi-id>
npx wrangler containers delete <postgres-id>
```

Redeploy with `npm run deploy` for a clean install. To remove everything,
including secrets: `npx wrangler delete`.

References: [Containers](https://developers.cloudflare.com/containers/),
[container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).
