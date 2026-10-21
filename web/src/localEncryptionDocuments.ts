import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import type { EncryptionRecord } from '../../shared/encrypt'

const storageKey = 'tasra-encryption-documents'

function isEncryptionRecord(value: unknown): value is EncryptionRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<EncryptionRecord>
  const manifest = record.manifest
  const envelope = record.envelope
  if (typeof manifest !== 'object' || manifest === null) return false
  if (typeof envelope !== 'object' || envelope === null) return false
  return (
    typeof record.createdAt === 'string' &&
    typeof record.pdfSize === 'number' &&
    manifest.schema === 'tasra-encrypt/v2' &&
    typeof manifest.recordId === 'string' &&
    typeof envelope.encryptedAesKey === 'string' &&
    typeof envelope.aesCiphertext === 'string' &&
    Number.isSafeInteger(envelope.epoch)
  )
}

function isGzip(raw: string): boolean {
  return raw.length >= 2 && raw.charCodeAt(0) === 0x1f && raw.charCodeAt(1) === 0x8b
}

function decode(raw: string): EncryptionRecord[] {
  const parsed: unknown = isGzip(raw)
    ? JSON.parse(strFromU8(gunzipSync(strToU8(raw, true))))
    : JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isEncryptionRecord)
}

function encode(records: EncryptionRecord[]): string {
  const json = JSON.stringify(records)
  return strFromU8(gzipSync(strToU8(json)), true)
}

export function listLocalEncryptionRecords(): EncryptionRecord[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    return decode(raw)
  } catch {
    return []
  }
}

export function saveLocalEncryptionRecord(record: EncryptionRecord): void {
  const records = listLocalEncryptionRecords().filter(
    (r) => r.manifest.recordId !== record.manifest.recordId,
  )
  records.push(record)
  localStorage.setItem(storageKey, encode(records))
}

export function removeLocalEncryptionRecord(recordId: string): void {
  try {
    const remaining = listLocalEncryptionRecords().filter(
      (r) => r.manifest.recordId !== recordId,
    )
    if (remaining.length === 0) {
      localStorage.removeItem(storageKey)
    } else {
      localStorage.setItem(storageKey, encode(remaining))
    }
  } catch {
    // ignore
  }
}

export function localEncryptionStorageBytes(): number {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return 0
    // Browsers meter localStorage by UTF-16 code units. The stored value is a
    // latin1 binary string of the gzipped bytes, where 1 code unit = 1 byte, so
    // `raw.length` equals the compressed byte size and matches how the ~5 MB
    // quota is actually accounted (do NOT multiply by 2).
    return raw.length
  } catch {
    return 0
  }
}