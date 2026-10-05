---
name: tasra-oid4vp-wallet-and-verifier-agent
description: Connect an application authorizer to a credential wallet or issue local development credentials. Use for registered verifier agents, OID4VP presentations, SD-JWT holder binding, OID4VCI receiving or an explicitly requested OAuth/DPoP integration.
metadata:
  package: tasra-sdk
  sources:
    - docs/application-api.md
    - dist/app/authorization.d.ts
    - dist/oid4vp/index.d.ts
    - examples/encrypted-notes.ts
---

# Connect the application to a credential wallet

For new applications, return an `OperationAuthorizer` and let typed slots
supply the exact operation. Select and approve the verifier-agent provider before
sending it a presentation. An arbitrary URL or a service listed in a manifest is
not, on its own, proof of registry approval.

For an application holding a development credential, use
`tasra.credentials.authorize({verifierAgentUrl, signer, identity, credentials})`.
The SDK handles the bound session, presentation and proof collection. For a browser
wallet presenting to an existing request, use
`tasra.credentials.present(requestUri, identity, credentials, {choose})` and obtain
user consent in `choose` before disclosing the selected credential.

For an independently approved registered provider or separate wallet application,
`registeredWalletAuthorization({client, signer, present})` remains available. The
`present(session, signal)` callback displays the selected QR/deep link or runs the
wallet. Preserve authenticated provider and operation binding; a timeout or refusal
must not redirect a presentation to a fallback provider.

## Local development without an issuer account

Read `examples/encrypted-notes.ts`, `examples/shared-account.ts` and their visible
`tutorial-support.ts` helper. `tasra.identities.create()` creates fresh issuer and
holder identities; `tasra.credentials.issue({issuer, holder, type, claims})` binds
each credential to its holder. `tasra.credentials.authorize()` uses the configured
local verifier. This endpoint example does not establish production provider approval.

Tokens are compound objects, not bearer JWT strings. A credential must be presented
by its bound holder; generating a different key at presentation time will fail.
The high-level authorizer preserves exact operation inputs and membership proofs.
For native approvals, use `approveWithCredential` to compute and bind the canonical
payload; manual digest/session construction is only an advanced integration choice.

| Action | Exact operation input |
|---|---|
| `sign` | Message bytes; for ECDSA this is the 32-byte digest requested by the adapter |
| `ibe-extract` | Identity string; do not pass a signing message |
| `dual-approve` | SHA-256 of the SDK's canonical approval payload for slot/message/request ID |
| Advanced `decrypt` | `decryptPayloadDigest(u, aeadCt)` |

The creator/delegate's operation-signing key, credential issuer key, holder key
and threshold slot key have distinct roles. Keep them separate. The relying app
receives authorization; a real user's holder secrets remain in the wallet context.
Synthetic tutorial credentials are not a production identity-enrollment scheme.

## Wallet and issuer implementation details

For receiving credentials, SD-JWT disclosure selection, DID resolution, TLS trust,
issuer APIs, or explicitly requested OAuth/DPoP flows, read
[wallet, issuer and verifier-agent details](references/advanced.md) and the installed
declarations. Those specialized flows remain supported; OAuth is not a legacy
`SessionAuth` mode. `tasra-hovi-issuer` is optional and only relevant when Hovi is chosen.

A local filter rejecting a credential is good wallet behavior, but server refusal
acceptance must deliberately reach the verifier as shown by the complete examples.
