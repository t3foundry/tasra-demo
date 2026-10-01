---
name: tasra-getting-started
description: Build a TypeScript application with the installed Tasra SDK. Use for initial setup, choosing a slot API, locating deployment manifests, or selecting a complete signing or encryption tutorial.
metadata:
  package: tasra-sdk
  sources:
    - docs/application-api.md
    - docs/compatibility.md
    - docs/shared-account.md
    - dist/app/index.d.ts
---

# Start a Tasra application

Use `tasra-sdk/app` for new credential-controlled applications. Keep existing
advanced clients when their capabilities are required; there is no client-count
limit or forced migration.

## Install and establish the environment

1. Install with `npm install tasra-sdk@latest`. Inspect
   `node_modules/tasra-sdk/package.json`, record its resolved version and probe the
   required exports. Keep the lockfile for reproducibility. Use Node 24 and ESM.
   The application runtime needs only `tasra-sdk`; TypeScript, tsx and Node types
   are development tooling.
2. Download the selected network pointer and manifest from
   https://github.com/t3-foundry/tasra-releases. For testnet, read
   `networks/testnet/current.json` and resolve its `manifest` path relative to
   `networks/testnet/`. Fetch both at one reviewed commit and verify the original
   manifest bytes against the pointer's trusted SHA-256.
3. Load that release manifest with `TasraClient.fromManifest(url, {sha256, coordinator})`
   or pass the verified object to the constructor with an explicit coordinator
   convention. The convention must match the deployment; the release schema does
   not record it. Do not invent missing service URLs or copy private configuration.
4. Check the required modes, thresholds, issuer formats and operation routes.
   `check()` only checks chain and registries. Keep TLS verification enabled.
   Generate and save the application's creator key, then fund its public address
   through the network's faucet or a wallet controlled by the user. Network writes
   require authorization for their actual effects and funding source.

Paths beginning `docs/`, `examples/` or `dist/` in these skills are relative to the
**installed SDK package**, even after the skill folder is copied into `.agents/skills`.
Relative Markdown links to `references/` stay inside the copied skill folder.

## Write the application

```ts
import {TasraClient, type ApplicationManifest} from 'tasra-sdk/app'

export async function readAccount(manifest: ApplicationManifest, slotId: `0x${string}`) {
  const tasra = new TasraClient({manifest, coordinator: 'lowest-operator-id'})
  const health = await tasra.check()
  if (!health.ready) throw new Error('Configured registries are unavailable')
  const account = await tasra.slots.ecdsa(slotId)
  return account.getAddress()
}
```

`check()` probes chain ID and registry code presence, not issuer or keeper readiness.
Slot handles check mode/readiness. Address lookup and public-key encryption need no
credentials. Create identities, issue credentials and build policy with
`tasra.identities.create`, `tasra.credentials.issue` and `tasra.credentials.policy`.
Create ready slots with `tasra.slots.create`; obtain per-operation authorization with
`tasra.credentials.authorize`. Use `tasra.wallets.fromSlot` for Ethereum transfers.

| Developer task | Skill | Complete installed source / lesson |
|---|---|---|
| Alice OR Bob signs an Ethereum transaction | `tasra-sign-and-decrypt` | `examples/shared-account.ts`, `docs/shared-account.md` |
| Encrypt notes for one credential holder | `tasra-ibe-identity-scoped` | `examples/encrypted-notes.ts`, `docs/encrypted-notes.md` |
| Alice AND Bob sign the same document separately | `tasra-sign-and-decrypt` | `examples/document-signing/`, `docs/document-signing.md` |
| Two approvals produce one FROST signature | `tasra-committee-path` | `examples/credential-approvals.ts`, `docs/native-approvals.md` |
| Create, provision or recover a slot | `tasra-create-slot` | `docs/application-api.md` |
| Add a wallet or issue development credentials | `tasra-oid4vp-wallet-and-verifier-agent` | `docs/application-api.md` |
| Discover registries, keepers or events | `tasra-chain` | `docs/chain.md` |
| Handle refusal, cancellation or uncertain writes | `tasra-handle-errors` | `docs/application-api.md` |

Read the chosen complete source before modifying it. Examples run as visible
TypeScript applications with the installed SDK; do not replace them with a hidden
helper script. The document lesson includes a persistent web app with separate signer wallets;
`examples/document-signing.ts` is its smaller terminal companion.

For a standalone Node app, `docs/installation.md` supplies the complete strict
NodeNext `tsconfig.json`, including `types: ["node"]`, and the typecheck command.

## Prove the result

Run the app in a fresh ESM project using only the installed package and its public
configuration. The lesson gives exact copy/install/run commands. Record package
integrity, network identity, slot/transaction IDs and verified results; keep keys,
credentials, grants and private creation journals out of public evidence.

A refusal test must reach the verifier; local credential filtering is not evidence
of server refusal. Re-running after a failed submission requires reconciliation,
not automatic creation of another slot. Native multi-approver IBE, full task-context
enforcement and independent per-share certificates remain upstream work.
