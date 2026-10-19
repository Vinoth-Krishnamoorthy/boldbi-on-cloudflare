# Bold BI with separate PostgreSQL

Follow the [normal deployment guide](../DEPLOYMENT-DIRECT-COMMANDS.md).
Use `fresh-poc/wrangler.normal.jsonc` from the project root to publish the two
container images. That guide includes configuration, database tunneling,
HTTPS handling, provisioning and the requests that start both containers.

Keep `Dockerfile.boldbi`, `Dockerfile.postgres`, `.dockerignore`, `proxy/`,
`worker.ts` and `wrangler.normal.jsonc`. `Read-BoldBIDiagnostics.py` is imported
by the Worker as runtime source; retain it and `diagnostic-modules.d.ts`.

The folder depends on the complete project layout. See
[the file inventory](WORKSPACE-FILES.md). The `*.test.*` files and test
configuration support automated regression checks.
