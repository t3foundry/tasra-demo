export async function api<T>(
  path: string,
  data?: unknown,
  owner = false,
): Promise<T> {
  const token = sessionStorage.getItem('sender')
  const response = await fetch('/api' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...(owner && token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const result = (await response.json().catch(() => ({}))) as {
    error?: string
  }
  if (!response.ok) throw new Error(result.error ?? 'Request failed')
  return result as T
}

export function base64(bytes: Uint8Array): string {
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text)
}