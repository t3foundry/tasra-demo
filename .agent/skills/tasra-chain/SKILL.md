---
name: tasra-chain
description: Load pinned Tasra deployment manifests and read public registry or slot state. Use for tasra-releases, Fuji configuration, keeper discovery, explorer queries, events and advanced chain integration.
metadata:
  package: tasra-sdk
  sources:
    - docs/fuji.md
    - docs/application-api.md
    - docs/chain.md
    - dist/chain/index.d.ts
---

# Configure a deployment and read public state

Canonical public records are in https://github.com/t3-foundry/tasra-releases.
For Fuji, fetch `networks/testnet/current.json` and the manifest it names,
`deployments/tasra-fuji-v1.json`, relative to that directory. Pin both to the same
reviewed repository commit. Verify the original manifest bytes using the trusted
pointer checksum with `parsePinnedNetworkManifest`, then call `addressBookFromManifest`.
The pointer and manifest must agree on network, chain and active status.
A checksum from an untrusted source does not establish authenticity.
`observeNetworkManifest` compares deployed code with the pinned record; it does
not certify keeper, issuer or authorization readiness. Confirm support for the
specific protected operation before using it.

Use the release manifest for all network configuration. Report missing services
explicitly and keep TLS verification enabled. Obtain creator funds from the
selected network's faucet or a wallet controlled by the user.

## Application reads

```ts
import {TasraClient, type ApplicationManifest} from 'tasra-sdk/app'

export async function inspectSlot(manifest: ApplicationManifest, slotId: `0x${string}`) {
  const tasra = new TasraClient({manifest, coordinator: 'lowest-operator-id'})
  return tasra.slots.get(slotId)
}
```

`new TasraClient({manifest})` validates manifest configuration; it does not authenticate
its source. `TasraClient.fromManifest(url, {sha256, coordinator})` downloads a release manifest
and checks an independently trusted digest. Supply the deployment’s coordinator
convention explicitly; it is not recorded in the release schema.
`tasra.check()` checks chain and registry code. `slots.get` returns metadata;
`(await tasra.slots.ecdsa(slotId)).getAddress()` reads an Ethereum address without
credentials. Pass `keeperUrl` only for an explicitly approved routing map.

## Advanced chain consumers

Explorer/indexer applications should keep `createTasraChainClient` and typed
readers/events from `tasra-sdk/chain`. An existing read client may be injected into
`createTasra({deployment, chain})`; its registry addresses and chain must agree.
Use `assignedNodes` plus NodeRegistry records for the slot's keeper identities;
a configured URL list alone is not evidence of assignment.

Read [manifest, discovery, address-book and event details](references/advanced.md)
for these integrations. The SDK retains advanced writers, governance and metering
APIs; choose them by capability, not a fixed number of clients. `chainId` must be
explicit for the chosen deployment, and slot IDs are 32-byte hex strings.

The SDK includes its wallet/chain runtime dependencies. Add `viem` directly only
when your application intentionally imports its advanced APIs. Only `/chain/node` imports Node TLS helpers;
keep it out of browser/extension bundles. Missing services in a manifest should
be reported explicitly; the manifest does not contain keys or bearer tokens.
