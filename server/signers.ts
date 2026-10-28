import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { hexToBytes } from '@t3foundry/tasra-sdk'
import { issueSdJwtVc, ed25519FromDidKey, type Jwk } from '@t3foundry/tasra-sdk/oid4vp'
import { createFileStore } from '@t3foundry/tasra-sdk/app/node'
import { bondingCurveAbi, createTasraWriteClient } from '@t3foundry/tasra-sdk/chain'
import { tasra } from './config'
import { stateDirectory } from './store'
import { loadService } from './backend'
import type { Hex } from '../shared/model'

// Funding budget in integer base units: EURC has 6 decimals; TSRA has 18.
const slotCredit = 1n * 10n ** 18n // deposit 1 TSRA into each slot
const eurcToBuys = 10n * 10n ** 6n // 10 EURC per purchase
const minimumTsraOut = 1n * 10n ** 18n // 1 TSRA minimum accepted per purchase

export function readIssuerSeed(): Hex {
  const state = JSON.parse(
    readFileSync(join(stateDirectory, 'setup.json'), 'utf8'),
  ) as { schema: string; issuerSeed?: Hex }
  if (state.schema !== 'tasra-document-setup/v2' || !state.issuerSeed)
    throw new Error('Issuer state unavailable; run the tutorial setup first')
  return state.issuerSeed
}

/** Issue a DocumentSigner credential bound to a remote W3C did:key (Ed25519) holder. */
export function issueRemoteSignerCredential(name: string, holderDid: string): {
  credential: string
  holderKey: Jwk
} {
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(holderDid))
    throw new Error('Remote holder DID must be an Ed25519 did:key')
  const publicKey = ed25519FromDidKey(holderDid)
  const holderKey = ed25519HolderJwk(publicKey)
  const issuer = tasra.identities.create({ seed: hexToBytes(readIssuerSeed()) })
  try {
    return {
      credential: issueSdJwtVc({
        issuer: issuer.issuer,
        vct: 'DocumentSigner',
        sub: 'did:demo:' + name,
        cnf: { jwk: holderKey },
        claims: { role: 'document-signer' },
        ttlSecs: 86400,
      }),
      holderKey,
    }
  } finally {
    issuer.destroy()
  }
}

function ed25519HolderJwk(publicKey: Uint8Array): Jwk {
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(publicKey).toString('base64url'),
  }
}

const slotStepLabel: Record<string, string> = {
  commit: 'Committing slot creation',
  reveal: 'Revealing the slot seed',
  key_generation: 'Keepers generating the key',
  rule_provisioning: 'Delivering the credential rule',
  verifier_policy: 'Installing the verifier policy',
  ready: 'Key slot ready',
}

export function slotProgressMessage(p: { step: string; phase: string }): string {
  const label = slotStepLabel[p.step] ?? p.step
  const suffix =
    p.phase === 'confirmed' || p.phase === 'complete' ? ` — ${p.phase}` : ''
  return `${label}${suffix}`
}

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
  )
    throw new Error('Manifest EURC address does not match BondingCurve')
  return createTasraWriteClient({
    ...tasra.deployment,
    addresses: { ...tasra.deployment.addresses, MockEurc: eurc },
    wallet: creator.wallet,
  })
}

export async function fundNewSlot(
  creator: ReturnType<typeof tasra.wallets.create>,
  slotId: Hex,
  onProgress: (message: string) => void,
) {
  const writer = await writeClient(creator)
  await tasra.slots.get(slotId)
  const balance = await writer.settlementBalance(slotId)
  if (balance >= slotCredit) {
    onProgress('Key slot already holds TSRA credit')
    return
  }
  const needed = slotCredit - balance

  let walletTsra = await writer.tsraBalance()
  for (let round = 0; walletTsra < needed && round < 8; round++) {
    const eurc = await writer.eurcBalance(creator.address)
    if (eurc < eurcToBuys) {
      onProgress('Minting test EURC…')
      await writer.mintMockEurc(creator.address, eurcToBuys - eurc)
      onProgress('Test EURC minted')
    }
    onProgress('Approving EURC for the bonding curve…')
    await writer.approveEurcForCurve(eurcToBuys)
    onProgress('Buying TSRA…')
    await writer.buyTsra(eurcToBuys, minimumTsraOut)
    walletTsra = await writer.tsraBalance()
    onProgress('TSRA balance: ' + walletTsra.toString())
  }
  if (walletTsra < needed)
    throw new Error('Could not buy enough TSRA to fund the key slot')

  onProgress('Depositing TSRA into the key slot…')
  const { fundTx } = await writer.fundSlot(slotId, needed)
  onProgress('Key slot funded: ' + fundTx)
}

/** Create a FROST key slot gated by the signer credential rule, then fund it. */
export async function createSignerSlot(
  name: string,
  onProgress: (message: string) => void,
): Promise<Hex> {
  const creator = tasra.wallets.create({ privateKey: loadService().creatorKey })
  const store = createFileStore(join(stateDirectory, 'sdk'))
  const issuer = tasra.identities.create({ seed: hexToBytes(readIssuerSeed()) })
  const policy = tasra.credentials.policy({
    issuer: issuer.did,
    type: 'DocumentSigner',
    subjects: ['did:demo:' + name],
    claims: { role: ['document-signer'] },
  })
  try {
    let last = ''
    // The slot recovery name doubles as the SDK's durable creation-journal key, so it
    // must be unique per creation. Reusing the signer's name would resume the old journal
    // and hand back the same slot instead of minting a fresh key slot.
    const slot = await tasra.slots.create(
      {
        name: `document-${name}-${randomUUID()}`,
        mode: 'frost',
        policy,
        threshold: { k: 2, n: 3 },
        verifiers: { committee: 3, quorum: 2 },
      },
      {
        wallet: creator,
        store,
        onProgress: (p) => {
          const message = slotProgressMessage(p)
          if (message !== last) {
            last = message
            onProgress(message)
          }
        },
      },
    )
    await fundNewSlot(creator, slot.slotId as Hex, onProgress)
    return slot.slotId as Hex
  } finally {
    issuer.destroy()
  }
}
