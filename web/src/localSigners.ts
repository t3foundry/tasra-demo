export type LocalSigner = { name: string; slotId: string }

const walletPrefix = 'tasra-wallet:'
const pendingPrefix = 'tasra-pending:'

export const walletKey = (person: string) => walletPrefix + person
export const pendingKey = (person: string) => pendingPrefix + person

function readSigners(prefix: string): LocalSigner[] {
  const signers: LocalSigner[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(prefix)) continue
    const raw = localStorage.getItem(key)
    if (!raw) continue
    try {
      const value = JSON.parse(raw) as { name?: string; slotId?: string }
      if (
        typeof value.name === 'string' &&
        typeof value.slotId === 'string' &&
        /^0x[0-9a-f]{64}$/i.test(value.slotId)
      )
        signers.push({ name: value.name, slotId: value.slotId })
    } catch {
      // Ignore malformed wallet entries.
    }
  }
  return signers
}

export function listLocalSigners(): LocalSigner[] {
  const seen = new Set<string>()
  const signers: LocalSigner[] = []
  for (const s of [...readSigners(walletPrefix), ...readSigners(pendingPrefix)]) {
    if (seen.has(s.slotId)) continue
    seen.add(s.slotId)
    signers.push(s)
  }
  return signers
}

export function listPendingSigners(): LocalSigner[] {
  return readSigners(pendingPrefix)
}

export function promotePendingSigner(name: string) {
  const raw = localStorage.getItem(pendingKey(name))
  if (!raw) return
  localStorage.setItem(walletKey(name), raw)
  localStorage.removeItem(pendingKey(name))
}