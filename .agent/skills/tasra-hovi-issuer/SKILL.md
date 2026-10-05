---
name: tasra-hovi-issuer
description: Integrate an explicitly selected Hovi issuer or wallet with Tasra credentials. Use for Hovi Studio, Hovi credential templates or Hovi issuance APIs; local SDK examples can issue development credentials without Hovi.
metadata:
  package: tasra-sdk
  sources:
    - docs/api.md
    - dist/oid4vp/oid4vci.d.ts
    - examples/encrypted-notes.ts
---

# Optional Hovi issuer integration

Use this skill when Hovi is the chosen external issuer or wallet. It is not a
prerequisite for the modern SDK path. For local development, use `tasra.identities.create()` and `tasra.credentials.issue()`
with a generated issuer and separate bound holders, as shown in
`examples/encrypted-notes.ts` and `tasra-oid4vp-wallet-and-verifier-agent`.
That path needs no cloud trial, external account, private operator script or
pre-existing credential.

For Hovi integration, read [the recorded integration procedure](references/advanced.md).
It contains account observations from September 2026, not guarantees about today's
plan limits or endpoints. Verify the relevant official Hovi documentation and
current account capabilities before choosing a paid plan or calling its API.
Do not create external accounts or send issuance requests merely because this
skill is loaded; those actions must belong to the user's requested integration.

Use the issuer DID and credential type actually issued to construct the DCQL rule.
Receive an offer through `receiveCredential` from `tasra-sdk/oid4vp` with the holder
that will later present it. Keep issuer secrets in the issuer service and holder
keys in the wallet. Inspect the issued credential's `cnf` binding before presenting.

The relying application still uses a request-bound authorizer and typed slot
operations; an external issuer does not change the SDK application flow. Check the
deployment's DID resolution, signature algorithm and credential-format support.
Report issuer enrollment and live Tasra authorization as separate verified steps.
