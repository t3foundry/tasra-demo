import {TasraClient} from 'tasra-sdk/app'
import {createFileStore} from 'tasra-sdk/app/node'
import {loadNetwork} from './network.js'

const network = loadNetwork()
export const store = createFileStore('.tasra/first-slot')
export const tasra = new TasraClient({manifest: network.deployment, verifierAgentUrl: network.verifierAgentUrl, store})

// Keep this lesson's saved accounts and slot on their original network snapshot.
await store.withLock('network', async () => {
  const pin = network.deployment.provenance?.manifestSha256
  if (!pin) throw new Error('Download the network manifest first')
  const saved = await store.load<string>('network-pin')
  if (saved && saved !== pin) throw new Error('Network changed; preserve the original lesson state and manifest')
  if (!saved) await store.save('network-pin', pin)
})

export async function savedSlotId() {
  const slotId = await store.load<`0x${string}`>('slot-id')
  if (!slotId) throw new Error('Complete the create-slot lesson first')
  return slotId
}

export async function savedCreator() {
  const privateKey = await store.load<`0x${string}`>('creator-key')
  if (!privateKey) throw new Error('Complete the create-slot lesson first')
  return tasra.wallets.create({privateKey})
}
