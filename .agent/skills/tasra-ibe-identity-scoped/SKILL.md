---
name: tasra-ibe-identity-scoped
description: Encrypt and decrypt identity-scoped data with typed BLS slots, or use strict IBE extraction in an existing integration. Use for encrypted notes, private records, identity capabilities, share provenance and large encrypted objects.
metadata:
  package: tasra-sdk
  sources:
    - docs/encrypted-notes.md
    - docs/application-api.md
    - dist/app/client.d.ts
    - dist/committee/extraction.d.ts
---

# Encrypt data for an identity

Use the `tasra-sdk/app` BLS handle. An identity is an exact application
scope such as `<issuer-did>/notes/<record-id>/version/1`; choose it before issuing
the credential. With the issuer namespace, the first segment must be the granting
issuer DID. Build the rule with `tasra.credentials.policy({issuer, type: 'DocumentReader',
subjects: [alice.did], identityScope: {claim: 'documents'}})`. Issue Alice's
credential with `claims: {documents: [identity]}` using `tasra.credentials.issue()`.
The SDK adds the required scope declarations to the policy.

```ts
import type {TasraClient, OperationAuthorizer} from 'tasra-sdk/app'

export async function notesRoundTrip(
  tasra: TasraClient, slotId: `0x${string}`, identity: string,
  plaintext: Uint8Array, authorize: OperationAuthorizer,
) {
  const slot = await tasra.slots.bls(slotId)
  const ciphertext = await slot.encrypt(identity, plaintext) // public operation
  return slot.decrypt(identity, ciphertext, {authorize, requireReceipts: true})
}
```

Encryption requires the public group key, not a credential. Decryption authorizes
this exact identity, validates slot stability and combines sufficient unique keeper
results against the anchored group key. `requireReceipts` refuses an absent or
invalid keeper receipt. The result contains `plaintext: Uint8Array`, `evidence`
and `shareTrust`. Clear the plaintext buffer when your application is done with it.

Read and run `examples/encrypted-notes.ts` using `docs/encrypted-notes.md`. It creates
a fresh BLS slot, grants Alice the exact identity, verifies decryption, deliberately
presents Bob to the verifier and checks ciphertext tampering. Wallet filtering alone
does not prove a server refusal. Retain only public evidence outside private state.

## Integrating an existing application

`extractIdentityStrict` and `decryptIdentityStrict` from `tasra-sdk/committee`
accept an independently anchored group key, expected slot/epoch/threshold and
assigned operator identities/public keys. Supply the operation's token and verifier
membership proofs; do not rebuild collection/combination around untrusted response data.

Two assurance modes have different requirements:

- `anchored-group` verifies the combined identity key against the trusted group key.
  This is the application handle's mode. It does not independently authenticate each
  keeper's polynomial verifying share.
- `pinned-shares` additionally needs verifying shares/identifiers from an independent
  trusted source. A share returned alongside its own extraction response is not that source.

Use `slot.extractIdentity` only when the app needs custody of the returned identity
key. It remains a durable capability after the grant expires; revoking credentials
does not erase an already extracted key. Minimize its lifetime and clear owned
buffers when done. Choose narrow versioned scopes rather than promising retroactive revocation.

For blob streaming, offline cryptographic tests and existing legacy integrations,
read [advanced IBE operations](references/advanced.md). The current application
path does not require those low-level steps. Native multi-approver extraction and
independent per-keeper share certificates remain upstream dependencies.
