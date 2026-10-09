import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { digest, type Hex, type PublicRequest } from '../../../shared/model'
import type { PublicSession } from '../../../shared/wallet'
import { useNotice } from '../notice'
import { Badge, Recipients, Downloads, signerLabel } from '../components'
import { PdfPreview } from '../PdfPreview'

export function SignerPage() {
  const { id = '', slot = '' } = useParams()
  const slotId = slot as Hex
  const notice = useNotice()

  const [r, setR] = useState<PublicRequest>()
  const [reviewedBytes, setReviewedBytes] = useState<Uint8Array>()
  const [reviewedHash, setReviewedHash] = useState('')
  const busyRef = useRef(false)
  const remoteAbortRef = useRef(false)
  const startedRef = useRef(false)
  const [remote, setRemote] = useState<{
    qrPayload: string
    qrDataUrl: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setR(await api<PublicRequest>('/requests/' + id))
    } catch (e) {
      notice((e as Error).message)
    }
  }, [id, notice])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const initial = await api<PublicRequest>('/requests/' + id)
        if (!active) return
        setR(initial)
        const bytes = new Uint8Array(
          await (await fetch(`/api/requests/${id}/pdf`)).arrayBuffer(),
        )
        const hash = await digest(bytes)
        if (hash !== initial.manifest.documentSha256)
          throw new Error('The PDF does not match the signing request')
        setReviewedBytes(bytes)
        setReviewedHash(hash)
      } catch (e) {
        if (active) notice((e as Error).message)
      }
    })()
    return () => {
      active = false
    }
  }, [id, notice])

  useEffect(() => {
    const timer = setInterval(() => {
      if (busyRef.current) return
      void api<PublicRequest>('/requests/' + id)
        .then(setR)
        .catch(() => {})
    }, 2500)
    return () => clearInterval(timer)
  }, [id])

  const runRemoteSign = useCallback(async () => {
    if (!r || !reviewedHash) return
    remoteAbortRef.current = false
    busyRef.current = true
    setRemote(null)
    notice('Opening a secure wallet session…')
    try {
      await api(`/requests/${id}/${slotId}/reset`, {})
      const prepared = await api<PublicRequest>(
        `/requests/${id}/${slotId}/prepare`,
        { documentSha256: reviewedHash },
      )
      const attemptId = prepared.signers.find(
        (s) => s.slotId.toLowerCase() === slotId.toLowerCase(),
      )!.attemptId!
      const session = await api<PublicSession>(
        `/requests/${id}/${slotId}/session`,
        { attemptId },
      )
      if (!session.qrPayload || !session.qrDataUrl)
        throw new Error('The wallet session did not include a QR payload')
      setRemote({ qrPayload: session.qrPayload, qrDataUrl: session.qrDataUrl })
      notice('Scan the QR with the signer’s remote wallet')
      const deadline = Date.now() + 5 * 60 * 1000
      while (true) {
        if (remoteAbortRef.current) {
          await api(`/requests/${id}/${slotId}/reset`, {})
          return
        }
        const status = await api<PublicSession>(
          `/requests/${id}/${slotId}/session`,
          { attemptId },
        )
        if (remoteAbortRef.current) {
          await api(`/requests/${id}/${slotId}/reset`, {})
          return
        }
        if (status.status === 'done') {
          setRemote(null)
          notice('Wallet approved; verifying and saving the signature…')
          await api(`/requests/${id}/${slotId}/complete`, { attemptId })
          notice('Signature verified and saved')
          return
        }
        if (status.status === 'failed')
          throw new Error(
            status.error ?? 'The wallet or verifier refused this presentation',
          )
        if (Date.now() > deadline) throw new Error('Remote wallet session timed out')
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } catch (e) {
      setRemote(null)
      notice((e as Error).message)
    } finally {
      busyRef.current = false
      await refresh()
    }
  }, [r, reviewedHash, id, slotId, notice, refresh])

  useEffect(() => {
    if (startedRef.current || !r || !reviewedHash) return
    const signer = r.signers.find(
      (s) => s.slotId.toLowerCase() === slotId.toLowerCase(),
    )
    if (!signer) return
    const closed = ['completed', 'cancelled', 'declined'].includes(r.status)
    if (
      closed ||
      signer.phase === 'signed' ||
      ['uncertain', 'opening', 'signing'].includes(signer.phase)
    )
      return
    startedRef.current = true
    void runRemoteSign()
  }, [r, reviewedHash, slotId, runRemoteSign])

  if (!r) return <p>Opening your document workspace…</p>

  const state = r.signers.find(
    (s) => s.slotId.toLowerCase() === slotId.toLowerCase(),
  )
  if (!state) return <p>This request does not include that signer.</p>
  const closed = ['completed', 'cancelled', 'declined'].includes(r.status)
  const blocked =
    closed ||
    state.phase === 'signed' ||
    ['uncertain', 'opening', 'signing'].includes(state.phase)

  async function copyRemote() {
    if (!remote) return
    try {
      await navigator.clipboard.writeText(remote.qrPayload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      notice('Could not copy: ' + (e as Error).message)
    }
  }

  async function cancelRemote() {
    remoteAbortRef.current = true
    setRemote(null)
    setCopied(false)
    try {
      await api(`/requests/${id}/${slotId}/reset`, {})
      notice('Remote signature cancelled')
    } catch (e) {
      notice((e as Error).message)
    }
  }

  return (
    <>
      <div className="topline">
        <div>
          <div className="eyebrow">Signature request · {signerLabel(state)}</div>
          <h1>{r.manifest.title}</h1>
          <p className="sub">Please review the document, then confirm your approval.</p>
          <div className="meta">
            Version {r.manifest.version} · {r.manifest.signers.length} signer
            {r.manifest.signers.length === 1 ? '' : 's'} required
          </div>
        </div>
        <Badge status={r.status} />
      </div>
      <div className="grid">
        <section className="panel pdf">
          <div className="pdf-head">
            <span>
              {r.manifest.title} · v{r.manifest.version}
            </span>
            <a href={`/api/requests/${id}/pdf`} target="_blank" rel="noopener noreferrer">
              Open PDF ↗
            </a>
          </div>
          {reviewedBytes ? <PdfPreview bytes={reviewedBytes} /> : 'Loading PDF…'}
          <small>Review the complete document before signing.</small>
        </section>

        <aside className="side stack">
          <section className="panel">
            <h2>{state.phase === 'signed' ? 'Your signature is saved' : 'Your signature'}</h2>
            <Recipients r={r} />
            {state.phase === 'uncertain' ? (
              <p className="error">
                The signing outcome needs reconciliation. Keep this request; do not create a
                replacement signature.
              </p>
            ) : null}
            {remote ? (
              <div className="vc-offer">
                <img
                  src={remote.qrDataUrl}
                  alt="Remote signature QR code"
                  width={200}
                  height={200}
                />
                <p className="hint">
                  Scan this QR with the signer’s remote wallet to authorize the
                  signature, or copy the session URL below into it.
                </p>
                <div className="linkbox">{remote.qrPayload}</div>
                <div className="actions">
                  <button className="small" type="button" onClick={copyRemote}>
                    {copied ? 'Copied' : 'Copy session URL'}
                  </button>
                  <button
                    className="small"
                    type="button"
                    onClick={() => void cancelRemote()}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : state.phase === 'signed' ? null : !blocked ? (
              <p className="hint">Opening your secure signing session…</p>
            ) : null}
            {state.phase === 'signed' ? (
              <p className="success">Your approval has been verified and saved.</p>
            ) : null}
            <div className="divider"></div>
            <Downloads r={r} />
          </section>
        </aside>
      </div>
    </>
  )
}