# Bold BI eval image deployment

This guide publishes one eval image with bundled PostgreSQL. Keep the complete
project source and `deployment-worker.ts` available for bundling.

## 1. Prerequisites and target

Use Node.js/npm, a running Docker engine, a valid evaluation entitlement and an
API token that can update the target Worker's secrets, containers and registry.
Set `CLOUDFLARE_API_TOKEN` in the authenticated PowerShell session.

Edit the top-level `name` and `account_id` in
[eval-poc/wrangler.eval.jsonc](eval-poc/wrangler.eval.jsonc). Current values are
`ticket287457` and `ce1589d9d07e86f7f95eb9e12c05afac`.
Align `CLOUDFLARE_ACCOUNT_ID` with that account, retain the declared classes
and bindings, and replace example URLs with the actual deployment URL.

```powershell
Set-Location 'D:\cloudflair-container\boldbi-poc'
docker version
npm ci
npx wrangler whoami --config eval-poc/wrangler.eval.jsonc
```

Run `npm ci` only when restoring/installing dependencies.

## 2. Bold BI eval with PostgreSQL inside the container

### 2.1 How the internal database connection works

`syncfusion/boldbi:17.1.30-eval` includes Bold BI and an initialized PostgreSQL 15
cluster. The vendor `/application/entrypoint.sh` starts PostgreSQL and Bold BI.

```text
Single eval container:
Bold BI services ---- localhost:5432 ---- PostgreSQL 15
```

Both processes share the container's network namespace. Bold BI can reach the
bundled PostgreSQL server directly through `localhost`, without a cross-container
tunnel or a separate PostgreSQL container.

The eval Worker supplies these startup variables:

| Environment variable | Value / source |
| --- | --- |
| `BOLD_SERVICES_DB_TYPE` | `postgresql` |
| `BOLD_SERVICES_DB_HOST` | `localhost` |
| `BOLD_SERVICES_POSTGRESQL_MAINTENANCE_DB` | `postgres` |
| `BOLD_SERVICES_DB_USER` | `postgres` |
| `BOLD_SERVICES_DB_PASSWORD` | Worker secret `EVAL_DB_PASSWORD` |
| `BOLD_SERVICES_USER_EMAIL` | `testuser@boldbi.com` by default |
| `BOLD_SERVICES_USER_PASSWORD` | Worker secret `EVAL_ADMIN_PASSWORD` |
| `BOLD_SERVICES_REVERSE_PROXY` | `true`, for external HTTPS termination |

### 2.2 Dockerfile additions and why they are needed

Image: [eval-poc/Dockerfile](eval-poc/Dockerfile).
Startup wrapper: [eval-poc/cloudflare-entrypoint.sh](eval-poc/cloudflare-entrypoint.sh).

| Addition | Purpose |
| --- | --- |
| Vendor eval base pinned to the inspected image digest | Uses the selected `17.1.30-eval` image and its bundled PostgreSQL installation |
| Copy a startup wrapper into the image | Prepares PostgreSQL before handing control to the vendor entrypoint |
| Normalize line endings and mark the wrapper executable | Allows the shell file maintained on Windows to execute in Linux |
| Create `/dev/shm`, `/var/run/postgresql` and `/var/log/postgresql`, with permissions | Prepares database runtime and logging directories |
| `pg_conftool 15 main set dynamic_shared_memory_type mmap` | Configures file-backed dynamic shared memory |
| Start PostgreSQL and set its role password from `BOLD_SERVICES_DB_PASSWORD` | Makes the bundled database password match the eval secret used by Bold BI |
| Export database and reverse-proxy variables | Selects the internal database and HTTPS-aware startup |
| Execute `/application/entrypoint.sh` | Preserves vendor application startup |
| `EXPOSE 80` | Records the HTTP port forwarded by the Worker |

Note: password synchronization is needed because this image already contains
an initialized cluster. Setting an environment variable alone does not change
an existing PostgreSQL role password. The wrapper updates only the eval database.

### 2.3 Configure eval secrets

For initial provisioning:

```powershell
npx wrangler secret put EVAL_DB_PASSWORD --config eval-poc/wrangler.eval.jsonc
npx wrangler secret put EVAL_ADMIN_PASSWORD --config eval-poc/wrangler.eval.jsonc
```

Enter the database and administrator passwords at the prompts. The original
evaluation Compose used `Admin@123` for both. Retain your own existing overrides.
Eval credentials are separate from the normal database and tunnel secrets.

### 2.4 Deploy the eval image only

After the two eval secrets are present, run:

```powershell
npx wrangler deploy --config eval-poc/wrangler.eval.jsonc
npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
```

This builds/publishes only `eval-poc/Dockerfile`, creating/updating only the eval
container application. It sets `DEPLOYMENT_MODE=eval`, so requests go directly
to eval and do not call the normal handler or the separate PostgreSQL routes.
Normal database/tunnel credentials are not needed by eval. A fresh deployment
does not require old application IDs or image pins. Wait for the full command to
finish, then allow the application services to initialize.

Note: this full deployment may replace the eval instance when its image or
configuration changes. It does not include a rebuild of either normal image.

**Application configuration included automatically:**

- Eval sets `BOLD_SERVICES_REVERSE_PROXY=true`, forwards the public scheme and
  host, and applies the HTTPS HTML policy and same-host redirect upgrade.
- Eval checks readiness on HTTP port `80` using
  `pingEndpoint = "localhost/health-check"`. This addresses the application's
  health endpoint directly; PostgreSQL port 5432 is not used for HTTP probing.

These settings are already in the source and are included in this deployment.
No additional loading-fix command is required.

### 2.5 Open and configure eval

Open a **new Chrome Incognito window** at the public URL:

```text
https://ticket287457.synctest.workers.dev
```

Eval mode routes directly to the eval application, including `/bi` and `/ums`.
No browser selector cookie or separate PostgreSQL deployment is required.
Complete any trial/license prompt and use:

| Setting | Value |
| --- | --- |
| Administrator email | `testuser@boldbi.com` |
| Administrator password | The configured `EVAL_ADMIN_PASSWORD` |
| Database connection | Supplied automatically through startup variables |
| Host / port, if a database form is shown | `localhost` / `5432` |
| Maintenance database / user | `postgres` / `postgres` |
| Database password | The configured `EVAL_DB_PASSWORD` |

Note: Incognito keeps application login cookies and cache separate between tests.
A full deployment to this shared Worker selects the mode served at its public URL.


## 3. Readiness and subsequent updates

After publishing, allow a few minutes for provisioning. Wait for the application
to become ready, then open the public URL to start its instance on demand.
After startup, verify an active instance, application sign-in and a dashboard.

```powershell
npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
```

For code updates within the already deployed mode:

```powershell
npx wrangler deploy --config eval-poc/wrangler.eval.jsonc --containers-rollout=none
```

Use a full deployment for initial creation or a mode change. The local container
disk is temporary; stop/replacement discards application and database files.

References: [Vendor evaluation deployment](https://help.boldbi.com/deploying-bold-bi/deploying-on-docker/bold-bi-on-docker/bold-bi-eval-on-single-container/),
[Cloudflare lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/),
[Readiness properties](https://developers.cloudflare.com/containers/api/container-class/#properties).

## 4. Restart with application and database data removed

For a completely fresh eval installation, delete and recreate the **single eval
container application**. This removes Bold BI's local files and its bundled
PostgreSQL database, including existing sites, users and dashboards. Both run
inside this one container.

This procedure recreates the application rather than restarting a process
inside a running container. Keep the existing Worker, source and secret values.
Run from the project root in the authenticated PowerShell session with Docker
running.

1. Close eval browser tabs and stop POC test clients. List the current IDs:

   ```powershell
   npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
   ```

2. Find `ticket287457-boldbievalcontainer`, or its corresponding name if you
   changed the Worker name. Enter its **current application ID**, delete it
   and confirm the prompt:

   ```powershell
   $pocEvalId = Read-Host 'Current Bold BI eval application ID'
   npx wrangler containers delete "$pocEvalId" --config eval-poc/wrangler.eval.jsonc
   npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
   ```

   Wait until that application is absent. Its application ID will change when
   recreated; use a fresh list for every reset.

3. Recreate only the eval application with the existing secrets:

   ```powershell
   npx wrangler deploy --config eval-poc/wrangler.eval.jsonc
   npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
   ```

   Use the full deployment command above. `--containers-rollout=none` is for
   Worker-only updates and does not recreate a deleted container application.

4. Allow a few minutes for provisioning. When the application shows `ready`,
   open the public URL in a new Chrome Incognito window to start its instance:

   ```text
   https://ticket287457.synctest.workers.dev
   ```

   Use the actual URL printed by Wrangler. Allow the bundled database and
   application services to initialize. Confirm `active` with one live instance,
   complete section 2.5, sign in and open a dashboard.

Keep `EVAL_DB_PASSWORD` and `EVAL_ADMIN_PASSWORD` unchanged when following this
reset procedure. The PostgreSQL startup wrapper, HTTP readiness check and HTTPS
configuration remain included in the deployment source.

References: [Cloudflare container application deletion](https://developers.cloudflare.com/workers/wrangler/commands/containers/#delete),
[container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).

## 5. Cleanup / uninstall the eval container application

Use this when you want to remove eval without recreating it. Deleting this one
application removes both Bold BI's local files and its bundled PostgreSQL data.

1. Close eval tabs and stop POC test clients. Obtain the current ID:

   ```powershell
   npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
   ```

2. Identify only `ticket287457-boldbievalcontainer`, or its name under your
   chosen Worker. Enter its ID, delete it and confirm the prompt:

   ```powershell
   $pocEvalId = Read-Host 'Current Bold BI eval application ID to uninstall'
   npx wrangler containers delete "$pocEvalId" --config eval-poc/wrangler.eval.jsonc
   npx wrangler containers list --config eval-poc/wrangler.eval.jsonc
   ```

3. Wait until that application is absent. Stop here; a subsequent full eval
   deployment would recreate it. The eval application URL cannot serve Bold BI
   while its container application is removed.

This uninstall retains the existing Worker, its secrets and Durable Object
namespace declarations, registry images and local source. Other applications
in the account are outside this uninstall. Keep using `containers delete`;
`wrangler delete` would delete the Worker itself.

Reference: [Cloudflare container application deletion](https://developers.cloudflare.com/workers/wrangler/commands/containers/#delete).
