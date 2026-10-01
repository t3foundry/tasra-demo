# Advanced and compatibility reference

Read this only for a task explicitly routed here by the main skill. This preserves
existing lower-level capabilities; it is not the default new-application path.
Check the installed declarations and the deployment's operation support before
using an older route. Never fall back from refused request-bound authorization to
JWT/admin authorization. Retry advice here applies only when the operation is known
safe to repeat; it never authorizes blindly repeating transaction submissions,
native approval POSTs or signing requests with an uncertain outcome.

# Create a key slot on-chain


A slot is one threshold keypair plus the access policy governing it. Creating
one is a transaction signed by the creator’s EVM account. Confirm the selected
network’s creation and usage charges before submitting. Everything below lives in `tasra-sdk/chain`
and needs `viem` installed.

Generate and privately save the creator key, then fund its public address through
the selected network's faucet or a wallet controlled by the user. Never embed a
shared funding key or assume an account is funded because it was created.

## Inputs you need

- `rpcUrl` and the chain id of the deployment.
- Download the selected manifest from
  [tasra-releases](https://github.com/t3-foundry/tasra-releases), verify the trusted
  pointer checksum with `parsePinnedNetworkManifest`, and derive the address book
  with `addressBookFromManifest`. Pass `manifest.chainId` explicitly. Include the
  contracts required by the operation; `requireAddress` reports missing entries.
- A funded creator key, or a chain-bound viem `WalletClient` (browser wallet).
- A DCQL rule string (see `tasra-dcql-rules`). **Decide its shape now**: the rule
  is committed at creation and cannot be amended without a `rulePolicy`, so a slot
  that will serve identity-scoped operations (IBE extraction — `tasra-ibe-identity-scoped`)
  needs `kk_identity_scope_claim` / `kk_scope_namespace` in the rule from the start.
  Adding them later means a new slot, and anything already sealed to the old slot's
  key is stranded.

## Steps

For a new creator, first fund native gas and obtain any required usage asset,
then **(3)** `createSlot`,
**(4)** resolve the keepers, **(5)** wait for DKG, **(6)** provision the rule
(see "Provision the rule"), **(7)** `fundSlot`, and **(8)** `setVerifierPolicy`
when the slot will be used over the committee path. The block below is steps 3 to 8.

```ts
import {
  createTasraChainClient, createTasraWriteClient, addressBookFromManifest,
  resolveSlotKeeperUrls, resolveVerifierDirectory,
} from 'tasra-sdk/chain'
import {fetchMpk} from 'tasra-sdk'
import {keccak256, toHex} from 'viem'

const addresses = addressBookFromManifest(manifest)
const chain  = createTasraChainClient({rpcUrl, addresses, chainId})
const writer = createTasraWriteClient({rpcUrl, addresses, chainId, privateKey})
// browser: createTasraWriteClient({rpcUrl, addresses, wallet})  // wallet bound to account + chain

// 3. create — mode: 'bls' encryption, 'frost' Ed25519 signing, 'tecdsa' an EVM account,
//    plus 'bls-bn254' and 'tecdsa-p256'. The fleet must run keepers for the mode you pick.

//    SIZE n AGAINST THE ELIGIBLE POOL, NOT THE FLEET. The committee is drawn only from operators
//    carrying the tag in `tags`, and `tags` DEFAULTS TO ['keykeeper'] when you pass none — so the
//    pool is always narrower than activeOperators(), and n above it reverts
//    `InsufficientFilteredPool(have, need)`. Two reads answer it:
const tag = keccak256(toHex('keykeeper'))                     // the default tag; keccak of your own otherwise
const operators = (await chain.readers.nodeRegistry.activeOperators()) as readonly `0x${string}`[]
const eligible: `0x${string}`[] = []
for (const op of operators) if (await chain.readers.nodeRegistry.hasTag(op, tag)) eligible.push(op)
const k = 2, n = 3                                            // k <= n <= eligible.length
if (eligible.length < n) throw new Error(`${eligible.length} eligible keepers; n=${n} cannot be drawn`)

//    ASK THE REGISTRY WHICH CALL IT ACCEPTS. A deployment that sets requireCommitReveal — every
//    production genesis does — refuses createSlot with CommitRevealRequired() and takes only the
//    two-phase call. One read tells you which, and costs nothing:
const oneShot = !(await chain.readers.keyRegistry.requiresCommitReveal())
const created = oneShot
  ? await writer.createSlot({rule, k, n, mode: 'bls'})
  // Commits the parameters, then asks the accountants for a seed to reveal immediately.
  // Falls back to the beacon-epoch wait when no usable seed is available; onEpoch reports
  // that wait with NUMBERS, not bigints. Returns commitTx, revealTx, and seeded instead of txHash.
  : await writer.createSlotCommitReveal({rule, k, n, mode: 'bls', onEpoch: (cur, target) => console.log(`epoch ${cur}/${target}`)})
const {slotId, ruleSalt} = created
const txHash = 'txHash' in created ? created.txHash : created.revealTx
// slotId and ruleSalt are 0x-hex strings.

// 3b. PERSIST {slotId, ruleSalt} DURABLY, NOW — before the DKG poll, before anything.
// This is the only time you are handed the salt. The chain holds only the salted
// commitment, the salt is random and cannot be re-derived, and the SDK stores nothing.
// Lose it and the slot is permanently unusable: see "Persist the salt" below.
await yourStore.putSlot({slotId, ruleSalt, rule})   // your storage, not the SDK's

// 4. Resolve the assigned committee's published URLs from the selected network.
const nodes = await resolveSlotKeeperUrls(chain, slotId)

// 5. wait for distributed key generation: poll for a NON-EMPTY group key.
//    Completion time depends on mode, committee and deployment. tECDSA includes
//    an AuxInfo phase. Poll with a deadline and preserve the intent if it times out.
//    Ask EVERY keeper, not nodes[0]: one keeper can be down or lagging while the rest key the slot,
//    and k keyed keepers are enough to serve it.
const deadline = Date.now() + 120_000
let keyed: string[] = []
while (keyed.length < k && Date.now() < deadline) {
  keyed = []
  for (const node of nodes) {
    try {
      const {mpkBytes} = await fetchMpk(node, slotId)  // GET {node}/v1/keys/{slotId}/public
      if (mpkBytes.length > 0) keyed.push(node)        // 200 with empty bytes = known, not yet keyed
    } catch { /* not served yet, or this keeper is down */ }
  }
  if (keyed.length < k) await new Promise(r => setTimeout(r, 2000))
}
if (keyed.length < k) throw new Error(`DKG timed out: ${keyed.length} of ${nodes.length} keepers keyed, need ${k}`)

// 6. provision the rule to every keeper — see "Provision the rule" below. Until it is done the
//    keepers cannot evaluate access, so no session opens. A keeper that never gets it cannot answer.

// 7. fund metered usage. tsraAmount comes from the buy in "Funding" below, which runs first.
await writer.fundSlot(slotId, tsraAmount)

// 8. the per-request verifier policy — REQUIRED before any committee-path operation.
//    Until it is set, ibeExtractRequest / ibeDecryptRequest / createCommitteeSlotClient all fail
//    with `slot 0x… has no verifierPolicy (committee path not wired); use the JWT path`, and
//    nothing in the steps above reveals that. The managed JWT path (Session.decrypt) does not
//    need it, so set it only for slots that will serve the committee or IBE paths.
//    `committee` verifiers are drawn per request and `quorum` of them must co-sign (both uint16);
//    committee cannot exceed the on-chain verifier set.
const verifierCount = (await resolveVerifierDirectory(chain)).length
await writer.setVerifierPolicy(slotId, Math.min(3, verifierCount), 2)
```

Every write method returns only after its transaction is mined and its receipt says `success`
(a reverted transaction throws), so calls can be written one after another as they are here.

## Funding gas and slot usage

Creator gas, the Ethereum slot account's balance and metered slot usage are
different balances. Read them before funding. Obtain native tokens and any
required asset through the selected network's published faucet or a wallet the
user controls. A missing funding service is a missing integration input.

`writer.ethBalance(address)`, `writer.eurcBalance(address)`,
`writer.tsraBalance(address)` and `writer.settlementBalance(slotId)` read the
relevant balances. `httpFaucet(url).fund(address)` supports a compatible faucet
whose URL the deployment publishes; it does not discover or authenticate one.

Where the deployed contracts offer a bonding curve, quote the amount needed with
`eurCentsForTsra`, approve EURC with `approveEurcForCurve`, then call `buyTsra`
with an explicit minimum output. EURC uses six decimals and TASRA uses eighteen.
Check the resulting balance before calling `fundSlot`. Do not assume an open mint
or substitute a guessed amount for the current quote. Each purchase and funding
transaction needs authorization for its amount and destination.

## Gas: who pays

By default the creator key pays gas for every write. A deployment can sponsor
the **sender-bound** calls through its platform relayer (ERC-2771): the client
signs an EIP-712 forward request, the relayer applies its policy, pays the gas
and submits it through the pinned forwarder, and the contract still sees the
signer as the sender — the relayer authorises nothing.

`RelayConfig` is `RegisteredRelayConfig` — **there is no `url` field**. A
relayer is chosen by the application's own on-chain service approvals, not by an address
you type: "Registry membership alone never selects a service." A `{url, forwarder}` object
is the old shape and no longer compiles.

```ts
import {SERVICE_TYPES, readApprovedServiceRecord} from 'tasra-sdk/chain'
import type {RegisteredRelayConfig, ServiceApproval} from 'tasra-sdk/chain'
import {createNodeRelayTransport} from 'tasra-sdk/chain/node'   // NOTE the /chain/node subpath

// 1. Find the registered relayer. SERVICE_TYPES.gasRelayer = 0; status 0 = active.
const ids = await chain.readers.serviceRegistry.serviceIds(0n, 20n)
let approval: ServiceApproval | undefined
for (const serviceId of ids) {
  const s = await chain.readers.serviceRegistry.getService(serviceId)
  if (s.serviceType !== SERVICE_TYPES.gasRelayer || s.status !== 0) continue
  // An approval is YOUR application pinning exactly this record — registry membership
  // alone never selects a service. Pin `revision` and `manifestHash`, not just the id.
  approval = {chainId, registry: requireAddress(addresses, 'ServiceRegistry'), serviceId,
    serviceType: SERVICE_TYPES.gasRelayer, owner: s.owner, revision: s.revision,
    manifestHash: s.manifestHash}
}
await readApprovedServiceRecord(chain, approval!)   // re-reads through the approval; throws if the pin no longer matches

// 2. Use the verified service record and normal HTTPS trust.
const transport = createNodeRelayTransport()

const writer = createTasraWriteClient({
  rpcUrl, addresses, chainId, privateKey,
  relay: {
    approvals: [approval!],   // in preference order
    transport,
    forwarder,                // the deployment's ERC-2771 forwarder, pinned by YOU — never from a relayer manifest
    // persistAttempt / resumeAttempt make a sponsored write durable across a restart
  } satisfies RegisteredRelayConfig,
})
const {slotId, ruleSalt, relay} = await writer.createSlot({rule, k, n, mode: 'bls'})
await yourStore.putSlot({slotId, ruleSalt, rule})   // still required on the sponsored path
relay?.txHash
relay?.costWei          // gas the RELAYER paid, a DECIMAL STRING: BigInt(costWei) before formatEther. Also writer.lastRelay()
```

When the deployment accepts a sponsored call, the relayer pays gas and the
forwarder preserves the creator identity. Verify the transaction receipt and
on-chain creator; sponsorship does not grant permission to use the slot.

`createRegisteredRelaySubmitter(chain, config, wallet)` drives it directly, and
`reconcileRelayAttempt` resolves an attempt whose outcome you did not see —
`RelayOutcomeUnknownError` is the case to handle, because a submitted request may have
landed even when the response did not.

**What a deployment sponsors is its relayer's allowlist, not a fixed SDK list.** Read it
rather than assuming — `tasra-cli relay policy` prints `(target, selector, class,
max_gas)`, where class `public` permits ordinary accounts and `operator` requires
an eligible registered operator. Confirm each intended method is sponsored before
depending on relay gas; registry membership alone does not grant sponsorship.

One invariant holds everywhere: **ERC-20 `approve` is never sponsorable** — it is not
2771-aware, so it always comes from your key. `fundSlot` and `buyTsra` each need one. So
even a fully sponsored developer needs a little native gas; that is what the faucet's gas
drip is for. If the relayer refuses a call (its policy, or relay mode off) the error names
the relay; without `relay` in the config nothing is sponsored and every call needs gas.

## Persist the salt

**The low-level writer does not persist creation state.** Its creation calls return
`ruleSalt`; custom workflows must preserve that salt and the exact policy. Prefer
`prepareSlot` with durable persistence before submission, or `slots.create` with
an application store, when implementing recoverable creation.

At minimum, store durably and atomically with the creation:

| Keep | Why |
|---|---|
| `slotId` | everything else is keyed by it |
| `ruleSalt` | random, **not derivable**, and the chain holds only `keccak256(DOMAIN ‖ ruleSalt ‖ rule)` |
| the clear `rule` | provisioning sends the rule and the salt together; the chain never stores the rule |

**Losing the salt makes the slot permanently unusable.** A keeper recomputes the
commitment before accepting a clear rule, so provisioning fails with `dcql_rule does not
match the slot's on-chain commitment`. That message reads like a typo in a rule that is
perfectly fine, which is what makes this expensive to diagnose. There is no recovery
path: the salt is not on chain, not in the SDK, and not reconstructible from the
commitment. The slot keeps its identity and its key forever and can never be authorized.

Two practical consequences:

- **Write before you wait.** Persist immediately after the creation call returns, not
  after the DKG poll. The poll can take minutes and any crash in between loses the salt
  while the slot exists on chain.
- **`verifyRuleCommitment(rule, salt, commitment)` is your integrity check**, not a
  recovery tool. Run it against what you stored and the on-chain `ruleCommitment` to
  confirm the pair is still the right one — it tells you a record is wrong, never what
  the right value was.

If your application creates slots on a user's behalf, treat `{slotId, ruleSalt}` with the
same durability guarantees as the rest of that user's account state.

## Provision the rule (required before any session)

Use creator-signed provisioning on compatible fleets. The SDK already exposes
`provisionRule`; do not request an operator JWT or issuer signing seed for this step.
Persist the slot ID, rule salt and clear rule before submitting creation.

```ts
import {provisionRule} from 'tasra-sdk/chain'

await provisionRule(chain, {
  slotId, rule, ruleSalt,
  signer: creatorAccount, // viem account that created the slot
})
```

`rule` is the required SDK property. `dcqlRule` is rejected before sending
requests, including when an identical `rule` is also present. Provisioning still
needs the clear rule and salt, not just `ruleCommitment`; the HTTP body keeps
`dcql_rule` and `dcql_salt` as the deployed transport schema.
An OAuth/BYOIDP rule with `oauth+access-token+dpop` queries remains DCQL, with the
same canonicalization and commitment domain as credential DCQL.

The helper discovers the assigned keepers, signs the salted rule commitment using
EIP-712, and calls `/v1/keys/:slot/rule/by-creator`. It throws if any keeper fails;
keep recovery inputs and diagnose the reported per-keeper results. The keeper accepts
only a rule matching the on-chain commitment. For local Docker networks, the optional
`keeperUrls` list can translate the discovered endpoints to reachable host ports.

For the complete local SDK-only flow, use `docs/shared-account.md` and
`examples/shared-account.ts`. It generates a development issuer and pins that issuer
in the new slot's rule, then issues separate holder-bound credentials for Alice,
Bob and Mallory. This needs no pre-existing issuer secret. For an existing slot,
obtain a credential from an issuer its rule already accepts.

An older fleet without `/rule/by-creator` requires its deployment's documented
provisioning route or an upgrade. Do not silently fall back to requesting admin keys.

## Amending a slot's rule

**Decide this at creation or never.** A slot whose `rulePolicy.admin` is unset has an
**immutable** rule — `proposeRuleUpdate` reverts `RuleImmutable()` forever. And the
recovery window is tiny: `setRulePolicy` demands `_msgSender() == creator`, no policy
already set, and a **fresh** slot (`epoch == 0 && publicKey.length == 0 && ruleVersion == 0`)
— so once DKG submits the group key, seconds after creation, it reverts
`RulePolicySlotNotFresh()`. Pin it in `createSlot({..., rulePolicy})`, which is trivially
fresh because it happens in the same transaction.

```ts
await writer.createSlot({rule, k, n, mode: 'bls', rulePolicy: {
  admin: appOwner,        // the only address that may propose an amendment
  guardian: securityTeam, // may veto, or endorse to skip the delay. MUST differ from admin
  timelockSecs: 86_400,   // with NO guardian, at least MIN_RULE_TIMELOCK (1 hour)
}})
```

**A guardian is optional and is a second key, not a second party.** `guardian` need only
*differ from* `admin`, so a sole owner's normal posture is a hot admin key and a cold
guardian key they also hold: propose from hot, `endorseRuleUpdate` from cold, activate at
once — and if the hot key leaks, the cold one vetoes.

**The guardian is also what buys a short timelock.** `MIN_RULE_TIMELOCK` (1 hour) binds
only when `guardian == address(0)`, so a guarded policy may set `timelockSecs: 0` and skip
`endorseRuleUpdate` entirely — amendment then takes only as long as the keepers need to
attest. Omitting the guardian is legal and works, but every amendment waits the full hour,
because the rule *is* the access control: whoever can change it can grant themselves the
key, so an instant unilateral change would turn a stolen admin key into an instant
compromise. frames the delay precisely: it "exists solely to give the guardian time to notice
and object", which is why it may be zero when a guardian exists and must be ≥ 1 hour when
one does not. The timelock is a **notice** property; the `n − k + 1` adoption threshold is
the **safety** property and nothing may waive it. But note what adoption does *not* cover:
keepers attest that they hold the new rule, not that they approve it, so a compromised
`admin` on a zero-timelock slot can propose a rule granting itself the key and have it
adopted within seconds. lists `ruleTimelock: 0–1h` as the *dev / low-value*
posture and `1h` as the production one — keep a real delay on any slot whose admin key is
hot, and monitor `RuleUpdateProposed`, without which the timelock buys nothing.

Then the amendment is a four-party dance, and each party is different:

| step | who | what |
|---|---|---|
| `proposeRuleUpdate(slotId, newRuleCommitment)` | **admin only** | pins `ruleVersion + 1` and `notBefore = now + timelock`. One pending amendment at a time; the new hash cannot equal the current one |
| deliver the new clear rule + its salt | operator (the admin-gated POST) | the keeper matches it against the **pending** commitment and stores it as pending — the live rule keeps serving |
| `attestRuleAdoption(slotId, ruleVer, ruleCommitment)` | **each assigned keeper** | "I hold and have verified this rule". Needs `n - k + 1` of them. Keepers should attest *during* the timelock |
| `endorseRuleUpdate(slotId)` | **guardian only**, optional | collapses `notBefore` to now — the fast path |
| `vetoRuleUpdate(slotId)` | **guardian only**, optional | discards the proposal. A tripwire, not a wall: the admin may propose again |
| `activateRuleUpdate(slotId)` | **anyone** | swaps `ruleCommitment` and bumps `ruleVersion`, but only once the timelock has elapsed **and** adoptions ≥ `n - k + 1` |

The adoption threshold is the point of the whole design: the rule cannot become active
until enough keepers already hold its preimage, so a slot never points at a commitment
nobody can resolve. `ruleAdoptionThreshold(slotId)` and `ruleAdoptionVotes(slotId)` read
the progress.

The SDK's write client exposes `setRulePolicy` only; send the four update calls with viem
against `CONTRACT_ABIS.KeyRegistry`. All four are typically relayer-`public`, so an owner
amends their own policy without gas.

## `chainId` rule

Pass the downloaded manifest's `chainId` to `createTasraWriteClient` and use a
wallet bound to that chain. Compare it with the RPC before any submission. Chain
identity is part of each EIP-155 signature; addresses alone do not select a network.
Construction errors are `TasraError`; transaction execution failures can surface
as viem `ContractFunctionExecutionError`.

## Other write-client methods

`createSlotCommitReveal` accepts `slotSeed: false` to use the beacon-epoch path,
`accountantUrls` to override accountant discovery, `slotSeedTimeoutMs` for each
accountant request, and `onSeed` to observe the seed response (or `null` for fallback).
Its `seeded` result indicates whether the seeded reveal succeeded. A failed seeded
reveal through a relay propagates the error, leaving retries to the relay submitter.

`createSlotCommitReveal` (two-phase creation — the only one a registry with
`requireCommitReveal` accepts; see step 3), `fundSlot`, `rotateKey`,
`reshareKey`, `cancelSlot`, `renewSlot`, `setVerifierPolicy(slotId, committee, quorum)`
(step 8 above — the committee path does not run without it),
`setRulePolicy`, token helpers (`buyTsra`, `redeemTsra`, `tsraBalance`,
`ethBalance`, `settlementBalance`), and `sendEth(to, wei)`. `writer.address` is the
creator identity; `generateClientKey()` mints a fresh 0x-hex private key for a
new sovereign account. Gas sponsorship is described under "Gas: who pays".

`createSlot` options worth knowing: `rulePolicy` pins an amendment authority in
the same transaction — do this here, not with `setRulePolicy` afterwards, which loses a
race against DKG and leaves the rule immutable for good (see "Amending a slot's rule"); `exportable: true` allows raw shard export, which is
what the managed `Session.decrypt` needs — without it the keepers refuse shard
release (403) and the slot is decrypted over the threshold instead; use it only
for personal-vault or recovery slots; `tags` filters the committee draw and
**defaults to `['keykeeper']`** — there is no unfiltered draw, so size `n` against the
tagged pool as step 3 does.

Rule grammar on the bearer-JWT path: the keepers evaluate a DCQL query with
`format: "jwt"` against a virtual credential built from the token (`sub`, `iss`,
`scope`). `{"credentials":[{"id":"e","format":"jwt","claims":[{"path":["sub"],"values":["did:example:alice"]}]}]}`
admits one holder. This form is **not** accepted by the SDK's `validateDcql`
(which knows only the OID4VP formats) — pass it to `createSlot` unvalidated;
the commitment is then over the raw bytes, and the keepers accept it. OID4VP
rules (`jwt_vc_json`, `dc+sd-jwt`, with the `["iss"]` entry) are for the
credential paths (`tasra-committee-path`, `vpJwt` sessions).

## Common mistakes

- Omitting `chainId` against a remote RPC. The client refuses; pass the
  deployment's chain id.
- Polling `/public` for HTTP 200. It answers 200 as soon as the slot is known
  from chain, before the key exists. Poll for a non-empty `mpkBytes`.
- Hardcoding keeper URLs after creation. They are a chain read
  (`resolveSlotKeeperUrls`).
- Losing `ruleSalt`. Not a verification inconvenience — the slot becomes
  **permanently unusable**. See "Persist the salt" below.
- Destructuring only `{slotId}` from a creation call and dropping the rest. That is
  how the salt gets lost.
- Calling `setRulePolicy` after creation from a human-approved wallet. Use
  `rulePolicy` in `createSlot`.
- Taking `k: 3, n: 5` as a default. `n` must fit the tagged pool;
  `InsufficientFilteredPool(have, need)` names both numbers when it does not.
- Reaching `chain.keyRegistry` / `chain.nodeRegistry` directly. The typed readers
  are under `chain.readers.*`; the bare form does not exist and fails at `tsc`.
- Creating a slot for IBE with a rule that is not identity-scoped, or leaving the
  verifier policy unset. Both fail only later, at the first extraction. A rule is immutable unless
  its amendment policy was configured at creation.
- Reading a `fundSlot` revert as a slot problem. Short TASRA surfaces as the token's
  own error bubbling out of `Settlement.fund`, which viem cannot name against the
  Settlement ABI — it arrives as the bare selector `0xe450d38c`
  (`ERC20InsufficientBalance`). Check `writer.tsraBalance(writer.address)` first.

## Where to read more

- `node_modules/tasra-sdk/docs/chain.md` and `docs/prerequisites.md`.
- `node_modules/tasra-sdk/dist/chain/write.d.ts` (`CreateSlotArgs`,
  `WriteClientConfig`, `RelayConfig`).
