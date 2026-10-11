export type LocalEncryptionKey = { name: string; slotId: string }

const storageKey = 'tasra-encryption-keys'
// Legacy store kept so keys created before the pending/issued split was removed
// still show up in the same list.
const legacyPendingKey = 'tasra-encryption-keys-pending'

function readKeys(storage: string): LocalEncryptionKey[] {
  try {
    const raw = localStorage.getItem(storage)
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

export function listLocalEncryptionKeys(): LocalEncryptionKey[] {
  const keys: LocalEncryptionKey[] = []
  const seen = new Set<string>()
  for (const entry of [...readKeys(storageKey), ...readKeys(legacyPendingKey)]) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    keys.push(entry)
  }
  return keys
}

export function saveLocalEncryptionKey(record: LocalEncryptionKey): void {
  const keys = listLocalEncryptionKeys().filter((k) => k.name !== record.name)
  keys.push(record)
  localStorage.setItem(storageKey, JSON.stringify(keys))
}
