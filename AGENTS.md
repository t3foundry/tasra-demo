# Tasra Sign

Local demo of threshold (FROST) document signing built on `tasra-sdk`, running on
Avalanche Fuji C-Chain (chainId 43113). Two parties (Alice, Bob) each sign a PDF;
signatures are anchored to on-chain key slots and verified against a verifier agent.

## Layout

- `server/` — Node HTTP server (Hono + `@hono/node-server`), binds `127.0.0.1` only. Entrypoint `server/index.ts`; routes in `server/app.ts`; signing workflow state machine in `server/workflow.ts`. Default port 4177 (`PORT` env, must be >= 1024).
- `web/` — React 19 + Vite frontend. Vite dev server on 5173 proxies `/api` to 4177. In production the server serves `web/dist` directly.
- `shared/` — `model.ts` (manifest/proof types, `statement()`/`digest()`/`verifyBundle`) and `wallet.ts` (browser-side credential presentation). Imported by **both** server and web.
- `scripts/copy-pdf-assets.mjs` — copies pdfjs-dist worker/fonts/wasm into `web/public/pdf-assets` (PostInstall hook).

## Commands

Order matters: `setup` must run before `serve`/`dev` (server refuses to start without
`server/.tasra/service.json`).

- `npm run setup` — provisions signer slots, funds them with TSRA, writes wallets. Requires the printed creator address to hold >= 0.05 AVAX from the Fuji faucet; re-runs reuse saved state.
- `npm run dev` — `tsx watch` server + Vite web concurrently.
- `npm run serve` — runs server only (serves the built bundle; build first).
- `npm run build` — `typecheck` then `vite build`.
- `npm run typecheck` — two separate `tsc -p` projects (server, web); no `--noEmit` on web needed. There is **no ESLint/Prettier** config in the repo.
- `npm test` — `node --import tsx --test server/workflow.test.ts` (built-in `node:test`, no framework). Tests are fully offline: fake backend + `tmpdir` stores.
- `npm run fund-slot -- <state-dir> status|buy|fund|mint-test-eurc [amount] [min] [--slot 0x...]`
- `npm run verify -- document.pdf expected-request.json signatures.json`

Node >= 22.12 is required (see `engines`).

## State & environment

- All mutable state lives in `server/.tasra/` (git-ignored), overridable with `TASRA_SIGN_DATA`. Holds `service.json`, `setup.json`, `wallets/{alice,bob}.json`, `requests/`, and SDK operation journals under `sdk/`.
- A **single-writer lock** (`writer.lock` containing a PID) prevents two processes from touching the same state directory. Run tests/scripts against separate state dirs.
- To sign, import `server/.tasra/wallets/alice.json` and `bob.json` into separate browser contexts (e.g. `http://127.0.0.1:4177/#sender=<token>` for the sender console).

## Non-obvious rules

- The network manifest is downloaded once, checksum-pinned (`server/network.json` + `network-pin.json`), and `assertSameNetwork()` rejects any state whose network identity changed. Coordinator selection is the explicit app setting `lowest-operator-id` in `network.ts`. Do not regenerate `network.json` casually.
- **Never blindly retry an uncertain signing outcome.** The workflow (`workflow.ts`) marks post-submission failures as `phase: 'uncertain'` (requires reconciliation) rather than re-signing, because an on-chain signature may already exist. Only credential refusals (`AuthorizationRefused`) are safe to retry.
- PDF preview uses `pdfjs-dist@6.3.289` (pinned). If `web/public/pdf-assets/` is missing, run `npm run copy:pdf-assets`.
- Shared code is pulled into each tsconfig via `include` (`../shared`), not a build step; keep `shared/` dependency-free of Node/DOM-specific APIs.

## Tasra skills

This repo ships project-local OpenCode skills under `.agent/skills/` (wired via `opencode.json`).
Load `tasra-getting-started` first; use the others (`tasra-sign-and-decrypt`,
`tasra-create-slot`, `tasra-handle-errors`, etc.) for specific Tasra operations.
