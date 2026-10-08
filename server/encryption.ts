import { join } from 'node:path'
import { hexToBytes, type IbeCiphertext } from 'tasra-sdk'
import {
  openVerifierAgentSession,
  awaitVerifierAgentResult,
  VerifierAgentSessionError,
} from 'tasra-sdk/oid4vp'
import { createFileStore } from 'tasra-sdk/app/node'
import { deployment, tasra, verifierAgentUrl } from './config'
import { stateDirectory } from './store'
import { loadService } from './backend'
import { readIssuerSeed, fundNewSlot, slotProgressMessage } from './signers'
import { toHex, type Hex } from '../shared/model'
import type { EncryptionCiphertext } from '../shared/encrypt'

/** Deterministic issuer DID derived from the setup seed. */
export function encryptionIssuerDid(): string {
  const issuer = tasra.identities.create({ seed: hexToBytes(readIssuerSeed()) })
  try {
    return issuer.did
  } finally {
    issuer.destroy()
  }
}

/** Exact identity scope bound to one key, the issuer as recipient, and document version. */
export function encryptionIdentity(
  keyName: string,
  recordId: string,
  version: number,
): string {
  const issuer = encryptionIssuerDid()
  return `${issuer}/keys/${keyName}/recipient/${issuer}/id/${recordId}/version/${version}`
}

/** Create and fund a BLS identity-encryption key slot gated by a DocumentReader scope. */
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
        name: 'encrypted-' + name,
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

export function serializeCiphertext(c: IbeCiphertext) {
  return {
    u: Buffer.from(c.u).toString('base64'),
    nonce: Buffer.from(c.nonce).toString('base64'),
    aeadCt: Buffer.from(c.aeadCt).toString('base64'),
  }
}

/** Encrypt plaintext under an identity using the slot's anchored BLS public key. */
export async function encryptDocument(
  slotId: Hex,
  identity: string,
  plaintext: Uint8Array,
) {
  const slot = await tasra.slots.bls(slotId)
  return slot.encrypt(identity, plaintext)
}

export type DecryptSession = {
  sessionId: string
  pollSecret: string
  qrPayload: string
  requestHash: Hex
  slotId: Hex
  identity: string
}

/** Open a wallet session authorizing identity-key extraction for one ciphertext. */
export async function openDecryptSession(
  slotId: Hex,
  identity: string,
  description: string,
): Promise<DecryptSession> {
  const creator = tasra.wallets.create({ privateKey: loadService().creatorKey })
  const session = await openVerifierAgentSession({
    chainId: deployment.chainId,
    keyRegistry: deployment.addresses.KeyRegistry!,
    slotId,
    action: 'ibe-extract',
    identity,
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
    identity,
  }
}

/** Decode a wire-serialized ciphertext back to SDK bytes. */
export function decodeCiphertext(c: EncryptionCiphertext): IbeCiphertext {
  return {
    u: new Uint8Array(Buffer.from(c.u, 'base64')),
    nonce: new Uint8Array(Buffer.from(c.nonce, 'base64')),
    aeadCt: new Uint8Array(Buffer.from(c.aeadCt, 'base64')),
  }
}

/** Await the wallet presentation, then decrypt with the freshly bound grant. */
export async function decryptDocument(
  saved: DecryptSession,
  ciphertext: IbeCiphertext,
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
  const handle = await tasra.slots.bls(saved.slotId)
  const opened = await handle.decrypt(saved.identity, ciphertext, {
    requireReceipts: true,
    signal: AbortSignal.timeout(120000),
    authorize: async () => ({
      token: grant.token,
      verifierProofs: grant.verifierProofs!,
    }),
  })
  return opened.plaintext
}