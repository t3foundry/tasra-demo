# Tasra Sign

A local demo of threshold (FROST) document signing and identity-based document
encryption built on [`tasra-sdk`](https://www.npmjs.com/package/tasra-sdk), running on
Avalanche Fuji C-Chain (chainId `43113`). Two or more parties review and approve a PDF;
their signatures are anchored to on-chain key slots and verified against a credential
verifier agent, so approval is gated by verifiable credentials (OID4VP).

## Features

### Document signing
- **Threshold FROST signatures** anchored to on-chain key slots. Each signer's approval
  resolves to a FROST signature whose public key is a registered Tasra slot.
- **Credential-gated approvals.** Signers authorize via OpenID4VP: the app opens a
  verifier-agent session, the wallet presents a `DocumentSigner` verifiable credential
  (SD-JWT), and only a valid, holder-bound presentation produces a signature.
- **Two signing paths.** Approve from a demo wallet stored in the browser, or generate a
  QR code / session URL for a remote wallet to scan.
- **Decline support.** A signer can cryptographically refuse a document, closing the request.
- **Reconciliation-first safety.** Post-submission failures are marked `uncertain` rather
  than silently retried, so an on-chain signature is never forged twice. Only credential
  refusals are safe to retry.
- **Offline-verifiable bundles.** Completed requests export `document.pdf`,
  `request.json`, and `signatures.json` (individually or as a zip), verifiable without
  contacting the network.

### Document encryption
- **BLS identity-encryption key slots** created and funded on-demand on the Fuji testnet.
- **Identity-scoped encryption** under a deterministic issuer DID, bound to a key name and
  document version.
- **Credential-controlled decryption.** A `DocumentReader` credential authorizes threshold
  extraction via a QR-scanned verifier-agent session.

### OpenID4VCI issuer
The app doubles as a minimal OID4VCI issuer (`.well-known/openid-credential-issuer`,
`/token`, `/nonce`, `/credential`), issuing `DocumentSigner` and `DocumentReader` SD-JWTs
to remote wallets.

### Verifier
An upload / zip endpoint (`/api/verify`, `/api/verify-zip`) re-checks FROST signatures and
signer-key epoch against current on-chain state.

## Architecture

| Directory | Purpose |
|-----------|---------|
| `server/` | Node HTTP server (Hono + `@hono/node-server`). Entrypoint `server/index.ts`, routes in `server/app.ts`, signing state machine in `server/workflow.ts`. |
| `web/`    | React 19 + Vite frontend. Proxies `/api` to the server in development; the server serves `web/dist` in production. |
| `shared/` | `model.ts` (manifest/proof types, `statement()`/`digest()`/`verifyBundle`) and `wallet.ts` (browser-side credential presentation). Imported by both server and web. |
| `scripts/`| `copy-pdf-assets.mjs` copies pdfjs-dist workers/fonts/wasm into the web bundle. |

All mutable state lives in `server/.tasra/` (git-ignored): `service.json`, `setup.json`,
`wallets/`, `requests/`, and SDK operation journals. A single-writer lock prevents two
processes from touching the same state directory.

## Prerequisites

- **Node.js `>= 22.12`** (see `engines`).
- An **Avalanche Fuji C-Chain address funded with `>= 0.05 AVAX`** (from the [Fuji faucet](https://core.app/tools/testnet-faucet/?subnet=c&tokenType=AVAX)).
- `npm` (dependencies install via `npm install`).

## Setup

```bash
# 1. Install dependencies (runs the postinstall hook that copies pdfjs assets)
npm install

# 2. Provide your funded creator key and issuer seed
cp .env.example .env
#    TASRA_CREATOR_KEY  = 0x… (64 hex chars)  — your funded Fuji address's private key
#    TASRA_ISSUER_SEED  = 0x… (64 hex chars)  — identity signing seed (generate fresh if unsure)

# 3. Provision signer/encryption state, fund slots with TSRA, and write wallets
npm run setup
```

`npm run setup` checks network readiness, funds the slots with TSRA, and writes
`service.json`, `setup.json`, wallets, and public metadata. If you don't already have a
funded account, leave the env vars empty: `setup` generates fresh keys and prints the
creator address to fund (then re-run after funding). Re-runs reuse saved state and are
idempotent.

> The server refuses to start without `server/.tasra/service.json`.

## Running

```bash
# Development: tsx watch server + Vite web (proxies /api to :4177)
npm run dev

# Production-style single process: build first, then serve web/dist itself
npm run build
npm run serve
```

- Server binds `127.0.0.1` by default and prints a private **sender console** URL:
  `http://127.0.0.1:4177/#sender=<token>`.
- The public Vite app runs at `http://127.0.0.1:5173` during `npm run dev`.

### Using it

1. Open the sender console link printed by the server.
2. Create key/signer slots (and optionally a remote signer), then upload a PDF and choose the
   signers from the registry.
3. Each signer opens their workspace (`/#<person>` link), reviews the PDF, and approves (or
   declines) with their wallet credential.
4. Once every signer has approved, download the verified bundle.

## Commands

| Command | Description |
|---------|-------------|
| `npm run setup` | Provision slots, fund with TSRA, write wallets & service state. |
| `npm run dev` | Run server + web with hot reload. |
| `npm run serve` | Run the server only (serves the built bundle). |
| `npm run build` | `typecheck` then `vite build`. |
| `npm run typecheck` | Two `tsc -p` projects (server, web). |
| `npm test` | Offline workflow tests (`node:test`, fake backend + tempdir stores). |
| `npm run fund-slot -- <state-dir> status\|buy\|fund\|mint-test-eurc [amount] [min] [--slot 0x…]` | Inspect/fund a slot and mint test EURC. |
| `npm run verify -- document.pdf expected-request.json signatures.json` | Verify a saved bundle offline. |
| `npm run hooks:install` | Point git at the repo's committed hooks (also run automatically on `npm install`). |

## Git hooks

A `pre-commit` hook (`.git-hooks/pre-commit`) bumps the `package.json`/`package-lock.json`
patch version and stages the change so it ships inside the commit. It bumps **once per batch
of work** — only when `HEAD` still carries the remote's version — so a multi-commit push
increments the version a single time. It no-ops on the first push (no `@{upstream}` yet).

The bump lives in `pre-commit` rather than `pre-push` because Git snapshots the refs to push
*before* running `pre-push`, so a bump made there can never be included in the current push.

## Configuration

| Env var | Required | Description |
|---------|----------|-------------|
| `TASRA_CREATOR_KEY` | yes (via setup) | Private key of the funded Fuji C-Chain address (`>= 0.05 AVAX`). |
| `TASRA_ISSUER_SEED` | yes (via setup) | Identity signing seed (`0x`-prefixed 64 hex chars). |
| `TASRA_SENDER_TOKEN` | no | Private sender-console bearer token (generated if omitted). |
| `PUBLIC_ORIGIN` | only for HTTPS deployments | Public origin advertised in credential offers/QR. |
| `TRUST_PROXY` | no | Set to `1` when a trusted proxy sets `X-Forwarded-*`. |
| `PORT` / `HOST` | no | Server bind port/host (defaults `4177` / `127.0.0.1`). |

## Docker

A multi-stage `Dockerfile` builds the React bundle, then runs the server via `tsx` with
state stored at `/data`. `docker-compose.yml` provides a deployment reference:

```bash
cp .env.example .env   # fill in real values
docker compose up -d
```

On first start the container runs `npm run setup` (idempotent), then serves the app on
port `4177`. Set `PUBLIC_ORIGIN` (or `TRUST_PROXY=1`) when fronted by a TLS-terminating
proxy.

## Non-obvious rules

- **Checksum-pinned network manifest.** `server/network.json` is pinned by
  `network-pin.json`; `assertSameNetwork()` rejects state whose network identity changed.
  Do not regenerate `network.json` casually.
- **Never blindly retry an uncertain signing outcome.** Post-submission failures become
  `phase: 'uncertain'` (reconciliation required), not re-signs. Only `AuthorizationRefused`
  is safe to retry.
- **PDF preview** uses pinned `pdfjs-dist@6.3.289`; if `web/public/pdf-assets/` is missing,
  run `npm run copy:pdf-assets`.
- **Shared code** is environment-agnostic; keep `shared/` free of Node/DOM-specific APIs.