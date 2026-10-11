import { useEffect, useState } from 'react'
import { api } from './api'

export type DemoVideoId = 'department-signing' | 'send-encrypted-email-attachment'

/** Fetch a server-signed demo video URL (presigned S3, valid 24h). */
export function useDemoVideoUrl(id: DemoVideoId): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    api<Record<string, string>>('/videos')
      .then((urls) => {
        if (alive) setUrl(urls[id])
      })
      .catch(() => {
        // Leave the video unset on failure rather than surfacing an error.
      })
    return () => {
      alive = false
    }
  }, [id])
  return url
}
