import type { EncryptionRecord } from '../../shared/encrypt'

const storageKey = 'tasra-encryption-documents'

function isEncryptionRecord(value: unknown): value is EncryptionRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<EncryptionRecord>
  const manifest = record.manifest
  const ciphertext = record.ciphertext
  if (typeof manifest !== 'object' || manifest === null) return false
  if (typeof ciphertext !== 'object' || ciphertext === null) return false
  return (
    typeof record.createdAt === 'string' &&
    typeof record.pdfSize === 'number' &&
    manifest.schema === 'tasra-encrypt/v1' &&
    typeof manifest.recordId === 'string' &&
    typeof ciphertext.u === 'string' &&
    typeof ciphertext.nonce === 'string' &&
    typeof ciphertext.aeadCt === 'string'
  )
}

export function listLocalEncryptionRecords(): EncryptionRecord[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEncryptionRecord)
  } catch {
    return []
  }
}

export function saveLocalEncryptionRecord(record: EncryptionRecord): void {
  const records = listLocalEncryptionRecords().filter(
    (r) => r.manifest.recordId !== record.manifest.recordId,
  )
  records.push(record)
  localStorage.setItem(storageKey, JSON.stringify(records))
}