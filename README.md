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
npx wrangler secret put POC_TUNNEL_TOKEN
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

## Repository Structure

```text
boldbi-on-cloudflare/
├── fresh/                  # Bold BI + separate PostgreSQL container
│   ├── wrangler.jsonc      # Worker configuration (name: boldbi-fresh)
│   ├── worker.ts           # Worker routing and tunnel bridge
│   ├── Dockerfile.boldbi   # Bold BI container image
│   ├── Dockerfile.postgres # PostgreSQL 17 container image
│   ├── proxy/              # Go TCP-over-WebSocket tunnel proxy
│   ├── package.json        # Dependencies and scripts
│   └── DEPLOYMENT.md       # Step-by-step deployment guide
│
├── eval/                   # Bold BI Eval (bundled PostgreSQL)
│   ├── wrangler.jsonc      # Worker configuration (name: boldbi-eval)
│   ├── worker.ts           # Worker routing and header normalizer
│   ├── Dockerfile          # Bundled eval image (syncfusion/boldbi:17.1.30-eval)
│   ├── cloudflare-entrypoint.sh # MicroVM startup wrapper
│   ├── package.json        # Dependencies and scripts
│   └── DEPLOYMENT.md       # Step-by-step deployment guide
│
└── README.md               # This directory selector
```
