---
name: tasra-handle-errors
description: Handle Tasra application failures, authorization refusals, cancellation and uncertain write outcomes. Use when deciding whether to reconcile, reauthorize, poll readiness or retry a safe read.
metadata:
  package: tasra-sdk
  sources:
    - docs/application-api.md
    - dist/app/client.d.ts
    - dist/app/creation.d.ts
    - dist/committee/dual-sign.d.ts
---

# Recover without duplicating operations

Classify the **operation and outcome**, not just an HTTP code. A timed-out write may
already have succeeded. Do not put creation, signing or approval submissions inside
a generic retry loop. `isRetryable` is useful for supported error types but does not
prove an operation is safe to repeat.

```ts
import {TasraApplicationError, CreationReconciliationRequiredError} from 'tasra-sdk/app'
import {OperationOutcomeUnknownError} from 'tasra-sdk/committee'
import {VerifierAgentSessionError} from 'tasra-sdk/oid4vp'

export function recoveryAction(error: unknown) {
  if (error instanceof CreationReconciliationRequiredError) return 'reconcile-transaction'
  if (error instanceof OperationOutcomeUnknownError) return 'reconcile-approval'
  if (error instanceof VerifierAgentSessionError && error.kind === 'refused') return 'show-refusal'
  if (error instanceof TasraApplicationError) {
    if (error.code === 'KEY_NOT_READY') return 'poll-readiness'
    if (error.code === 'SLOT_CHANGED') return 'review-and-reauthorize'
  }
  return 'inspect-error'
}
```

| Failure | Recovery |
|---|---|
| `CHAIN_MISMATCH`, `SLOT_NOT_FOUND`, `WRONG_SLOT_MODE`, `SLOT_CANCELLED` | Check the deployment and slot. Do not mutate the policy to make the call work. |
| `KEY_NOT_READY` | Poll anchored public metadata with a bounded deadline. Do not create another slot. |
| `SLOT_CHANGED` | Reload metadata, review the operation and obtain fresh authorization. For EVM accounts rebuild the adapter and verify the address. |
| `INVALID_AUTHORIZATION`, verifier `refused` | Surface the refusal; correct the credential, holder, scope or policy. No provider/JWT fallback. |
| `INVALID_RESULT` or receipt verification failure | Reject the result and retain public diagnostic references; do not weaken verification. |
| Missing creation transaction hash | Preserve the journal; reconcile the wallet submission before resume. |
| Ambiguous native approval POST | Use the saved request ID/coordinator/message/policy to inspect status. If the create ID was lost, retain that uncertainty. |
| User cancellation | Stop local polling; explain that already submitted transactions/approvals remain possible. |

Safe reads/status polling may use bounded retries and backoff. Preserve the exact
request when resuming. Do not cache a committee grant for another operation.
Signing timeouts require application-specific reconciliation; the SDK does not
promise exactly-once signing or automatically discover a lost request.

For existing `TasraError` subclasses, legacy sessions and per-node threshold
failures, read [advanced error contracts](references/advanced.md). Do not assume every
validation or transport error is a `TasraError`. Log correlation IDs and public
slot/transaction references; never log tokens, credential presentations or key material.
