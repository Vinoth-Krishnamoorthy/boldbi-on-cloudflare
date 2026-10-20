# Bold BI on Cloudflare Containers

This repository contains two independent, standalone deployment options for running Syncfusion Bold BI on Cloudflare Containers (microVMs on Durable Objects).

There is **no shared Worker** and **no dependency** between the two options. Each folder is a self-contained project with its own Worker, configuration, Dockerfile(s), dependencies, and tests.

---

## Choose your deployment

| Deployment | Directory | Architecture | Best For |
|---|---|---|---|
| [**Normal Deployment**](fresh/DEPLOYMENT.md) | `fresh/` | Two separate containers (Bold BI + PostgreSQL 17) connected by an authenticated TCP-over-WebSocket tunnel. | Production-like setups, decoupled database, scalable architectures. |
| [**Evaluation Deployment**](eval/DEPLOYMENT.md) | `eval/` | Single container with Bold BI and PostgreSQL 15 bundled together. | Quick demos, feature testing, evaluations. Zero database networking to manage. |

---

## Quick start

### Normal Deployment (Separate PostgreSQL)
```powershell
Set-Location 'fresh'
npm install
# Edit wrangler.jsonc to set your account_id
# Configure secrets:
npx wrangler secret put POSTGRES_PASSWORD
npx wrangler secret put TUNNEL_TOKEN
# Deploy:
npm run deploy
```
See the [Fresh Deployment Guide](fresh/DEPLOYMENT.md) for full step-by-step instructions.

### Evaluation Deployment (Bundled PostgreSQL)
```powershell
Set-Location 'eval'
npm install
# Edit wrangler.jsonc to set your account_id
# Configure secrets:
npx wrangler secret put EVAL_DB_PASSWORD
npx wrangler secret put EVAL_ADMIN_PASSWORD
# Deploy:
npm run deploy
```
See the [Eval Deployment Guide](eval/DEPLOYMENT.md) for full step-by-step instructions.

---

## Repository Structure & File Purpose

```text
boldbi-on-cloudflare/
├── fresh/                      # Deployment option 1: Bold BI + separate PostgreSQL container
│   ├── DEPLOYMENT.md           # Step-by-step deployment guide & setup instructions
│   ├── wrangler.jsonc          # Cloudflare configuration (Worker name: boldbi-fresh, 2 containers)
│   ├── worker.ts               # Edge reverse proxy, HTTPS/CSP handler, and database WebSocket bridge
│   ├── Dockerfile.boldbi       # Bold BI container image with built-in tunnel-proxy client
│   ├── Dockerfile.postgres     # PostgreSQL 17 container image with built-in tunnel-proxy server
│   ├── proxy/                  # Lightweight Go proxy bridging TCP over authenticated WebSocket
│   │   ├── main.go             # Tunnel client & server implementation
│   │   ├── main_test.go        # Unit tests for WebSocket stream and proxy listeners
│   │   ├── go.mod              # Go module definition (boldbi/proxy)
│   │   └── go.sum              # Checksums for coder/websocket dependency
│   ├── worker.test.ts          # Vitest suite verifying edge routing, headers, CSP, and tunnel auth
│   ├── vitest.config.ts        # Vitest configuration for fresh/ test runner
│   ├── tsconfig.json           # TypeScript configuration with Workers runtime types
│   ├── package.json            # Node.js dependencies (@cloudflare/containers, vitest, wrangler)
│   ├── package-lock.json       # Deterministic dependency lockfile
│   ├── .dockerignore           # Excludes local files from container image build context
│   └── .gitignore              # Ignores node_modules, .wrangler, and local environment files
│
├── eval/                       # Deployment option 2: Bold BI Eval (single bundled container)
│   ├── DEPLOYMENT.md           # Step-by-step deployment guide & setup instructions
│   ├── wrangler.jsonc          # Cloudflare configuration (Worker name: boldbi-eval, 1 container)
│   ├── worker.ts               # Edge reverse proxy, readiness checks, HTTPS/CSP normalization
│   ├── Dockerfile              # Container image based on syncfusion/boldbi:17.1.30-eval
│   ├── cloudflare-entrypoint.sh # Container startup script: sets up microVM shm, starts PostgreSQL, syncs passwords
│   ├── worker.test.ts          # Vitest suite verifying HTTP readiness probing and edge security
│   ├── vitest.config.ts        # Vitest configuration for eval/ test runner
│   ├── tsconfig.json           # TypeScript configuration with Workers runtime types
│   ├── package.json            # Node.js dependencies (@cloudflare/containers, vitest, wrangler)
│   ├── package-lock.json       # Deterministic dependency lockfile
│   ├── .dockerignore           # Excludes local files from container image build context
│   └── .gitignore              # Ignores node_modules, .wrangler, and local environment files
│
└── README.md                   # Project overview, comparison table, and directory inventory
```
