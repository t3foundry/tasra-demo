---
name: tasra-dcql-rules
description: Define and validate Tasra credential access rules, including issuer/subject restrictions and IBE identity scopes. Use for DCQL policy design, rule commitments, credential alternatives or explicitly requested OAuth rules.
metadata:
  package: tasra-sdk
  sources:
    - docs/application-api.md
    - examples/encrypted-notes.ts
    - dist/auth/oid4vp.d.ts
    - dist/chain/write.d.ts
---

# Write the slot's credential rule

Build the policy with `tasra.credentials.policy()` before `tasra.slots.create()`. The slot stores a salted commitment, not
the rule itself; preserve the exact rule and salts in the creation journal and
provision it with the creator's signature. Existing slots cannot generally be
changed without their configured amendment policy.

```ts
import {credentialPolicy} from 'tasra-sdk/app'

export function sharedSignerRule(issuerDid: string, aliceDid: string, bobDid: string) {
  return credentialPolicy({issuer: issuerDid, type: 'TreasurySigner',
    subjects: [aliceDid, bobDid], claims: {role: ['treasury-signer']}})
}
```

This admits **Alice OR Bob** with a matching issuer/type/role. It does not require
two people to approve. Use signer-specific rules on two slots for two detached
document signatures, or a native FROST approval policy for one quorum-approved
signature. `tasra-sign-and-decrypt` and `tasra-committee-path` explain that choice.

For IBE, pass `identityScope: {claim: 'documents', namespace: 'issuer'}` to
`tasra.credentials.policy()` and issue credentials with a `documents` claim
containing the allowed identities. The SDK writes the required scope declarations. `examples/encrypted-notes.ts` shows the complete
issuer-rooted scope and credential. Exact `p` does not grant `p/x`; use `p/*` only
when a whole subtree is intended. Evaluate identity scopes with
`evaluateIdentityScoped`, not plain `evaluateDcql`.

Every credential query requires an `iss` constraint. Pin trusted issuers rather
than accidentally accepting any issuer. SD-JWT paths are top-level (for example
`sub`); JWT-VC subject claims have a different nesting. Local validation checks
shape and matching, not signature trust, holder binding or server acceptance.

Multiple credential requirements in one presentation are not independent human
approvals. Credential alternatives use `credential_sets`. Rules have a byte-size
limit; check the installed `DCQL_MAX_RULE_LEN` rather than character count.

For detailed matching semantics, JWT-VC or OAuth/DPoP rules and commitment helpers,
read [advanced policy formats](references/advanced.md). Cross-language conformance
requires separate evidence; it is not implied by local validation.
