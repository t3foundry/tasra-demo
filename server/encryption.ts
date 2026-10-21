import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hexToBytes, fromBytes, type Ciphertext } from 'tasra-sdk'
import { resolveSlotGroupKey, resolveSlotKeeperUrls, nodeApi } from 'tasra-sdk/chain'
import { committeeDecrypt } from 'tasra-sdk/committee'
import {
  openVerifierAgentSession,
  awaitVerifierAgentResult,
  decryptPayloadDigest,
  VerifierAgentSessionError,
} from 'tasra-sdk/oid4vp'
import { createFileStore } from 'tasra-sdk/app/node'
import { deployment, tasra, chain, verifierAgentUrl } from './config'
import { stateDirectory } from './store'
import { loadService } from './backend'
import { readIssuerSeed, fundNewSlot, slotProgressMessage } from './signers'
import { toHex, type Hex } from '../shared/model'
import type { EncryptionEnvelope } from '../shared/encrypt'

/** Create and fund a BLS key slot gated by a DocumentReader scope. */
export async function createEncryptionSlot(
  name: string,
  onProgress: (message: string) => void,
): Promise<Hex> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
    throw new Error('Key name must be lowercase letters, digits and dashes')
  const creator = tasra.wallets.create({ privateKey: loadService().creatorKey })
  const store = createFileStore(join(stateDirectory, 'sdk'))
  const issuer = tasra.identities.create({ seed: hexToBytes(readIssuerSeed()) })
  const policy = tasra.credentials.policy({
    issuer: issuer.did,
    type: 'DocumentReader',
    claims: { key: [name] },
    identityScope: { claim: 'documents' },
  })
  try {
    let last = ''
    const slot = await tasra.slots.create(
      {
        // Unique recovery name so a reused key name mints a fresh slot instead of
        // resuming the previous creation journal.
        name: `encrypted-${name}-${randomUUID()}`,
        mode: 'bls',
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

/** Resolve the slot's anchored group public key + epoch for local envelope encryption. */
export async function groupKeyParams(
  slotId: Hex,
): Promise<{ mpk: Hex; epoch: number }> {
  const { publicKey, epoch } = await resolveSlotGroupKey(chain, slotId)
  return { mpk: publicKey as Hex, epoch }
}

export type DecryptSession = {
  sessionId: string
  pollSecret: string
  qrPayload: string
  requestHash: Hex
  slotId: Hex
  aad: Uint8Array
}

/** Open a wallet session authorizing group-key unwrapping for one wrapped AES key. */
export async function openDecryptSession(
  slotId: Hex,
  aad: Uint8Array,
  ciphertext: Ciphertext,
  description: string,
): Promise<DecryptSession> {
  const creator = tasra.wallets.create({ privateKey: loadService().creatorKey })
  const payloadDigest = decryptPayloadDigest(ciphertext.u, ciphertext.aeadCt)
  const session = await openVerifierAgentSession({
    chainId: deployment.chainId,
    keyRegistry: deployment.addresses.KeyRegistry!,
    slotId,
    action: 'decrypt',
    payloadDigest,
    description,
    verifierAgentUrl,
    signer: creator.signer,
  })
  return {
    sessionId: session.sessionId,
    pollSecret: session.pollSecret,
    qrPayload: session.qrPayload,
    requestHash: toHex(session.requestHash),
    slotId,
    aad,
  }
}

/** Discover the slot's keeper peers for the BLS decryption ceremony. */
async function resolveBlsPeers(
  slotId: Hex,
): Promise<{
  nodeUrl: string
  decryptingSet: number[]
  blsPeers: { id: number; peerId: string }[]
}> {
  const urls = await resolveSlotKeeperUrls(chain, slotId)
  // The first keeper URL is the coordinator the committee decrypt targets.
  const nodeUrl = urls[0]
  if (!nodeUrl) throw new Error('No keeper endpoints for this slot')
  const infos = await Promise.all(urls.map((url) => nodeApi.info(url)))
  const peers: { id: number; peerId: string }[] = []
  for (let i = 0; i < urls.length; i++) {
    const info = infos[i]
    const id = info?.node_identifier
    const peerId = info?.peer_id
    if (typeof id === 'number' && typeof peerId === 'string')
      peers.push({ id, peerId })
  }
  return { nodeUrl, decryptingSet: peers.map((p) => p.id), blsPeers: peers }
}

/** Decode a wire-serialized envelope back into the KEM ciphertext, AAD and epoch. */
export function decodeWrappedKey(
  envelope: EncryptionEnvelope,
  documentSha256: string,
): {
  ciphertext: Ciphertext
  aad: Uint8Array
  epoch: number
} {
  const groupEnvelope = fromBytes(
    new Uint8Array(Buffer.from(envelope.encryptedAesKey, 'base64')),
  )
  // The AAD bound into the KEM AEAD is the document's SHA-256 hex string.
  const aad = new Uint8Array(Buffer.from(documentSha256, 'utf8'))
  const groupAad = groupEnvelope.identity
  if (
    groupAad.length !== aad.length ||
    !groupAad.every((b, i) => b === aad[i])
  )
    throw new Error('Envelope identity does not match document SHA-256')
  const embeddedEpoch = groupEnvelope.epoch
  if (embeddedEpoch !== null && embeddedEpoch !== BigInt(envelope.epoch))
    throw new Error('Envelope epoch mismatch')
  return {
    ciphertext: groupEnvelope.ciphertext,
    aad,
    epoch: embeddedEpoch === null ? envelope.epoch : Number(embeddedEpoch),
  }
}

/** Await the wallet presentation, then unwrap the KEM plaintext (the compact JWT) through the keeper committee. */
export async function decryptDocument(
  saved: DecryptSession,
  ciphertext: Ciphertext,
  epoch: number,
  aad: Uint8Array,
  beforeSubmit: () => void,
): Promise<Uint8Array> {
  let grant
  try {
    grant = await awaitVerifierAgentResult(
      {
        verifierAgentUrl,
        sessionId: saved.sessionId,
        pollSecret: saved.pollSecret,
        requestHash: hexToBytes(saved.requestHash),
      },
      { timeoutMs: 45000, intervalMs: 500 },
    )
  } catch (e) {
    if (e instanceof VerifierAgentSessionError && e.kind === 'refused') {
      const denied = new Error('The verifier refused this credential')
      denied.name = 'AuthorizationRefused'
      throw denied
    }
    throw e
  }
  if (!grant.verifierProofs?.length)
    throw new Error('Missing verifier membership proofs')
  beforeSubmit()
  const { nodeUrl, decryptingSet, blsPeers } = await resolveBlsPeers(saved.slotId)
  return await committeeDecrypt({
    nodeUrl,
    committeeToken: grant.token,
    ciphertext,
    identity: aad,
    decryptingSet,
    blsPeers,
    verifierProofs: grant.verifierProofs,
    ciphertextEpoch: epoch,
  })
}