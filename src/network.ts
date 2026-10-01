/** Download and validate the public testnet manifest used by these examples. */
import {readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parsePinnedNetworkManifest} from 'tasra-sdk/chain'
import {resolveApplicationManifest} from 'tasra-sdk/app'

const base = 'https://raw.githubusercontent.com/t3-foundry/tasra-releases/main/networks/testnet/'
type Pin = {sha256: string; manifestUrl: string}

/** Fetch the pointer and its checksum-verified manifest, then save the original bytes. */
export async function downloadNetwork(fetchImpl: typeof fetch = fetch, directory = '.') {
  const download = async (url: string) => {
    const response = await fetchImpl(url, {signal: AbortSignal.timeout(15_000), redirect: 'error'})
    if (!response.ok) throw new Error(`Network manifest download failed: HTTP ${response.status}`)
    return response.text()
  }
  const pointer = JSON.parse(await download(base + 'current.json')) as Record<string, unknown>
  if (pointer.schemaVersion !== 1 || pointer.network !== 'testnet' || pointer.chainId !== 43113 ||
      pointer.status !== 'active' || typeof pointer.manifest !== 'string' ||
      !/^deployments\/[a-z0-9.-]+\.json$/.test(pointer.manifest) ||
      typeof pointer.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.sha256)) {
    throw new Error('Expected an active testnet pointer with a manifest path and SHA-256')
  }
  const pin = {sha256: pointer.sha256, manifestUrl: base + pointer.manifest}
  const text = await download(pin.manifestUrl)
  checkedManifest(text, pin)
  writeFileSync(resolve(directory, 'network.json'), text)
  writeFileSync(resolve(directory, 'network-pin.json'), JSON.stringify(pin, null, 2) + '\n')
}

function checkedManifest(text: string, pin: Pin) {
  if (!pin || typeof pin.sha256 !== 'string' || typeof pin.manifestUrl !== 'string' ||
      !pin.manifestUrl.startsWith(base + 'deployments/')) throw new Error('Invalid downloaded manifest pin')
  const manifest = parsePinnedNetworkManifest(text, pin.sha256)
  if (manifest.network !== 'testnet' || manifest.chainId !== 43113 || manifest.status !== 'active') {
    throw new Error('Expected an active testnet manifest')
  }
  return manifest
}

/** Read the saved manifest and verify its bytes before configuring any client. */
export function loadNetwork(directory = '.') {
  const text = readFileSync(resolve(directory, 'network.json'), 'utf8')
  const pin = JSON.parse(readFileSync(resolve(directory, 'network-pin.json'), 'utf8')) as Pin
  const manifest = checkedManifest(text, pin)
  // Coordinator selection is an explicit application setting, absent from the manifest schema.
  const resolved = resolveApplicationManifest(manifest, {coordinator: 'lowest-operator-id'})
  resolved.deployment = {...resolved.deployment, provenance: {
    networkRevision: `${manifest.deploymentId}@${manifest.revision}`, manifestSha256: pin.sha256,
  }}
  return resolved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await downloadNetwork()
  console.log('Saved checksum-verified network.json and network-pin.json from tasra-releases.')
}
