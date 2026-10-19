# Project files for deployment and handover

Keep the complete project layout. Both active configurations use the root
`deployment-worker.ts`, which imports both Worker modules to preserve the
existing Durable Object class declarations. The `containers` list in the
selected configuration publishes two normal images or one eval image.

| Files | Purpose |
| --- | --- |
| Root `README.md` and three deployment/reset guides | Handover and direct-command procedures |
| `package.json`, `package-lock.json` | Dependencies; restore with `npm ci` |
| `deployment-worker.ts` | Selects the configured application and exports the existing classes |
| Root `tsconfig.json`, `worker-configuration.d.ts` | TypeScript settings and Cloudflare runtime types |
| `fresh-poc/wrangler.normal.jsonc` | Normal deployment: Bold BI and separate PostgreSQL |
| `fresh-poc/worker.ts` | Normal routing, tunnel endpoints and HTTPS handling |
| `fresh-poc/Dockerfile.boldbi`, `fresh-poc/Dockerfile.postgres` | The two normal container images |
| `fresh-poc/proxy/main.go`, `go.mod`, `go.sum` | Database TCP-over-WebSocket bridge and build dependencies |
| `fresh-poc/Read-BoldBIDiagnostics.py`, `diagnostic-modules.d.ts` | Embedded Worker diagnostic implementation and text-module typing; required by imports |
| `eval-poc/wrangler.eval.jsonc` | Eval deployment: one image with bundled PostgreSQL |
| `eval-poc/worker.ts` | Eval application routing, HTTP readiness and HTTPS handling |
| `eval-poc/Dockerfile`, `cloudflare-entrypoint.sh` | Eval image and required PostgreSQL startup wrapper |
| Both `.dockerignore` files | Docker build context exclusions |
| Folder READMEs and `.gitignore` files | Local guidance and generated-file exclusions |
| Folder `tsconfig.json`, `vitest.config.ts`, test source files | Type checking and automated regression checks |

The normal deployment publishes only its two Dockerfiles. The eval deployment
publishes only its Dockerfile. Keeping both modules for bundling does not publish
additional container images.

## Files excluded from handover

- `node_modules/`: installed dependencies, recreated by `npm ci`; retained locally.
- `.wrangler/` folders: generated Wrangler caches, bundles and logs.
- `__pycache__/`: generated Python caches.
- Generated log exports and diagnostic JSON/CSV reports.
- Local `.env*` or `.dev.vars*` files and any credentials.

Temporary manual validation/SSH/log-export scripts, their unused helper modules,
the local database-check Dockerfile, generated deployment reports, superseded
configurations and the old deployment guide were removed. Required runtime
startup and diagnostic source files remain. Automated regression tests remain
with the source for maintenance.

Wrangler commands may recreate caches and logs. Local cleanup does not change
hosted Worker code, container applications, database data, secrets, registry
images or the global Wrangler login directory.
