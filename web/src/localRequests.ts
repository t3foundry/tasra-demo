const storageKey = 'tasra-requests-created'

export function listLocalRequestIds(): string[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

export function rememberRequest(id: string): void {
  const ids = listLocalRequestIds()
  if (ids.includes(id)) return
  ids.push(id)
  localStorage.setItem(storageKey, JSON.stringify(ids))
}