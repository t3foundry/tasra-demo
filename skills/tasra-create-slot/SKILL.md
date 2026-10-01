---
name: tasra-create-slot
description: Create and provision a Tasra slot using a durable creation journal; resume known transactions and reconcile uncertain submissions. Also covers advanced funding, relay and lifecycle operations when requested.
metadata:
  package: tasra-sdk
  sources:
    - docs/application-api.md
    - examples/encrypted-notes.ts
    - dist/app/creation.d.ts
    - dist/chain/write.d.ts
---

# Create and recover a slot

Use `TasraClient` from a checksum-verified manifest downloaded from
https://github.com/t3-foundry/tasra-releases, SDK wallets and `slots.create` for new
applications. Install only `tasra-sdk` as the runtime dependency. Before writing,
confirm deployment compatibility and obtain authorization for the live effects.

```ts
import {TasraClient, type ApplicationManifest, type TasraWallet} from 'tasra-sdk/app'
import {createFileStore} from 'tasra-sdk/app/node'

export async function createKey(manifest: ApplicationManifest, wallet: TasraWallet,
  policy: string, directory: string) {
  const store = createFileStore(directory)
  const tasra = new TasraClient({manifest, coordinator: 'lowest-operator-id', wallet, store})
  return tasra.slots.create({name: 'private-notes', mode: 'bls', policy,
    threshold: {k: 2, n: 3}, verifiers: {committee: 3, quorum: 2}})
}
```

Choose `ecdsa` for an Ethereum account, `frost` for document signatures or `bls`
for encryption. Build the policy first with `tasra.credentials.policy()`, pinning
the issuer, subjects and any identity scope. A keeper threshold counts shares,
not human approvals. The application slot name identifies a durable creation intent.

`authType` defaults to `'oid4vp'`. For an OAuth/BYOIDP policy, set
`authType: 'oauth'` explicitly and use DCQL queries with
`format: 'oauth+access-token+dpop'`; pin issuer, audience and maximum token age.
The SDK rejects a policy whose query family disagrees with the selected type.
OAuth DCQL is canonicalized for the commitment just like credential DCQL.
`credentials.authorize` is an OID4VP helper; OAuth operations use
`createOauthSession`, `submitOauthResponse` and `waitForSession` from
`tasra-sdk/verifier-agent` with the IdP token and its bound DPoP signer.

`slots.create` persists that intent before submission, commits/reveals, waits for
the on-chain key, provisions the exact policy to assigned keepers and sets the
requested verifier policy. It returns a ready typed slot. Do not copy those steps
into the application or manually construct a journal. `createFileStore` is the
Node adapter; browser stores need equivalent atomic persistence and exclusive locks.

Create a fresh wallet with `tasra.wallets.create()` or connect the user's provider
with `tasra.wallets.connect(provider)`. Persist a local wallet's exported private
key securely before funding it. A wallet is not funded merely because it exists.
Fund the creator through the selected network’s faucet or a wallet controlled by
the user. Native gas, slot-account balance and usage credits are separate. Check
each required balance; do not assume the deployment supplies credits. Configure
native approval policy separately when the application needs human approvals.

Read `docs/application-api.md` and run `examples/encrypted-notes.ts` or
`examples/document-signing.ts` using their exact tutorial commands. They create
fresh identities, credentials and slots using only public deployment configuration.
The tutorials create a fresh run directory each time; this demonstrates independent
runs, not automatic recovery of an interrupted earlier run.

## Resume the same intent

Restore the same wallet, store, manifest and exact named request, then call
`slots.create` again. Known transaction hashes are reconciled. Preserve private
journals, salts and policy bytes; never publish them as evidence. An unknown
submission without a recorded hash requires wallet/chain reconciliation before
resuming. Do not delete state or generate another slot to hide uncertainty.

Automatic recovery of an expired named commitment or abandoned file-store lock is
not provided. Stop, preserve state and reconcile with the deployment operator; do not steal a lock automatically. Aborting local work cannot cancel a
transaction already submitted to the chain.

## Advanced operations

Low-level creation and `provisionRule` take `rule`, the clear policy string,
plus its `ruleSalt`; the chain stores only `ruleCommitment`. `dcqlRule` is
rejected, even when supplied alongside an identical `rule`. Keeper HTTP fields
remain `dcql_rule` and `dcql_salt`; those are transport fields, not SDK aliases.
Older creation journals also require explicit migration: privately back up the
journal, rename only `intent.dcqlRule` to `intent.rule`, and preserve every value,
including rule bytes, salts, slot ID, creator, authorization type and transaction
history. Resolve ambiguous or conflicting fields before resuming. Keep surrounding
application-store state intact; do not delete a journal or create a new slot to
bypass rejection.

`prepareSlot` and `createPreparedSlot` remain available when implementing custom
creation lifecycle control. Those primitives end at on-chain creation; their caller
must handle key readiness, provisioning and verifier policy. They are not needed
for the default application path. For relay/sponsorship, funding curves, rotation,
cancellation or lower-level creation, read
[advanced lifecycle and compatibility details](references/advanced.md).
