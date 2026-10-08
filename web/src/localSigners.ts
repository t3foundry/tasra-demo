export type LocalSigner = { name: string; slotId: string }

export const walletKey = (person: string) => `tasra-wallet:${person}`

export function listLocalSigners(): LocalSigner[] {
  const signers: LocalSigner[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('tasra-wallet:')) continue
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