# Reset and redeploy normal Bold BI or eval separately

This procedure retains Worker `ticket287457` and its secret values and namespace
declarations. Deleting a container application discards its local application and
database files. No deletion or cloud deployment has been executed by preparing
this guide.

## 1. Choose one deployment

| Deployment | Configuration | Images published |
| --- | --- | --- |
| Normal Bold BI with separate PostgreSQL | `fresh-poc/wrangler.normal.jsonc` | Bold BI and PostgreSQL only |
| Eval with bundled PostgreSQL | `eval-poc/wrangler.eval.jsonc` | Eval only |

Both configurations use the existing Worker. The last full deployment selects
the application served at its URL. They retain all three Durable Object class
declarations so an earlier deployment's namespaces are not orphaned. Class
declarations do not publish images for the other mode.

## 2. Prepare before deletion

Follow [the prerequisites](DEPLOYMENT-DIRECT-COMMANDS.md#1-prerequisites):
authenticate, start Docker Desktop and retain both source folders, root package
files, runtime types and `deployment-worker.ts`.

Check the chosen configuration locally before cleanup:

```powershell
Set-Location 'D:\cloudflair-container\boldbi-poc'
npx wrangler deploy --dry-run --config fresh-poc/wrangler.normal.jsonc --containers-rollout=none
npx wrangler deploy --dry-run --config eval-poc/wrangler.eval.jsonc --containers-rollout=none
```

A dry run validates the Worker bundle/configuration; it does not prove hosted
runtime readiness. Keep the existing secret values. Normal needs
`POSTGRES_PASSWORD` and `POC_TUNNEL_TOKEN`. Eval needs `EVAL_DB_PASSWORD` and
`EVAL_ADMIN_PASSWORD`.

## 3. Delete only the applications you intend to reset

Close the POC browser tabs and stop test clients, then list the current IDs:

```powershell
npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
```

Match the ID to its exact application name. The following are the previously
recorded IDs; substitute the current ID if the application was recreated:

| Name | Previous ID |
| --- | --- |
| `ticket287457-boldbicontainer` | `a038cacd-a7b3-4227-9d3f-7cbfd85b2b28` |
| `ticket287457-postgrescontainer` | `a03978f5-5876-416a-95b5-dde9c234131e` |
| `ticket287457-boldbievalcontainer` | `a03fe661-873b-435f-83d3-ad10c0714f4e` |

For a fresh normal installation, delete its two applications individually:

```powershell
npx wrangler containers delete a038cacd-a7b3-4227-9d3f-7cbfd85b2b28 --config fresh-poc/wrangler.normal.jsonc
```

```powershell
npx wrangler containers delete a03978f5-5876-416a-95b5-dde9c234131e --config fresh-poc/wrangler.normal.jsonc
```

For a fresh eval installation, delete its application:

```powershell
npx wrangler containers delete a03fe661-873b-435f-83d3-ad10c0714f4e --config eval-poc/wrangler.eval.jsonc
```

Run only the applicable deletion commands. To clear both previous test
installations, run all three after verifying their IDs. Answer Wrangler's
confirmation prompt for each target. Keep the Worker, secrets, class exports and
source files. Do not use `wrangler delete`, which deletes the Worker.

List applications again and wait until the selected targets are absent.
Do not delete any other ticket's applications.

Reference: [Cloudflare container deletion](https://developers.cloudflare.com/workers/wrangler/commands/containers/#delete).

## 4. Deploy normal Bold BI with separate PostgreSQL

After the two normal secrets are configured:

```powershell
npx wrangler deploy --config fresh-poc/wrangler.normal.jsonc
npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
```

This publishes the two normal image definitions. It does not publish eval.
At `https://ticket287457.synctest.workers.dev/ums/startup`, configure PostgreSQL
host `127.0.0.1`, port `15432`, maintenance database/user `postgres`, and the
normal database password. Complete application setup and open a dashboard.

The tunnel and HTTPS configuration are included. See
[normal deployment details](DEPLOYMENT-DIRECT-COMMANDS.md#2-normal-bold-bi-with-separate-postgresql-and-tunneling).

## 5. Deploy eval only

After the two eval secrets are configured:

```powershell
npx wrangler deploy --config eval-poc/wrangler.eval.jsonc
npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
```

This publishes one image definition. It does not build/deploy the normal Bold BI
or separate PostgreSQL images. Open a new Incognito window at
`https://ticket287457.synctest.workers.dev`. The Worker routes directly to eval.
Its bundled PostgreSQL uses `localhost:5432` and `EVAL_DB_PASSWORD`.

See [eval deployment details](EVAL-DEPLOYMENT-DIRECT-COMMANDS.md#2-bold-bi-eval-with-postgresql-inside-the-container).

## 6. Verify the selected deployment

Wait for image publishing and application creation to finish. Record the new
application IDs. A running instance alone is not proof that setup is complete;
verify sign-in, database access and actual dashboard rendering.

The normal HTTPS/CSP configuration and eval localhost HTTP-health readiness
settings are already included. No separate loading-fix deployment is needed.

Existing applications from the other mode are not automatically cleaned up by
these commands. If you want only the selected test installation to remain,
explicitly delete the other mode's applications using their current IDs.
The account-wide list also includes unrelated applications.

Use the current application IDs when inspecting dashboard logs.

For later code-only updates, use `--containers-rollout=none` with the
configuration of the mode already deployed. Use a full deploy to switch modes
or create missing applications. Disk remains temporary after every fresh
installation; this POC has no persistent PostgreSQL volume or backup integration.
