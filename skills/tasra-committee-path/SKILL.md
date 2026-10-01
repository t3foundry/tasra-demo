---
name: tasra-committee-path
description: Use Tasra native FROST approval quorum or integrate request-bound committee operations. Use for two-person approval, dual-sign create/status/approve/resume, keeper receipts, and advanced compound-token consumers.
metadata:
  package: tasra-sdk
  sources:
    - docs/native-approvals.md
    - examples/credential-approvals.ts
    - dist/committee/dual-sign.d.ts
    - dist/committee/receipts.d.ts
---

# Request-bound operations and native approvals

For ordinary signing/decryption use typed slots from `tasra-sdk/app`; they validate
the exact-operation grant and anchored result. Reach for `tasra-sdk/committee`
when an existing application needs the lower-level contract, not simply because it
uses multiple keepers.

## One FROST signature after distinct people approve

Read `docs/native-approvals.md`. `examples/native-approvals.ts` uses registered
static approver keys; `examples/credential-approvals.ts` uses separate holder-bound
credential presentations. Both set the real slot policy before requesting approvals.

Use `setApprovalPolicy` to install the explicit policy with the creator wallet and
durable store. For static keys, adapt SDK Ed25519 identities with `identityApprover`:

```ts
import {setApprovalPolicy, identityApprover, type TasraClient,
  type TasraIdentity, type TasraWallet, type ApplicationStore} from 'tasra-sdk/app'

export async function startApproval(tasra: TasraClient, slotId: `0x${string}`,
  alice: TasraIdentity, bob: TasraIdentity, creator: TasraWallet,
  store: ApplicationStore, message: Uint8Array) {
  const signers = [identityApprover(alice), identityApprover(bob)]
  await setApprovalPolicy(tasra, slotId, {
    quorum: 2, approvers: signers.map(signer => signer.publicKey),
  }, {wallet: creator, store})
  const slot = await tasra.slots.frost(slotId)
  const approvals = await slot.approvals({quorum: 2, credentialGated: false})
  const request = await approvals.create(message)
  await store.save(`approval-${request.requestId}`, {requestId: request.requestId,
    coordinator: request.nodeUrl, slotId, message, quorum: 2, credentialGated: false})
  await request.approve({signer: signers[0]!})
  await request.approve({signer: signers[1]!})
  return request.wait({timeoutMs: 120_000})
}
```

For credential mode, install `{quorum: 2, credentialPolicy: rule}` instead, open
`slot.approvals({quorum: 2, credentialGated: true})`, and use
`approveWithCredential(tasra, request, message, {identity, authorize})` for each
holder. Obtain `authorize` with `tasra.credentials.authorize()` and that holder's
credential. The SDK computes the canonical payload digest and binds the approval
to this exact request. No application signing library or manual session glue is needed.

Keep the quorum and mode pinned independently of status responses. A credential
policy admitting Alice OR Bob does not itself require two approvals; the separate
native policy does. Keep private keys out of model-authored arguments and evidence.

Call `request.status()` or bounded `request.wait({timeoutMs, signal})` to observe
completion. The SDK verifies the final signature against the expected group key
and original message. Native approval quorum counts people/keys; the keeper
threshold counts cryptographic shares. Two separate document signatures are a
third workflow, explained by `tasra-sign-and-decrypt`.

## Recovery and evidence

Use `approvals.resume(saved.requestId, saved.message)` with the original coordinator
and pinned policy after a restart. On `OperationOutcomeUnknownError`, reconcile
status before any further submission. If a create request lost its ID, the current
API cannot discover it; report the uncertain outcome rather than creating another.
Cancellation stops local work and does not retract an accepted approval.

Optional operation receipts are not proof merely because they are present. Use
`verifyOperationReceipt` with authenticated keeper identity and the expected operation
references, or typed FROST/BLS handles that perform those checks. Native dual-sign
results do not guarantee an attested receipt on every deployment.

For existing compound-token, verifier discovery and direct committee integrations,
read [advanced committee operations](references/advanced.md). Direct credential
committee helpers do not replace request-bound wallet authorization on a deployment
that requires it. Native multi-approver IBE and task-context enforcement are unsupported.
