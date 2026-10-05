import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hexToBytes } from 'tasra-sdk'
import { createFileStore } from 'tasra-sdk/app/node'
import { bondingCurveAbi, createTasraWriteClient } from 'tasra-sdk/chain'
import { deployment, verifierAgentUrl, tasra, networkIdentity, assertSameNetwork, type NetworkIdentity } from './config'
import { stateDirectory, atomicSave, lockDirectory } from './store'
import { people, toHex, type Hex, type Person } from '../shared/model'

// Funding budget in integer base units: EURC has 6 decimals; TSRA has 18.
const eurcToBuys = 10n * 10n ** 6n // 10 EURC per purchase
const minimumTsraOut = 1n * 10n ** 18n // 1 TSRA minimum accepted per purchase
const slotCredit = 1n * 10n ** 18n // deposit 1 TSRA into each slot

/** Build the write client that buys TSRA and deposits slot credits. */
async function writeClient(creator: ReturnType<typeof tasra.wallets.create>) {
  const curve = tasra.deployment.addresses.BondingCurve
  if (!curve) throw new Error('Network manifest has no BondingCurve')
  const eurc = await tasra.chain.client.readContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'eurc',
  })
  if (
    tasra.deployment.addresses.MockEurc &&
    tasra.deployment.addresses.MockEurc.toLowerCase() !== eurc.toLowerCase()
  ) {
    throw new Error('Manifest EURC address does not match BondingCurve')
  }
  return createTasraWriteClient({
    ...tasra.deployment,
    addresses: { ...tasra.deployment.addresses, MockEurc: eurc },
    wallet: creator.wallet,
  })
}

/** Top up any slot below the target credit; reuse existing EURC and TSRA on re-runs. */
async function fundSlots(
  creator: ReturnType<typeof tasra.wallets.create>,
  slots: Partial<Record<Person, Hex>>,
) {
  const writer = await writeClient(creator)
  const short: Array<{ slotId: Hex; needed: bigint }> = []
  let totalNeeded = 0n
  for (const person of people) {
    const slotId = slots[person]
    if (!slotId) continue
    await tasra.slots.get(slotId) // validate before depositing
    const balance = await writer.settlementBalance(slotId)
    if (balance < slotCredit) {
      const needed = slotCredit - balance
      short.push({ slotId, needed })
      totalNeeded += needed
    }
  }
  if (!short.length) {
    console.log('Both slots already hold TSRA credit.')
    return
  }

  let walletTsra = await writer.tsraBalance()
  for (let round = 0; walletTsra < totalNeeded && round < 8; round++) {
    const eurc = await writer.eurcBalance(creator.address)
    if (eurc < eurcToBuys) {
      console.log('Minting test EURC:', (eurcToBuys - eurc).toString())
      await writer.mintMockEurc(creator.address, eurcToBuys - eurc)
    }
    console.log('Approving EURC for the bonding curve:', eurcToBuys.toString())
    await writer.approveEurcForCurve(eurcToBuys)
    console.log('Buying TSRA (minimum output):', minimumTsraOut.toString())
    await writer.buyTsra(eurcToBuys, minimumTsraOut)
    const after = await writer.tsraBalance()
    if (after <= walletTsra) throw new Error('TSRA purchase produced no additional balance')
    walletTsra = after
  }
  if (walletTsra < totalNeeded) {
    throw new Error(
      'Could not buy enough TSRA to fund both slots; check EURC and the bonding curve, then rerun setup.',
    )
  }

  for (const { slotId, needed } of short) {
    console.log('Depositing TSRA into slot:', slotId, needed.toString())
    const { fundTx } = await writer.fundSlot(slotId, needed)
    console.log('Slot funding confirmed:', fundTx)
  }
  for (const person of people) {
    const slotId = slots[person]
    if (slotId)
      console.log(person, 'slot credit:', (await writer.settlementBalance(slotId)).toString())
  }
}

export type Setup = {
  schema: 'tasra-document-setup/v2'
  network: NetworkIdentity
  creatorKey: Hex
  issuerSeed: Hex
  holders: Record<string, Hex>
  slots: Partial<Record<Person, Hex>>
}

export function loadSetup(): Setup {
  const state = JSON.parse(readFileSync(join(stateDirectory, 'setup.json'), 'utf8')) as Setup
  if (state.schema !== 'tasra-document-setup/v2')
    throw new Error('Older setup state requires reconciliation. Preserve it; use a fresh TASRA_SIGN_DATA directory for this tutorial.')
  assertSameNetwork(state.network)
  return state
}

const unlock = lockDirectory()
try {
  if (!(await tasra.check()).ready)
    throw new Error('Network registries unavailable; check the downloaded manifest')
  const health = await fetch(verifierAgentUrl + '/health', { signal: AbortSignal.timeout(10000) })
  if (!health.ok) throw new Error('Verifier unavailable')

  // Save fresh creator and identity keys before funding or creating any slots.
  const file = join(stateDirectory, 'setup.json')
  const newIdentitySeed = () => {
    const identity = tasra.identities.create()
    try {
      return toHex(identity.exportPrivateKey())
    } finally {
      identity.destroy()
    }
  }
  const state: Setup = existsSync(file)
    ? loadSetup()
    : {
        schema: 'tasra-document-setup/v2',
        network: networkIdentity,
        creatorKey: tasra.wallets.create().exportPrivateKey(),
        issuerSeed: newIdentitySeed(),
        holders: Object.fromEntries(['alice', 'bob', 'mallory'].map((name) => [name, newIdentitySeed()])),
        slots: {},
      }
  const save = () => atomicSave(file, state)
  save()
  const store = createFileStore(join(stateDirectory, 'sdk'))
  const creator = tasra.wallets.create({ privateKey: state.creatorKey })
  await store.save('creator-key', creator.exportPrivateKey())
  await store.save('network-pin', networkIdentity.manifestSha256)
  console.log(`Creator: ${creator.address} on chain ${deployment.chainId}.`)
  if ((await tasra.chain.client.getBalance({ address: creator.address })) < 5n * 10n ** 16n) {
    throw new Error('Fund this address with at least 0.05 AVAX using the official Fuji C-Chain faucet or your wallet, then rerun npm run setup. Saved creator state will be reused.')
  }

  // Each signer receives a separate identity and holder-bound credential.
  const issuer = tasra.identities.create({ seed: hexToBytes(state.issuerSeed) })
  mkdirSync(join(stateDirectory, 'wallets'), { recursive: true, mode: 0o700 })
  for (const [name, seed] of Object.entries(state.holders)) {
    const holder = tasra.identities.create({ seed: hexToBytes(seed) })
    const credential = tasra.credentials.issue({
      issuer,
      holder,
      type: 'DocumentSigner',
      subject: 'did:demo:' + name,
      claims: { role: 'document-signer' },
      ttlSecs: 86400,
    })
    atomicSave(join(stateDirectory, 'wallets', name + '.json'), {
      schema: 'tasra-demo-wallet/v1',
      name,
      seed,
      credential,
    })
    holder.destroy()
  }

  // A stable name lets the SDK resume creation, rule delivery, and verifier setup.
  for (const person of people) {
    const slot = await tasra.slots.create(
      {
        name: 'document-' + person,
        mode: 'frost',
        policy: tasra.credentials.policy({
          issuer,
          type: 'DocumentSigner',
          subjects: ['did:demo:' + person],
          claims: { role: ['document-signer'] },
        }),
        threshold: { k: 2, n: 3 },
        verifiers: { committee: 3, quorum: 2 },
      },
      { wallet: creator, store },
    )
    state.slots[person] = slot.slotId
    save()
    console.log(person + ' key ready: ' + slot.slotId)
  }

  // Buy TSRA with EURC and deposit usage credit into each slot automatically.
  await fundSlots(creator, state.slots)

  // Application records remain separate from the SDK's durable operation journals.
  const serviceFile = join(stateDirectory, 'service.json')
  const existing = existsSync(serviceFile)
    ? (JSON.parse(readFileSync(serviceFile, 'utf8')) as { senderToken: string })
    : undefined
  const holderKeys = Object.fromEntries(
    people.map((name) => {
      const identity = tasra.identities.create({ seed: hexToBytes(state.holders[name]!) })
      const publicKey = identity.holder.publicJwk
      identity.destroy()
      return [name, publicKey]
    }),
  )
  atomicSave(serviceFile, {
    network: networkIdentity,
    creatorKey: state.creatorKey,
    slots: state.slots,
    senderToken: existing?.senderToken ?? randomBytes(32).toString('hex'),
    holderKeys,
  })
  atomicSave(join(stateDirectory, 'public.json'), {
    deployment,
    verifierAgentUrl,
    issuerDid: issuer.did,
    slots: state.slots,
  })
  issuer.destroy()
  console.log(
    'Setup complete. Both slots are funded with TSRA credit. Import server/.tasra/wallets/alice.json and bob.json into separate browser contexts. Wallet files are private.',
  )
} finally {
  unlock()
}