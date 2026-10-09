export type LocalEncryptionKey = { name: string; slotId: string }

const storageKey = 'tasra-encryption-keys'
const pendingKey = 'tasra-encryption-keys-pending'

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
  return readKeys(storageKey)
}

export function listPendingLocalEncryptionKeys(): LocalEncryptionKey[] {
  return readKeys(pendingKey)
}

export function saveLocalEncryptionKey(record: LocalEncryptionKey): void {
  const keys = listLocalEncryptionKeys().filter((k) => k.name !== record.name)
  keys.push(record)
  localStorage.setItem(storageKey, JSON.stringify(keys))
}

export function savePendingLocalEncryptionKey(record: LocalEncryptionKey): void {
  const keys = listPendingLocalEncryptionKeys().filter(
    (k) => k.name !== record.name,
  )
  keys.push(record)
  localStorage.setItem(pendingKey, JSON.stringify(keys))
}

export function promotePendingEncryptionKey(name: string): void {
  const pending = listPendingLocalEncryptionKeys()
  const found = pending.find((k) => k.name === name)
  if (!found) return
  saveLocalEncryptionKey(found)
  localStorage.setItem(
    pendingKey,
    JSON.stringify(pending.filter((k) => k.name !== name)),
  )
}