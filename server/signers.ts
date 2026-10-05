import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { hexToBytes } from 'tasra-sdk'
import { issueSdJwtVc, holderCnf, jwkFromDid, ed25519FromDidKey, type Jwk } from 'tasra-sdk/oid4vp'
import { createFileStore } from 'tasra-sdk/app/node'
import { bondingCurveAbi, createTasraWriteClient } from 'tasra-sdk/chain'
import { tasra } from './config'
import { stateDirectory, atomicSave } from './store'
import { loadService } from './backend'
import type { Hex } from '../shared/model'

export type SignerRecord = { name: string; slotId: Hex; holderKey?: Jwk }
export type KeySlotOption = { slotId: Hex; name?: string }

const signersFile = join(stateDirectory, 'signers.json')

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

export function listSigners(): SignerRecord[] {
  if (existsSync(signersFile)) {
    const data = JSON.parse(readFileSync(signersFile, 'utf8')) as {
      signers: SignerRecord[]
    }
    return data.signers
  }
  const service = loadService()
  const signers = Object.entries(service.slots).map(([name, slotId]) => ({
    name,
    slotId,
    holderKey: service.holderKeys[name as keyof typeof service.holderKeys],
  }))
  atomicSave(signersFile, { schema: 'tasra-signers/v1', signers })
  return signers
}

export function hasSigner(name: string): boolean {
  return listSigners().some((s) => s.name === name)
}

function explorerUrl(): string {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, 'network.json'), 'utf8'),
  ) as { services?: Array<{ kind: string; url: string }> }
  return (
    manifest.services?.find((s) => s.kind === 'explorer')?.url ??
    'https://explorer.t3-foundry.fuji.tasra.network'
  )
}

/** Merge the signer registry with every FROST slot the on-chain registry reports. */
export async function listKeySlots(): Promise<KeySlotOption[]> {
  const response = await fetch(explorerUrl() + '/api/slots', {
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('Unable to list key slots from the registry')
  const data = (await response.json()) as {
    slots?: Array<{ slotId: string; mode: string; exists: boolean; cancelled: boolean }>
  }
  const slots = (data.slots ?? []).filter(
    (s) => s.mode === 'frost' && s.exists && !s.cancelled,
  )
  const existing = new Set(slots.map((s) => s.slotId.toLowerCase()))
  const named = listSigners()
    .filter((s) => existing.has(s.slotId.toLowerCase()))
    .map((s) => ({ slotId: s.slotId, name: s.name }))
  const knownIds = new Set(named.map((s) => s.slotId.toLowerCase()))
  const unknown = slots
    .filter((s) => !knownIds.has(s.slotId.toLowerCase()))
    .map((s) => ({ slotId: s.slotId.toLowerCase() as Hex }))
  return [...named, ...unknown]
}

export function addSigner(record: SignerRecord): SignerRecord[] {
  const signers = listSigners()
  if (signers.some((s) => s.name === record.name))
    throw new Error('A signer with this name already exists')
  const next = [...signers, record]
  atomicSave(signersFile, { schema: 'tasra-signers/v1', signers: next })
  return next
}

/** Issue a DocumentSigner credential bound to a browser-generated holder DID. */
export function issueSignerCredential(name: string, holderDid: string): string {
  const issuer = tasra.identities.create({ seed: hexToBytes(readIssuerSeed()) })
  try {
    return issueSdJwtVc({
      issuer: issuer.issuer,
      vct: 'DocumentSigner',
      sub: 'did:demo:' + name,
      cnf: holderCnf({ did: holderDid }),
      claims: { role: 'document-signer' },
      ttlSecs: 86400,
    })
  } finally {
    issuer.destroy()
  }
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

function slotProgressMessage(p: { step: string; phase: string }): string {
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

async function fundNewSlot(
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
    const slot = await tasra.slots.create(
      {
        name: 'document-' + name,
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