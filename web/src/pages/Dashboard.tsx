import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, base64 } from '../api'
import { digest, type PublicRequest, type SignerState } from '../../../shared/model'
import { useNotice } from '../notice'
import {
  Recipients,
  Timeline,
  Downloads,
  name,
  shortSlot,
  signerLabel,
} from '../components'
import { FileUpload, type UploadedFile } from '../FileUpload'
import { listLocalSigners } from '../localSigners'

type KeySlotOption = { slotId: string; name?: string }

const requestStatus: Record<PublicRequest['status'], string> = {
  awaiting: 'Pending',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
}

function createdMs(r: PublicRequest): number {
  const first = r.history[0]
  return first ? new Date(first.at).getTime() : 0
}

function signerStatus(s: SignerState): 'signed' | 'refused' | 'pending' {
  if (s.signature || s.phase === 'signed') return 'signed'
  if (s.phase === 'refused') return 'refused'
  return 'pending'
}

export function Dashboard() {
  const notice = useNotice()
  const [list, setList] = useState<PublicRequest[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [pdf, setPdf] = useState<UploadedFile | null>(null)
  const [busy, setBusy] = useState(false)
  const [allSlots, setAllSlots] = useState<KeySlotOption[]>([])
  const [selectedSlots, setSelectedSlots] = useState<string[]>([])

  const load = useCallback(async () => {
    const l = await api<PublicRequest[]>('/requests')
    const sorted = [...l].sort((a, b) => createdMs(b) - createdMs(a))
    setList(sorted)
    setExpandedId((prev) => {
      if (!prev) return prev
      return sorted.some((r) => r.manifest.requestId === prev) ? prev : null
    })
  }, [])

  useEffect(() => {
    void load().catch((e) => notice(e.message))
  }, [load, notice])

  useEffect(() => {
    setAllSlots(listLocalSigners().map((s) => ({ slotId: s.slotId, name: s.name })))
  }, [])

  function toggle(slotId: string) {
    setSelectedSlots((prev) =>
      prev.includes(slotId)
        ? prev.filter((s) => s !== slotId)
        : [...prev, slotId],
    )
  }

  function toggleRequest(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  async function send() {
    setBusy(true)
    try {
      const upload = pdf?.bytes
      if (!upload) throw new Error('Choose a PDF first')
      if (!selectedSlots.length) throw new Error('Select at least one signer')
      const fingerprint = JSON.stringify({
        hash: await digest(upload),
        title,
        signers: [...selectedSlots].sort(),
      })
      const pending = JSON.parse(
        sessionStorage.getItem('pending-request') ?? 'null',
      ) as { fingerprint: string; id: string } | null
      const id =
        pending?.fingerprint === fingerprint ? pending.id : crypto.randomUUID()
      sessionStorage.setItem(
        'pending-request',
        JSON.stringify({ fingerprint, id }),
      )
      const signers = selectedSlots.map((slotId) => {
        const slot = allSlots.find((s) => s.slotId === slotId)
        return { slotId, ...(slot?.name ? { name: slot.name } : {}) }
      })
      const created = await api<PublicRequest>('/requests', {
        id,
        title,
        version: 1,
        pdfBase64: base64(upload),
        signers,
      })
      sessionStorage.removeItem('pending-request')
      setExpandedId(created.manifest.requestId)
      notice('Request created. Share each signer’s invitation.')
      await load()
    } catch (e) {
      notice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topline">
        <div>
          <div className="eyebrow">Documents</div>
          <h1>From draft to signed.</h1>
          <p className="sub">
            Upload a PDF. Choose any signers from the registry, then keep a verifiable
            record of their approval.
          </p>
        </div>
      </div>
      <div className="stack">
        <section className="panel">
          <h2>Send a document</h2>

          <div className="send-step">
            <div className="send-step-head">
              <span className="send-step-num" aria-hidden="true">
                1
              </span>
              <div>
                <h3 className="send-step-title">Name & attach</h3>
                <p className="send-step-sub">Give the document a title and add its PDF.</p>
              </div>
            </div>
            <div className="field">
              <label htmlFor="title">Document title</label>
              <input
                id="title"
                type="text"
                value={title}
                maxLength={120}
                placeholder="e.g. Consulting agreement"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <FileUpload
              file={pdf}
              onChange={setPdf}
              accept="application/pdf"
              extensions={['pdf']}
              label="Drag & drop your PDF here"
              typeLabel="PDF"
              sampleUrl="/sample.pdf"
              sampleLabel="Use sample PDF"
              sampleHint="Or start with the included sample agreement."
            />
          </div>

          <div className="send-step">
            <div className="send-step-head">
              <span className="send-step-num" aria-hidden="true">
                2
              </span>
              <div>
                <h3 className="send-step-title">Configure & assign</h3>
                <p className="send-step-sub">Choose who signs and who else receives a copy.</p>
              </div>
            </div>
            <div className="field">
              <label>Signatures</label>
              {allSlots.length ? (
                <>
                  <div className="signer-list">
                    {allSlots.map((slot) => (
                      <label className="consent" key={slot.slotId}>
                        <input
                          type="checkbox"
                          checked={selectedSlots.includes(slot.slotId)}
                          onChange={() => toggle(slot.slotId)}
                        />
                        <span>
                          {slot.name ? name(slot.name) : shortSlot(slot.slotId)}
                          {slot.name ? (
                            <small className="muted"> {shortSlot(slot.slotId)}</small>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                  <Link className="new-signature-link" to="/signers">
                    + Create a new signature
                  </Link>
                </>
              ) : (
                <div className="no-signatures">
                  <p>No signatures yet. Create one to start signing documents.</p>
                  <Link className="button small" to="/signers">
                    Create a new signature
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="send-step send-step-foot">
            <p className="hint">
              Sending freezes the PDF and the selected signatures.
            </p>
            <button
              className="primary"
              disabled={
                busy || !title.trim() || !pdf || selectedSlots.length === 0
              }
              onClick={send}
            >
              Create signing request
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Signing Requests</h2>
          {list.length ? (
            list.map((r) => {
              const expanded = expandedId === r.manifest.requestId
              const signed = r.signers.filter(
                (s) => signerStatus(s) === 'signed',
              ).length
              return (
                <div className="request" key={r.manifest.requestId}>
                  <div className="request-row">
                    <div>
                      <strong className="request-title">{r.manifest.title}</strong>
                      <small className="request-meta">
                        {r.signers.length} signer{r.signers.length === 1 ? '' : 's'} ·{' '}
                        {signed} of {r.signers.length} signed ·{' '}
                        {r.manifest.requestId.slice(0, 8)}
                      </small>
                      <div className="signer-stamps">
                        {r.signers.map((s) => (
                          <span
                            key={s.slotId}
                            className={'signer-stamp ' + signerStatus(s)}
                          >
                            {signerLabel(s)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="request-actions">
                      <span className={'status-pill ' + r.status}>
                        {requestStatus[r.status]}
                      </span>
                      {r.status === 'completed' ? (
                        <a
                          className="button small"
                          href={`/api/requests/${r.manifest.requestId}/bundle.zip`}
                        >
                          Download Bundle
                        </a>
                      ) : null}
                      <button
                        className="small"
                        aria-expanded={expanded}
                        onClick={() => toggleRequest(r.manifest.requestId)}
                      >
                        {expanded
                          ? 'Hide'
                          : r.status === 'completed'
                            ? 'View'
                            : 'Review'}
                      </button>
                    </div>
                  </div>

                  {expanded ? (
                    <div className="request-details">
                      <div className="request-details-body">
                        <Recipients r={r} />
                        <div className="divider"></div>
                        {r.manifest.signers.map((s) => (
                          <div key={s.slotId}>
                            <h3>
                              <a
                                href={`/sign/${r.manifest.requestId}/${s.slotId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {s.name ? name(s.name) : shortSlot(s.slotId)}’s invitation ↗
                              </a>
                            </h3>
                            <button
                              className="small"
                              onClick={async () => {
                                await navigator.clipboard.writeText(
                                  `${location.origin}/sign/${r.manifest.requestId}/${s.slotId}`,
                                )
                                notice('Invitation copied')
                              }}
                            >
                              Copy {s.name ? name(s.name) : 'signer'}’s link
                            </button>
                            <div className="divider"></div>
                          </div>
                        ))}
                        <Downloads r={r} />
                        {r.status === 'awaiting' ? (
                          <>
                            <div className="divider"></div>
                            <button
                              className="small"
                              onClick={async () => {
                                await api(
                                  `/requests/${r.manifest.requestId}/cancel`,
                                  {},
                                )
                                await load()
                              }}
                            >
                              Cancel request
                            </button>
                          </>
                        ) : null}
                      </div>
                      <Timeline r={r} />
                    </div>
                  ) : null}
                </div>
              )
            })
          ) : (
            <p className="empty">Your first request will appear here.</p>
          )}
        </section>
      </div>
    </>
  )
}