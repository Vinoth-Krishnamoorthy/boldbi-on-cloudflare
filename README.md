# Bold BI on Cloudflare Containers

This POC supports two deployment options on the existing `ticket287457` Worker.
Choose the guide for the application you want to deploy.

| Deployment | Step-by-step guide | Configuration | Container images published |
| --- | --- | --- | --- |
| Bold BI with separate PostgreSQL | [Normal deployment](DEPLOYMENT-DIRECT-COMMANDS.md) | `fresh-poc/wrangler.normal.jsonc` | Bold BI and PostgreSQL |
| Bold BI evaluation with bundled PostgreSQL | [Eval deployment](EVAL-DEPLOYMENT-DIRECT-COMMANDS.md) | `eval-poc/wrangler.eval.jsonc` | Eval only |

Both guides use direct Wrangler commands. They include prerequisites, Worker
name/account settings, Dockerfile changes, deployment and application startup.
The normal guide explains the authenticated TCP-over-WebSocket database tunnel.
The HTTPS dashboard-loading corrections and eval startup settings are included
in the source.

Both configurations update the same Worker. The last full deployment selects
which application its public URL serves. Existing container applications are
listed account-wide. For an intentional fresh installation, follow
[reset and redeployment](RESET-AND-REDEPLOY.md) using current application IDs.

Keep both source folders and the root package/configuration files together.
`deployment-worker.ts` imports both Worker modules to retain the existing Durable
Object namespaces; the selected configuration controls which images publish.
See [the file inventory](fresh-poc/WORKSPACE-FILES.md) for required files.

## Local validation

Run from the project root after `npm ci`:

```powershell
npm run check
npm test
```

The automated tests are source files for checking routing, deployment scope,
HTTPS handling and diagnostics. Deployment does not require running test helpers.
Temporary diagnostic scripts, generated reports, caches and superseded deployment
configurations have been removed.

## Sharing the project

Share the root documentation, package files, TypeScript files and both source
folders. Exclude `node_modules/`, `.wrangler/`, local environment/secret files and
newly generated logs. Dependencies can be restored with `npm ci`. Local
`node_modules/` remains available for development.

Container storage in this POC is temporary. Stopping or replacing an instance
can discard application and database files; it has no persistent volume or
backup integration.
