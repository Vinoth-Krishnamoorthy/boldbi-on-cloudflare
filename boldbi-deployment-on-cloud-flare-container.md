# Bold BI deployment with a separate PostgreSQL container

This procedure deploys **two container applications**: Bold BI and PostgreSQL,
under the existing Worker `ticket287457`. It uses direct commands.

## 1. Prerequisites

| Requirement | Details |
| --- | --- |
| Existing Worker | `ticket287457` |
| Cloudflare account | `ce1589d9d07e86f7f95eb9e12c05afac` |
| API token | Access to update this Worker, secrets, container applications and registry images |
| Tools | Node.js/npm and a running Docker engine |
| Source | Complete project directory, root package/configuration files, runtime types, `deployment-worker.ts` and its imported modules |
| Bold BI activation | Valid license or entitlement |
| Credentials | Normal PostgreSQL password and a separate tunnel token |

Keep the complete source tree available for bundling; copying only the
`fresh-poc` folder is insufficient. This deployment publishes only
`fresh-poc/Dockerfile.boldbi` and `fresh-poc/Dockerfile.postgres`.

### 1.1 Set the Worker name and account

Edit the **top-level `name`** in
[fresh-poc/wrangler.normal.jsonc](fresh-poc/wrangler.normal.jsonc).
Its current value is `ticket287457`. Set `account_id` to the target account
and align `$env:CLOUDFLARE_ACCOUNT_ID` with it.

For example, change these fields in the configuration while retaining the rest:

```json
{
  "name": "my-existing-worker",
  "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID"
}
```

Use an existing Worker you are authorized to update. This selects the deployment
target; it does not rename or delete the previous Worker. Replace the guide's
example URLs with the URL printed by Wrangler. Set the Bold BI public Site/Proxy
URL to that actual HTTPS address.

Keep `DEPLOYMENT_MODE`, class names, binding names and existing `exports`
declarations unchanged. They match the application code and preserve the
Worker's provisioned namespaces. They do not add extra container images.

The runtime tunnel URL is derived from the incoming request. The Worker name
does not need to be edited in the Dockerfiles or Go proxy.

### 1.2 Prepare tools and authenticate

```powershell
Set-Location 'D:\cloudflair-container\boldbi-poc'
node --version
docker version
npm ci
npx wrangler --version
```

Run `npm ci` when preparing a workstation or restoring missing dependencies,
not for every deployment. Use the authenticated PowerShell session, or enter
the API token securely:

```powershell
$pocTokenInput = Read-Host 'Cloudflare API token' -AsSecureString
$pocTokenCredential = New-Object System.Management.Automation.PSCredential('api-token', $pocTokenInput)
$env:CLOUDFLARE_API_TOKEN = $pocTokenCredential.GetNetworkCredential().Password
$env:CLOUDFLARE_ACCOUNT_ID = 'ce1589d9d07e86f7f95eb9e12c05afac'
Remove-Variable pocTokenInput, pocTokenCredential
npx wrangler whoami --config fresh-poc/wrangler.normal.jsonc
```

## 2. Normal Bold BI with separate PostgreSQL and tunneling

### 2.1 How the tunnel works

Normal Bold BI uses `syncfusion/boldbi:17.1.30`. PostgreSQL 17 runs in a separate
container. The project's Go proxy forwards PostgreSQL traffic through an
authenticated WebSocket route in the Worker:

```text
Bold BI application
    | PostgreSQL TCP connection: 127.0.0.1:15432
    v
Go proxy client inside the Bold BI container
    | Encrypted WebSocket connection (WSS), authenticated by POC_TUNNEL_TOKEN
    v
ticket287457 Worker: /_poc/postgres/tunnel
    | Routes the connection to the PostgreSQL container
    v
Go proxy server inside PostgreSQL container: port 8081
    | Local TCP connection: 127.0.0.1:5432
    v
PostgreSQL 17
```

Each local database TCP connection gets its own WebSocket connection. The proxy
forwards the database byte stream in both directions. PostgreSQL still checks
the database username and password; the tunnel token authenticates the transport.

At startup, the Worker supplies `POC_TUNNEL_URL` and `POC_TUNNEL_TOKEN` to the
Bold BI proxy. It supplies the same token and `POSTGRES_PASSWORD` to the separate
PostgreSQL container. The client waits for the tunnel before launching the
vendor Bold BI entrypoint.

Note: this is our TCP-over-WebSocket bridge. It does not require `cloudflared`,
a named Cloudflare Tunnel or a shared Docker Compose network. Bold BI connects
to its own local proxy address, not the other container's name.

### 2.2 Dockerfile additions and why they are needed

Normal image: [fresh-poc/Dockerfile.boldbi](fresh-poc/Dockerfile.boldbi).

| Addition | Purpose |
| --- | --- |
| Go build stage using `golang:1.25-alpine` | Compiles `fresh-poc/proxy` into `poc-proxy` |
| Base `syncfusion/boldbi:17.1.30` | Supplies the normal Bold BI application |
| Copy proxy to `/usr/local/bin/poc-proxy` | Includes the local database tunnel client in the image |
| `ENTRYPOINT ["/usr/local/bin/poc-proxy", "client"]` | Starts the listener on `127.0.0.1:15432` and the WebSocket transport |
| `CMD ["/application/entrypoint.sh"]` | Preserves vendor startup after the tunnel becomes available |
| `EXPOSE 80` | Records the HTTP port forwarded by the Worker |

Database image: [fresh-poc/Dockerfile.postgres](fresh-poc/Dockerfile.postgres).

| Addition | Purpose |
| --- | --- |
| Go build stage and copied proxy | Includes the server side of the WebSocket bridge |
| Base `postgres:17` | Supplies PostgreSQL 17 |
| Startup creation of `/dev/shm` and `/var/run/postgresql` with permissions | Prepares PostgreSQL runtime directories |
| `poc-proxy server docker-entrypoint.sh postgres ...` | Starts the bridge server and standard database entrypoint |
| `dynamic_shared_memory_type=mmap` | Uses file-backed dynamic shared memory |
| `EXPOSE 8081` | Records the proxy HTTP port; its database connection remains local on port 5432 |

These additions are already in the source. Wrangler builds and publishes the
custom images during deployment; the vendor images serve as their base images.

### 2.3 Configure normal deployment secrets

Check the existing secret names first:

```powershell
npx wrangler secret list --config fresh-poc/wrangler.normal.jsonc
```

For initial provisioning, enter the normal PostgreSQL password:

```powershell
npx wrangler secret put POSTGRES_PASSWORD --config fresh-poc/wrangler.normal.jsonc
```

Generate a tunnel credential only when provisioning it for the first time:

```powershell
$pocRandomBytes = New-Object byte[] 32
$pocRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$pocRng.GetBytes($pocRandomBytes)
$pocRng.Dispose()
$pocTunnelToken = [Convert]::ToBase64String($pocRandomBytes)
$pocTunnelToken | npx wrangler secret put POC_TUNNEL_TOKEN --config fresh-poc/wrangler.normal.jsonc
```

Retain both credentials in your secret management system. Reuse current values
for an existing deployment. Container processes receive secrets at startup.
These secrets belong to Worker `ticket287457`. Its normal application uses them;
the secret commands do not deploy Worker code or rebuild images.

### 2.4 Deploy normal Bold BI and separate PostgreSQL

After the normal database password and tunnel token are configured, run:

```powershell
npx wrangler deploy --config fresh-poc/wrangler.normal.jsonc
npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
```

This publishes exactly two image definitions: normal Bold BI and separate
PostgreSQL. The Worker serves the normal application. No separate Docker push is required.

**HTTPS configuration included automatically:** the normal Worker forwards the
public scheme and host using `X-Forwarded-Proto` and `X-Forwarded-Host`, adds
`Content-Security-Policy: upgrade-insecure-requests` to HTTPS HTML, and upgrades
same-host HTTP redirects. Dashboard scripts, styles and fonts are therefore
requested over HTTPS behind Cloudflare's TLS termination. JavaScript/CSS bodies
are streamed unchanged.

Note: this configuration is already in `fresh-poc/worker.ts`; the deployment
includes it without a separate patch command. Keep the Bold BI public Site/Proxy
URL set to `https://ticket287457.synctest.workers.dev`.

### 2.5 Wait for readiness, then start both containers

After the full deploy finishes, **allow a few minutes for application
provisioning**. Repeat the following command periodically, for example every
30 seconds, until both container applications are ready:

```powershell
npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
```

| State / live instances | Meaning | Action |
| --- | --- | --- |
| Provisioning / 0 | Application preparation is still in progress | Wait a few minutes and check again |
| Ready / 0 | Application is provisioned; no instance is running | Send the startup requests below |
| Active / 1 | An instance is running | Allow application initialization to finish and complete setup |

**Waiting alone does not make a ready/0 application active/1.** Instances start
on demand when the Worker routes receive requests. Listing applications and
calling `/_poc/health` alone do not start either container.

#### A. Start PostgreSQL first

Set the URL to the actual address printed by deployment:

```powershell
$pocBaseUrl = 'https://ticket287457.synctest.workers.dev'
```

If the current PowerShell session already has the correct `$pocTunnelToken`
from section 2.3, keep it. Otherwise read the **existing deployed token** from
your secret management system and load it securely:

```powershell
$pocTunnelInput = Read-Host 'Existing POC_TUNNEL_TOKEN' -AsSecureString
$pocTunnelCredential = New-Object System.Management.Automation.PSCredential('tunnel', $pocTunnelInput)
$pocTunnelToken = $pocTunnelCredential.GetNetworkCredential().Password
Remove-Variable pocTunnelInput, pocTunnelCredential
```

This reads the token locally; it does not replace the Worker secret.
Send the authenticated database health request:

```powershell
$pocHeaders = @{ Authorization = "Bearer $pocTunnelToken" }
Invoke-RestMethod "$pocBaseUrl/_poc/postgres/health" -Headers $pocHeaders -TimeoutSec 180
```

This route starts the PostgreSQL instance. Allow time for database initialization.
Expected response fields:

```text
  ok postgresTcpReachable
  -- --------------------
True                 True
```

TCP reachability does not establish password authentication.

#### B. Start Bold BI

Open the application startup URL in Chrome:

```text
https://ticket287457.synctest.workers.dev/ums/startup
```

That application request starts the Bold BI container. Its local proxy connects
to PostgreSQL through the tunnel before starting the vendor services. Allow a
few minutes for the initial application startup.

Alternatively, send the application request directly from PowerShell:

```powershell
curl.exe --silent --show-error --max-time 180 --output NUL --write-out 'HTTP %{http_code}' "$pocBaseUrl/ums/startup"
```

Then use Chrome to complete setup.

#### C. Confirm both are active

```powershell
npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
```

After both startup requests succeed, expect:

```text
ticket287457-postgrescontainer   active   1
ticket287457-boldbicontainer     active   1
```

The list can take a short time to reflect activity. An active instance does not
by itself prove all Bold BI services have finished initialization. Complete
section 2.6 and open a dashboard.

If a startup request fails and the instance stays at zero, inspect that
application's current startup logs before assuming it started. A ready
application does not need deletion or redeployment simply to start it.

The current source sets a six-hour inactivity timeout. After idle shutdown,
the application can return to ready/0; the next application request starts it.
Reference: [Cloudflare container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).

### 2.6 Configure Bold BI to use the separate database

Open:

```text
https://ticket287457.synctest.workers.dev/ums/startup
```

| Setup field | Value |
| --- | --- |
| Server type | PostgreSQL |
| Server name | `127.0.0.1` |
| Port | `15432` |
| Maintenance database | `postgres` |
| Username | `postgres` |
| Password | The configured `POSTGRES_PASSWORD` |
| Database | New database, such as `bold_services`, for a fresh installation |
| Enable SSL | Unchecked for the PostgreSQL configuration in this POC |

Complete administrator, license and site setup. Transport between containers
uses WSS; PostgreSQL-native TLS is not enabled in this database configuration.

## 3. Later Worker-only updates

For code updates within the already deployed normal mode, retaining current
container images:

```powershell
npx wrangler deploy --config fresh-poc/wrangler.normal.jsonc --containers-rollout=none
```

Use the full deployment in section 2.4 for initial container creation or intended
image changes. Local disk is temporary: stopping or replacing an instance
discards application/database files. Docker Compose volumes do not create
persistent Cloudflare disks.

## Official references

| Subject | Reference |
| --- | --- |
| Worker name and account | [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys) |
| Public address | [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) |
| Image deployment | [Cloudflare image management](https://developers.cloudflare.com/containers/guides/image-management/) |
| Provisioning and on-demand startup | [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/) |
| Full and Worker-only deployments | [Cloudflare rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/) |
| Application public URL | [Bold BI proxy settings](https://help.boldbi.com/multi-tenancy/site-administration/proxy-settings/) |
| HTTPS resource policy | [CSP upgrade-insecure-requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/upgrade-insecure-requests) |

## 4. Restart with application and database data removed

For a completely fresh normal installation, delete and recreate **both container
applications**. This resets Bold BI's local files and the separate PostgreSQL
database, including existing sites, users and dashboards. Deleting only the
Bold BI container leaves the separate database's records in place.

This procedure recreates the applications rather than restarting a process
inside a running container. Keep the existing Worker, source and secret values.
Run from the project root in the authenticated PowerShell session with Docker
running.

1. Close the application browser tabs and stop POC test clients. List the
   current application IDs:

   ```powershell
   npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
   ```

2. Match each ID to its exact name: `ticket287457-boldbicontainer` and
   `ticket287457-postgrescontainer`. If you changed the Worker name, use the
   corresponding application names. Enter the **current application IDs**,
   then run each deletion command and confirm its prompt:

   ```powershell
   $pocBoldBIId = Read-Host 'Current normal Bold BI application ID'
   $pocPostgresId = Read-Host 'Current separate PostgreSQL application ID'
   npx wrangler containers delete "$pocBoldBIId" --config fresh-poc/wrangler.normal.jsonc
   ```

   ```powershell
   npx wrangler containers delete "$pocPostgresId" --config fresh-poc/wrangler.normal.jsonc
   npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
   ```

   Wait until both selected applications are absent. Application IDs change
   when recreated; use a fresh list for every reset.

3. Recreate the two applications with the existing secrets:

   ```powershell
   npx wrangler deploy --config fresh-poc/wrangler.normal.jsonc
   npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
   ```

   Use the full deployment command above. `--containers-rollout=none` is for
   Worker-only updates and does not recreate deleted container applications.

4. Allow a few minutes for provisioning. When both applications show `ready`,
   follow [section 2.5](#25-wait-for-readiness-then-start-both-containers): load
   the existing tunnel token, call `/_poc/postgres/health` to start PostgreSQL,
   then open `/ums/startup` to start Bold BI. Confirm both show `active` with
   one live instance and complete the fresh setup in section 2.6.

Keep `POSTGRES_PASSWORD` and `POC_TUNNEL_TOKEN` unchanged when following this
reset procedure. The HTTPS and tunnel configuration remain included in the
deployment source.

References: [Cloudflare container application deletion](https://developers.cloudflare.com/workers/wrangler/commands/containers/#delete),
[container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).

## 5. Cleanup / uninstall the normal container applications

Use this when you want to remove the normal installation without recreating it.
It deletes both normal container applications and their local application and
database data.

1. Close application tabs and stop POC test clients. Obtain the current IDs:

   ```powershell
   npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
   ```

2. Identify only `ticket287457-boldbicontainer` and
   `ticket287457-postgrescontainer` (or their names under your chosen Worker).
   Enter their IDs, then run each deletion command and confirm its prompt:

   ```powershell
   $pocBoldBIId = Read-Host 'Current normal Bold BI application ID to uninstall'
   $pocPostgresId = Read-Host 'Current separate PostgreSQL application ID to uninstall'
   npx wrangler containers delete "$pocBoldBIId" --config fresh-poc/wrangler.normal.jsonc
   ```

   ```powershell
   npx wrangler containers delete "$pocPostgresId" --config fresh-poc/wrangler.normal.jsonc
   npx wrangler containers list --config fresh-poc/wrangler.normal.jsonc
   ```

3. Wait until both selected applications are absent. Stop here; a subsequent
   full deployment would recreate them. The normal application URL cannot
   serve Bold BI while its container applications are removed.

This uninstall retains the existing Worker, its secrets and Durable Object
namespace declarations, registry images and local source. Other applications
in the account are outside this uninstall. Keep using `containers delete`;
`wrangler delete` would delete the Worker itself.

Reference: [Cloudflare container application deletion](https://developers.cloudflare.com/workers/wrangler/commands/containers/#delete).
