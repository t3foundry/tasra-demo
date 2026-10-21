import type { Hex } from './model'

// Maximum PDF size accepted for encryption, in bytes (3 MB, decimal, matching
// the file size most operating systems report).
export const ENCRYPTION_MAX_PDF_BYTES = 3_000_000

export type EncryptionEnvelope = {
  encryptedAesKey: string // base64 of toBytes(GroupEnvelope): the KEM-wrapped compact JWT
  aesCiphertext: string // AES-256-GCM output of the PDF (ciphertext + 16-byte tag), base64
  epoch: number // slot epoch the key was wrapped under
}

export type EncryptionManifest = {
  schema: 'tasra-encrypt/v2'
  recordId: string
  title: string
  version: number
  documentSha256: string
  chainId: number
  keyRegistry: Hex
  slotId: Hex
}

export type EncryptionRecord = {
  manifest: EncryptionManifest
  envelope: EncryptionEnvelope
  pdfSize: number
  createdAt: string
}

export type EncryptionBundle = {
  manifest: EncryptionManifest
  envelope: EncryptionEnvelope
}

// ---- Pure base64url codec -------------------------------------------------
// No Buffer, no btoa/atob, no crypto.subtle, no process: safe for both the
// Node server and the browser bundle. Works on Uint8Array via String.fromCharCode.

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeBase64Char(ch: string): number {
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 65
  if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 71
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) + 4
  if (ch === '+') return 62
  if (ch === '/') return 63
  return -1
}

/** base64url-encode a byte string (RFC 4648 §5, no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64_ALPHABET[(n >> 18) & 63]
    out += B64_ALPHABET[(n >> 12) & 63]
    out += B64_ALPHABET[(n >> 6) & 63]
    out += B64_ALPHABET[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64_ALPHABET[(n >> 18) & 63]
    out += B64_ALPHABET[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64_ALPHABET[(n >> 18) & 63]
    out += B64_ALPHABET[(n >> 12) & 63]
    out += B64_ALPHABET[(n >> 6) & 63]
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode an unpadded base64url string. Throws on bad input. */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0)
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid base64url')
  // Re-pad with standard alphabet: base64url decoders accept '-'/'_' (they map to
  // the standard '+-_/' ambiguity), so translate '-' and '_' to '+' and '/' first.
  let std = text.replace(/-/g, '+').replace(/_/g, '/')
  const rem = std.length % 4
  if (rem === 2) std += '=='
  else if (rem === 3) std += '='
  else if (rem !== 0) throw new Error('Invalid base64url length')

  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < std.length; i++) {
    const ch = std[i]!
    if (ch === '=') break
    const val = decodeBase64Char(ch)
    if (val < 0) throw new Error('Invalid base64url')
    buffer = (buffer << 6) | val
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

// ---- Compact unsigned JWT -------------------------------------------------
// Header { alg: 'none', typ: 'JWT' }, payload { aesKey, aesNonce } (base64url),
// NO signature segment and no trailing dot.

const JWT_HEADER = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0'

type JwtPayload = { aesKey: string; aesNonce: string }

/** UTF-8 encode a string without TextEncoder (pure JS). */
function utf8Encode(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
      i++ // skip the low surrogate
    }
  }
  return Uint8Array.from(out)
}

/** UTF-8 decode a byte string without TextDecoder (pure JS). Throws on bad input. */
function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i]!
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i += 1
    } else if (b0 < 0xc0) {
      throw new Error('Invalid UTF-8')
    } else if (b0 < 0xe0) {
      if (i + 1 >= bytes.length) throw new Error('Invalid UTF-8')
      const b1 = bytes[i + 1]!
      if ((b1 & 0xc0) !== 0x80) throw new Error('Invalid UTF-8')
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f))
      i += 2
    } else if (b0 < 0xf0) {
      if (i + 2 >= bytes.length) throw new Error('Invalid UTF-8')
      const b1 = bytes[i + 1]!
      const b2 = bytes[i + 2]!
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80)
        throw new Error('Invalid UTF-8')
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f),
      )
      i += 3
    } else if (b0 < 0xf8) {
      if (i + 3 >= bytes.length) throw new Error('Invalid UTF-8')
      const b1 = bytes[i + 1]!
      const b2 = bytes[i + 2]!
      const b3 = bytes[i + 3]!
      if (
        (b1 & 0xc0) !== 0x80 ||
        (b2 & 0xc0) !== 0x80 ||
        (b3 & 0xc0) !== 0x80
      )
        throw new Error('Invalid UTF-8')
      const cp =
        ((b0 & 0x07) << 18) |
        ((b1 & 0x3f) << 12) |
        ((b2 & 0x3f) << 6) |
        (b3 & 0x3f)
      if (cp > 0x10ffff) throw new Error('Invalid UTF-8')
      out += String.fromCodePoint(cp)
      i += 4
    } else {
      throw new Error('Invalid UTF-8')
    }
  }
  return out
}

/** Encode the AES key + nonce into an unsigned compact JWT, returning UTF-8 bytes. */
export function encodeCompactJwt(input: {
  aesKey: Uint8Array
  aesNonce: Uint8Array
}): Uint8Array {
  if (input.aesKey.length !== 32) throw new Error('aesKey must be 32 bytes')
  if (input.aesNonce.length !== 12) throw new Error('aesNonce must be 12 bytes')
  const payload: JwtPayload = {
    aesKey: base64UrlEncode(input.aesKey),
    aesNonce: base64UrlEncode(input.aesNonce),
  }
  const body = JWT_HEADER + '.' + base64UrlEncode(utf8Encode(JSON.stringify(payload)))
  return utf8Encode(body)
}

/** Parse a compact unsigned JWT back into its AES key + nonce bytes. Throws on malformed input. */
export function decodeCompactJwt(jwtBytes: Uint8Array): {
  aesKey: Uint8Array
  aesNonce: Uint8Array
} {
  const text = utf8Decode(jwtBytes)
  const segments = text.split('.')
  if (segments.length !== 2) throw new Error('Malformed JWT: expected 2 segments')
  const header = utf8Decode(base64UrlDecode(segments[0]!))
  let headerObj: { alg?: string; typ?: string }
  try {
    headerObj = JSON.parse(header) as { alg?: string; typ?: string }
  } catch {
    throw new Error('Malformed JWT header')
  }
  if (headerObj.alg !== 'none' || headerObj.typ !== 'JWT')
    throw new Error('Unsupported JWT header')
  const payloadText = utf8Decode(base64UrlDecode(segments[1]!))
  let payload: Partial<JwtPayload>
  try {
    payload = JSON.parse(payloadText) as Partial<JwtPayload>
  } catch {
    throw new Error('Malformed JWT payload')
  }
  if (typeof payload.aesKey !== 'string' || typeof payload.aesNonce !== 'string')
    throw new Error('Malformed JWT payload')
  const aesKey = base64UrlDecode(payload.aesKey)
  const aesNonce = base64UrlDecode(payload.aesNonce)
  if (aesKey.length !== 32) throw new Error('aesKey must decode to 32 bytes')
  if (aesNonce.length !== 12) throw new Error('aesNonce must decode to 12 bytes')
  return { aesKey, aesNonce }
}