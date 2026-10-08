export type LocalEncryptionKey = { name: string; slotId: string }

const storageKey = 'tasra-encryption-keys'

export function listLocalEncryptionKeys(): LocalEncryptionKey[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is LocalEncryptionKey =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        typeof (entry as { slotId?: unknown }).slotId === 'string' &&
        /^0x[0-9a-f]{64}$/i.test((entry as { slotId: string }).slotId),
    )
  } catch {
    return []
  }
}

export function saveLocalEncryptionKey(record: LocalEncryptionKey): void {
  const keys = listLocalEncryptionKeys().filter((k) => k.name !== record.name)
  keys.push(record)
  localStorage.setItem(storageKey, JSON.stringify(keys))
}