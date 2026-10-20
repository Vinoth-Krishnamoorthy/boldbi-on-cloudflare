# Bold BI Eval (PostgreSQL bundled in one container)

Deploys the vendor image `syncfusion/boldbi:17.1.30-eval` as one Cloudflare
Container behind one Worker (`boldbi-eval`). This folder is self-contained.

## How it works

The image already contains Bold BI and an initialized PostgreSQL 15, which share
`localhost:5432`, so no database tunnel or second container is needed.
`cloudflare-entrypoint.sh` prepares directories the microVM may lack and syncs
the database password before starting the vendor entrypoint. The Worker passes
these variables to the container:

| Variable | Value |
| --- | --- |
| `BOLD_SERVICES_DB_HOST` / `_DB_TYPE` | `localhost` / `postgresql` |
| `BOLD_SERVICES_DB_USER` | `postgres` |
| `BOLD_SERVICES_DB_PASSWORD` | secret `EVAL_DB_PASSWORD` |
| `BOLD_SERVICES_USER_EMAIL` | `EVAL_ADMIN_EMAIL`, default `testuser@boldbi.com` |
| `BOLD_SERVICES_USER_PASSWORD` | secret `EVAL_ADMIN_PASSWORD` |
| `BOLD_SERVICES_REVERSE_PROXY` | `true` (TLS ends at Cloudflare) |

The Worker also forwards the public scheme/host, upgrades same-host `http`
redirects and adds `upgrade-insecure-requests` to HTML. Readiness uses an HTTP
check on port 80 (`localhost/health-check`), never on PostgreSQL.

## 1. Prerequisites

- Node.js 22 or later, and a running Docker engine
- A Cloudflare account and an API token that can edit Workers, Containers and the registry

```powershell
$env:CLOUDFLARE_API_TOKEN = '<token>'
Set-Location eval
npm install
```

Edit `wrangler.jsonc`: set `account_id` to your account. Change `name`
(`boldbi-eval`) if you want a different Worker name and URL.

## 2. Set secrets

```powershell
npx wrangler secret put EVAL_DB_PASSWORD
npx wrangler secret put EVAL_ADMIN_PASSWORD
```

Optional: `EVAL_ADMIN_EMAIL` to replace the default administrator email.

## 3. Deploy

```powershell
npm run deploy
npx wrangler containers list
```

Wait until the application shows Ready. The instance starts on demand.

## 4. Open and sign in

Open the Worker URL printed by the deploy in a new Incognito window and allow a
few minutes for the first start. Complete any trial/license prompt, then sign in:

| Setting | Value |
| --- | --- |
| Administrator email | `testuser@boldbi.com` (or `EVAL_ADMIN_EMAIL`) |
| Administrator password | your `EVAL_ADMIN_PASSWORD` |
| Database form, if shown | `localhost` / `5432`, user `postgres`, password `EVAL_DB_PASSWORD` |

Open a dashboard to confirm it renders.

## 5. Updates and tests

- Code-only update: `npm run deploy:worker` (keeps the current image).
- Image change: `npm run deploy`.
- Checks: `npm run check`, `npm test`.

Container storage is temporary: stopping or replacing the instance discards
application and database files.

## 6. Reset or uninstall

List the applications and note the ID of `boldbi-eval-boldbievalcontainer`
(the name follows your Worker name):

```powershell
npx wrangler containers list
npx wrangler containers delete <id>
```

Redeploy with `npm run deploy` for a clean install. To remove everything,
including secrets: `npx wrangler delete`.

References: [Vendor eval deployment](https://help.boldbi.com/deploying-bold-bi/deploying-on-docker/bold-bi-on-docker/bold-bi-eval-on-single-container/),
[container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).
