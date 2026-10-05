import { TasraClient } from 'tasra-sdk/app'
import { loadNetwork } from './network'

// Use the downloaded manifest after verifying its saved SHA-256 pin.
const network = loadNetwork()
if (!network.verifierAgentUrl) throw new Error('Manifest must name a verifier agent')
export const verifierAgentUrl = network.verifierAgentUrl
export const tasra = new TasraClient({ manifest: network.deployment, verifierAgentUrl })
export const { deployment, chain } = tasra

const manifestSha256 = deployment.provenance?.manifestSha256
if (!manifestSha256) throw new Error('Downloaded manifest lacks its checksum pin')
export const networkIdentity = Object.freeze({
  chainId: deployment.chainId,
  keyRegistry: deployment.addresses.KeyRegistry!.toLowerCase(),
  manifestSha256,
  coordinator: deployment.coordinator,
  verifierAgentUrl,
})
export type NetworkIdentity = typeof networkIdentity

/** Reject changed routing before reusing saved credentials or session secrets. */
export function assertSameNetwork(value: unknown): asserts value is NetworkIdentity {
  const saved = value as Partial<NetworkIdentity> | undefined
  if (!saved || typeof saved !== 'object' ||
    saved.chainId !== networkIdentity.chainId ||
    typeof saved.keyRegistry !== 'string' ||
    saved.keyRegistry.toLowerCase() !== networkIdentity.keyRegistry ||
    saved.manifestSha256 !== networkIdentity.manifestSha256 ||
    saved.coordinator !== networkIdentity.coordinator ||
    saved.verifierAgentUrl !== networkIdentity.verifierAgentUrl) {
    throw new Error('Saved network configuration differs. Restore the original manifest and pin; preserve private state for reconciliation.')
  }
}