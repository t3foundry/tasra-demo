import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { digest, type Person, type PublicRequest } from '../../../shared/model'
import {
  importWallet,
  present,
  declineProof,
  type DemoWallet,
  type PublicSession,
} from '../../../shared/wallet'
import { useNotice } from '../notice'
import { Badge, Recipients, Downloads, name } from '../components'
import { PdfPreview } from '../PdfPreview'

export function SignerPage() {
  const { id = '', person = 'alice' } = useParams()
  const p = person as Person
  const notice = useNotice()

  const [config, setConfig] = useState<{ verifierAgentUrl: string }>()
  const [r, setR] = useState<PublicRequest>()
  const [reviewedBytes, setReviewedBytes] = useState<Uint8Array>()
  const [reviewedHash, setReviewedHash] = useState('')
  const [wallet, setWallet] = useState<DemoWallet>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const walletNameRef = useRef<HTMLParagraphElement>(null)

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
        const [cfg, initial] = await Promise.all([
          api<{ verifierAgentUrl: string }>('/config'),
          api<PublicRequest>('/requests/' + id),
        ])
        if (!active) return
        setConfig(cfg)
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

  if (!r || !config) return <p>Opening your document workspace…</p>

  const state = r.signers[p]
  const closed = ['completed', 'cancelled', 'declined'].includes(r.status)
  const blocked =
    closed ||
    state.phase === 'signed' ||
    ['uncertain', 'opening', 'signing'].includes(state.phase)

  async function loadWallet(f: File) {
    setWallet(undefined)
    try {
      const w = importWallet(await f.text())
      setWallet(w)
      if (walletNameRef.current)
        walletNameRef.current.textContent = 'Loaded: ' + name(w.name)
    } catch (e) {
      notice((e as Error).message)
    }
  }

  async function handleSign() {
    if (!wallet || !config || !r) return
    setBusy(true)
    busyRef.current = true
    notice('Requesting your wallet approval…')
    try {
      const prepared = await api<PublicRequest>(
        `/requests/${id}/${p}/prepare`,
        { documentSha256: reviewedHash },
      )
      const attemptId = prepared.signers[p].attemptId!
      const session = await api<PublicSession>(
        `/requests/${id}/${p}/session`,
        { attemptId },
      )
      const transport: typeof fetch = async (input, init) => {
        const result = await api<{ status: number; contentType: string; body: string }>(
          `/requests/${id}/${p}/transport`,
          {
            attemptId,
            url: String(input),
            method: init?.method ?? 'GET',
            body: init?.body?.toString(),
          },
        )
        return new Response(result.status === 204 ? null : result.body, {
          status: result.status,
          headers: { 'content-type': result.contentType ?? 'text/plain' },
        })
      }
      if (session.status === 'pending')
        await present(wallet, r.manifest, p, session, config.verifierAgentUrl, transport)
      notice('Verifying your approval and saving the signature…')
      await api(`/requests/${id}/${p}/complete`, { attemptId })
      notice('Signature verified and saved')
    } catch (e) {
      notice((e as Error).message)
    } finally {
      setBusy(false)
      busyRef.current = false
      await refresh()
    }
  }

  async function handleDecline() {
    if (!wallet || !r) return
    setBusy(true)
    busyRef.current = true
    try {
      await api(`/requests/${id}/${p}/decline`, {
        proof: declineProof(wallet, r.manifest, p),
      })
      notice('Document declined')
    } catch (e) {
      notice((e as Error).message)
    } finally {
      setBusy(false)
      busyRef.current = false
      await refresh()
    }
  }

  return (
    <>
      <div className="topline">
        <div>
          <div className="eyebrow">Signature request · {name(p)}</div>
          <h1>{r.manifest.title}</h1>
          <p className="sub">Please review the document, then confirm your approval.</p>
          <div className="meta">
            Version {r.manifest.version} · Two signatures required
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
            {!blocked ? (
              <div className="wallet">
                <label htmlFor="wallet">Your demo wallet file</label>
                <input
                  id="wallet"
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void loadWallet(f)
                  }}
                />
                <p ref={walletNameRef}>
                  {wallet ? 'Loaded: ' + name(wallet.name) : 'Choose the private file provided to you.'}
                </p>
                <p className="hint">
                  The wallet key stays in this browser tab. Only an encrypted credential
                  presentation is sent.
                </p>
              </div>
            ) : null}
            {!blocked ? (
              <>
                <button
                  className="primary wide"
                  disabled={!wallet || busy}
                  onClick={handleSign}
                >
                  Approve and sign
                </button>
                <button
                  className="wide small"
                  disabled={!wallet || busy}
                  onClick={handleDecline}
                >
                  Decline document
                </button>
              </>
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