# Bold BI with a separate PostgreSQL container

Deploys Bold BI and PostgreSQL 17 as two Cloudflare Containers behind one Worker
(`boldbi-fresh`). This folder is self-contained.

## How it works

The two containers cannot reach each other on a private network, so a small Go
proxy (`proxy/`) carries PostgreSQL traffic over an authenticated WebSocket:

```text
Bold BI  ->  127.0.0.1:15432  (Go proxy client, inside the Bold BI container)
         ->  WSS  <worker-url>/_internal/postgres/tunnel   (Bearer TUNNEL_TOKEN)
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

Generate or define a random token with at least 32 characters in PowerShell. Saving it
to a `$token` variable ensures the exact same value is used both when storing the secret
and when making authenticated health check requests:

```powershell
# Set your chosen database password
npx wrangler secret put POSTGRES_PASSWORD

# Define a 32+ character tunnel token in a PowerShell variable (example below)
$token = "mysecrettoken1234567890abcdef123456"

# Put the token as secret on Cloudflare (paste the token when prompted)
npx wrangler secret put TUNNEL_TOKEN
```

These two secrets are all that is required for standard deployment and operation.

## 3. Deploy

```powershell
npm run deploy
npx wrangler containers list
```

Wait until both applications show Ready (0 instances). Instances start on demand.

## 4. Start the containers

Set `$url` to the Worker URL printed by the deploy. Use the `$token` variable set earlier
so the bearer token matches `TUNNEL_TOKEN` exactly:

```powershell
$url = 'https://boldbi-fresh.<your-subdomain>.workers.dev'
$h = @{ Authorization = "Bearer $token" }
Invoke-RestMethod "$url/_internal/postgres/health" -Headers $h -TimeoutSec 180
```

Expect `ok` and `postgresTcpReachable` to be `True`. Then open
`<url>/ums/startup` in a browser; this starts Bold BI. Allow a few minutes.
`npx wrangler containers list` shows `LIVE INSTANCES` as 0 even while running, so check
each application's instances with its ID from the list:

```powershell
npx wrangler containers instances <ContainerID>
```

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

## 6. Updates and tests

- Code-only update: `npm run deploy:worker` (keeps the current image).
- Image change: `npm run deploy`.
- Checks: `npm run check`, `npm test`, `go test ./...` inside `proxy/`.

Container storage is temporary: stopping or replacing an instance discards
application and database files.

## 7. Recreate or reset containers

If you want to recreate a container from scratch without any existing data, you have two options:

### Option A: Manual reset via Wrangler CLI (Recommended)

Delete the container applications using Wrangler. This completely wipes container storage:

```powershell
npx wrangler containers list
npx wrangler containers delete <boldbi-id>
npx wrangler containers delete <postgres-id>
```

Then redeploy with `npm run deploy` for a clean install. To delete the Worker and all secrets entirely, run `npx wrangler delete`.

### Option B: Programmatic reset endpoint for Bold BI

If you want to wipe and recreate only the Bold BI container on demand without affecting PostgreSQL or using the CLI, you can enable the optional reset route:

1. Configure an optional administrative reset secret (at least 32 characters):
   ```powershell
   npx wrangler secret put BOLDBI_RESET_TOKEN
   ```

2. Trigger the reset endpoint:
   ```powershell
   $resetHeaders = @{
       Authorization   = "Bearer <BOLDBI_RESET_TOKEN>"
       "X-Reset-Target" = "boldbi-fresh"
   }
   Invoke-RestMethod "$url/_internal/boldbi/reset" -Method Post -Headers $resetHeaders
   ```

This terminates the Bold BI container instance and clears its local state. The next browser request automatically starts a clean container.

## 8. Uninstall

Removes everything this guide created. This is permanent and discards all data.

1. Delete both container applications (IDs from `npx wrangler containers list`):

   ```powershell
   npx wrangler containers delete <boldbi-id>
   npx wrangler containers delete <postgres-id>
   ```

2. Delete the Worker, which also removes its secrets and Durable Objects
   (requires delete permission on the Worker):

   ```powershell
   npx wrangler delete
   ```

3. Optional: remove the pushed images with `npx wrangler containers images list`
   and `npx wrangler containers images delete <image>`, and delete local
   `node_modules` if the folder is no longer needed.

References: [Containers](https://developers.cloudflare.com/containers/),
[container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).
