import type { Hex } from './model'

// Maximum PDF size accepted for encryption, in bytes (3 MB, decimal, matching
// the file size most operating systems report).
export const ENCRYPTION_MAX_PDF_BYTES = 3_000_000

// Wire shape of a Tasra BLS identity-encryption ciphertext, serialized with base64.
export type EncryptionCiphertext = {
  u: string // 96-byte compressed G2 ephemeral public key
  nonce: string // 12-byte ChaCha20-Poly1305 nonce
  aeadCt: string // AEAD output (plaintext length + 16-byte tag)
}

export type EncryptionManifest = {
  schema: 'tasra-encrypt/v1'
  recordId: string
  title: string
  version: number
  recipient: string
  identity: string
  documentSha256: string
  chainId: number
  keyRegistry: Hex
  slotId: Hex
}

export type EncryptionRecord = {
  manifest: EncryptionManifest
  ciphertext: EncryptionCiphertext
  pdfSize: number
  createdAt: string
}

export type EncryptionBundle = {
  manifest: EncryptionManifest
  ciphertext: EncryptionCiphertext
}

export function encryptionStatement(manifest: EncryptionManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: manifest.schema,
      recordId: manifest.recordId,
      title: manifest.title,
      version: manifest.version,
      recipient: manifest.recipient,
      identity: manifest.identity,
      documentSha256: manifest.documentSha256,
      chainId: manifest.chainId,
      keyRegistry: manifest.keyRegistry,
      slotId: manifest.slotId,
    }),
  )
}