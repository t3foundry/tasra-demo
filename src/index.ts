import {loadNetwork} from './network.ts'
import {TasraClient} from 'tasra-sdk/app'

// Verify the manifest downloaded from tasra-releases; no wallet is needed.
const network = loadNetwork()
const tasra = new TasraClient({manifest: network.deployment, verifierAgentUrl: network.verifierAgentUrl})

// Check the actual chain and configured registries before using the network.
const health = await tasra.check()
if (!health.ready) throw new Error('Configured registries are unavailable')
console.log(`Connected to Tasra (${health.chainId})`)
console.log(`Block: ${await tasra.chain.client.getBlockNumber()}`)
console.log(`Active registered nodes: ${await tasra.chain.readers.nodeRegistry.activeCount()}`)
console.log('Registry contracts: available')
