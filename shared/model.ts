import { verifyFrostSignature, hexToBytes } from 'tasra-sdk'

export type Hex = `0x${string}`
export const toHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

// The two seeded tutorial signers; the signing model itself is dynamic.
export const people = ['alice', 'bob'] as const
export type Person = (typeof people)[number]

export type SignerRef = { slotId: Hex; name?: string }

export type Manifest = {
  schema: 'tasra-sign/v1'
  requestId: string
  version: number
  title: string
  documentSha256: string
  chainId: number
  keyRegistry: Hex
  signers: SignerRef[]
}

export type Proof = {
  slotId: Hex
  name?: string
  publicKey: Hex
  epoch: number
  r: Hex
  z: Hex
  receiptStatus: 'verified'
}

export type Bundle = { manifest: Manifest; signatures: Proof[] }

export type Phase =
  | 'pending'
  | 'opening'
  | 'awaiting_wallet'
  | 'signing'
  | 'signed'
  | 'refused'
  | 'uncertain'

export type History = { at: string; event: string; person?: string }

export type SignerState = {
  slotId: Hex
  name?: string
  phase: Phase
  attemptId?: string
  signature?: Proof
  error?: string
}

export type PublicRequest = {
  manifest: Manifest
  status: 'awaiting' | 'completed' | 'cancelled' | 'declined'
  signers: SignerState[]
  history: History[]
}

export function statement(manifest: Manifest): Uint8Array {
  // One canonical field order, shared by the browser, backend and verifier.
  return new TextEncoder().encode(
    JSON.stringify({
      schema: manifest.schema,
      requestId: manifest.requestId,
      version: manifest.version,
      title: manifest.title,
      documentSha256: manifest.documentSha256,
      chainId: manifest.chainId,
      keyRegistry: manifest.keyRegistry,
      signers: manifest.signers.map((s) => ({
        name: s.name ?? null,
        slotId: s.slotId,
      })),
    }),
  )
}

export async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer,
  )
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

export function validateManifest(m: Manifest) {
  if (
    m.schema !== 'tasra-sign/v1' ||
    !/^[0-9a-f-]{36}$/i.test(m.requestId) ||
    !Number.isSafeInteger(m.version) ||
    m.version < 1 ||
    typeof m.title !== 'string' ||
    !m.title.trim() ||
    m.title.length > 120 ||
    !/^[0-9a-f]{64}$/.test(m.documentSha256) ||
    !Number.isSafeInteger(m.chainId) ||
    m.chainId <= 0 ||
    !/^0x[0-9a-f]{40}$/i.test(m.keyRegistry) ||
    !Array.isArray(m.signers) ||
    m.signers.length < 1 ||
    new Set(m.signers.map((s) => s.slotId.toLowerCase())).size !==
      m.signers.length ||
    m.signers.some(
      (s) =>
        !/^0x[0-9a-f]{64}$/i.test(s.slotId) ||
        (s.name !== undefined && !s.name.trim()),
    )
  )
    throw new Error('Invalid document manifest')
}

export async function verifyBundle(
  pdf: Uint8Array,
  expected: Manifest,
  bundle: Bundle,
  readKey: (id: Hex) => Promise<{
    publicKey: Hex
    epoch: number
    mode: number
    cancelled: boolean
  }>,
) {
  validateManifest(expected)
  validateManifest(bundle.manifest)
  if (
    (await digest(pdf)) !== expected.documentSha256 ||
    new TextDecoder().decode(statement(expected)) !==
      new TextDecoder().decode(statement(bundle.manifest)) ||
    bundle.signatures.length !== expected.signers.length
  )
    throw new Error('Document or request differs')
  for (const signer of expected.signers) {
    const proof = bundle.signatures.find(
      (s) => s.slotId.toLowerCase() === signer.slotId.toLowerCase(),
    )
    if (!proof) throw new Error('Missing assigned signer')
    const key = await readKey(signer.slotId)
    if (
      key.cancelled ||
      key.mode !== 0 ||
      key.epoch !== proof.epoch ||
      key.publicKey.toLowerCase() !== proof.publicKey.toLowerCase() ||
      !verifyFrostSignature(hexToBytes(key.publicKey), statement(expected), {
        r: hexToBytes(proof.r),
        z: hexToBytes(proof.z),
      })
    )
      throw new Error('Invalid or outdated signer proof')
  }
  return true
}