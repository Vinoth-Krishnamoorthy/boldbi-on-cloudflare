# Bold BI evaluation image

Follow the [eval deployment guide](../EVAL-DEPLOYMENT-DIRECT-COMMANDS.md).
Use `eval-poc/wrangler.eval.jsonc` from the project root to publish only the
eval image with PostgreSQL inside the same container.

Keep `Dockerfile`, `cloudflare-entrypoint.sh`, `.dockerignore`, `worker.ts` and
`wrangler.eval.jsonc`. The shell entrypoint is part of the container's startup,
including database preparation and password synchronization.

Keep the complete project layout for Worker bundling. See
[the file inventory](../fresh-poc/WORKSPACE-FILES.md). The `*.test.ts` files and
test configuration support automated regression checks.
