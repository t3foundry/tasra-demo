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

## Encrypted-text schema (`tasra-encrypt/v2`)

Every encrypted text persisted by this application uses one fixed JSON bundle
shape, `tasra-encrypt/v2`. Reuse this exact schema for all encrypted texts; do not
invent per-record variants. The `manifest` identifies the record and pins the
encryption slot; the `envelope` carries the wrapped data key and the AES ciphertext.
Field order is stable and must not be reordered by serialization.

```json
{
  "manifest": {
    "schema": "tasra-encrypt/v2",
    "recordId": "1e833e64-1bbc-4c39-8ddf-b5c798ae28e2",
    "title": "test",
    "version": 1,
    "documentSha256": "a9a051703f6bdda791e55419828da90f6bb83919eaf7f68b669ddf49c6c81ce1",
    "chainId": 43113,
    "keyRegistry": "0x45F432aB5709e9920b5ec349D29663D7200A8C39",
    "slotId": "0x5e5d9e496462f4e7786ad7da7c1d19b6b213a945be75f8aa67724aebe58c69e8"
  },
  "envelope": {
    "encryptedAesKey": "<base64 group-key KEM envelope>",
    "aesCiphertext": "<base64 AES-256-GCM ciphertext>",
    "epoch": 0
  }
}
```

Field rules for `manifest`:

- `schema` — always the literal `"tasra-encrypt/v2"`.
- `recordId` — a UUID string; the stable local identifier for this record.
- `title` — short human label; non-empty, limited length.
- `version` — positive integer, bumped on update (`>= 1`).
- `documentSha256` — lowercase 64-hex SHA-256 of the original plaintext bytes.
- `chainId` — positive integer (43113 on Fuji C-Chain).
- `keyRegistry` — `0x`-prefixed 40-hex address of the KeyRegistry contract.
- `slotId` — `0x`-prefixed 64-hex bytes32 identifier of the BLS slot whose group
  key wrapped the data key. This is the same slotId every decrypt authorization
  must present against.

Field rules for `envelope`:

- `encryptedAesKey` — standard base64 of `toBytes(GroupEnvelope)`: the group-key
  KEM output wrapping the compact JWT `{ aesKey, aesNonce }`. Decode with
  `fromBytes`, then unwrap through the keeper committee (`committeeDecrypt`).
- `aesCiphertext` — standard base64 of the AES-256-GCM plaintext output (the
  encrypted text bytes). Decrypt with the unwrapped `aesKey`/`aesNonce`, binding
  the document's SHA-256 hex string as AAD.
- `epoch` — integer slot epoch the key was wrapped under; used when the KEM
  envelope does not carry its own epoch.

This is a hybrid scheme, not raw IBE: everyone who holds the same `DocumentReader`
credential for `key` can unwrap the group key (whole-group decrypt), so
`identityScope` is intentionally absent from the manifest. The base64 fields use
standard alphabet **with** padding, unlike the base64url already inside the
compact JWT.
