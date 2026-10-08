import { useCallback, useEffect, useState } from 'react'
import { api, base64 } from '../api'
import { digest, type PublicRequest } from '../../../shared/model'
import { useNotice } from '../notice'
import { Badge, Recipients, Timeline, Downloads, name, shortSlot } from '../components'
import { FileUpload, type UploadedFile } from '../FileUpload'

type KeySlotOption = { slotId: string; name?: string }

const requestStatus: Record<PublicRequest['status'], string> = {
  awaiting: 'Pending',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
}

export function Dashboard() {
  const notice = useNotice()
  const [list, setList] = useState<PublicRequest[]>([])
  const [selected, setSelected] = useState<PublicRequest>()
  const [title, setTitle] = useState('')
  const [version, setVersion] = useState('')
  const [pdf, setPdf] = useState<UploadedFile | null>(null)
  const [busy, setBusy] = useState(false)
  const [allSlots, setAllSlots] = useState<KeySlotOption[]>([])
  const [selectedSlots, setSelectedSlots] = useState<string[]>([])
  const [slotFilter, setSlotFilter] = useState('')

  const load = useCallback(async () => {
    const l = await api<PublicRequest[]>('/requests')
    setList(l)
    setSelected((prev) => {
      if (!prev) return prev
      return l.find((r) => r.manifest.requestId === prev.manifest.requestId) ?? prev
    })
  }, [])

  useEffect(() => {
    void load().catch((e) => notice(e.message))
  }, [load, notice])

  useEffect(() => {
    void api<KeySlotOption[]>('/key-slots')
      .then(setAllSlots)
      .catch((e) => notice(e.message))
  }, [notice])

  function toggle(slotId: string) {
    setSelectedSlots((prev) =>
      prev.includes(slotId)
        ? prev.filter((s) => s !== slotId)
        : [...prev, slotId],
    )
  }

  const visibleSlots = slotFilter
    ? allSlots.filter((s) =>
        s.slotId.toLowerCase().includes(slotFilter.toLowerCase()),
      )
    : allSlots

  async function send() {
    setBusy(true)
    try {
      const upload = pdf?.bytes
      if (!upload) throw new Error('Choose a PDF first')
      if (!selectedSlots.length) throw new Error('Select at least one signer')
      const fingerprint = JSON.stringify({
        hash: await digest(upload),
        title,
        version,
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
        version: Number(version),
        pdfBase64: base64(upload),
        signers,
      })
      sessionStorage.removeItem('pending-request')
      setSelected(created)
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
      <div className="grid">
        <div className="stack">
          <section className="panel">
            <h2>Send a document</h2>
            <div className="row">
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
              <div className="field">
                <label htmlFor="version">Version</label>
                <input
                  id="version"
                  type="number"
                  value={version}
                  min={1}
                  placeholder="e.g. 1"
                  onChange={(e) => setVersion(e.target.value)}
                />
              </div>
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
            <div className="field">
              <label htmlFor="slot-filter">Signers</label>
              <input
                id="slot-filter"
                type="text"
                placeholder="Filter by key-slot ID…"
                value={slotFilter}
                onChange={(e) => setSlotFilter(e.target.value)}
              />
              {allSlots.length ? (
                <div className="signer-list">
                  {visibleSlots.map((slot) => (
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
                  {visibleSlots.length === 0 ? (
                    <p className="hint">No key slots match that ID.</p>
                  ) : null}
                </div>
              ) : (
                <p className="hint">Loading key slots from the registry…</p>
              )}
            </div>
            <p className="hint">
              Sending freezes the PDF, version and the selected signers.
            </p>
            <button
              className="primary"
              disabled={
                busy ||
                !title.trim() ||
                !version.trim() ||
                !pdf ||
                selectedSlots.length === 0
              }
              onClick={send}
            >
              Create signing request
            </button>
          </section>

          <section className="panel">
            <h2>Your requests</h2>
            {list.length ? (
              list.map((r) => (
                <div className="request" key={r.manifest.requestId}>
                  <div>
                    <strong>{r.manifest.title}</strong>
                    <small>
                      Version {r.manifest.version} · {r.manifest.requestId.slice(0, 8)}
                    </small>
                  </div>
                  <div className="request-actions">
                    <span className={'status-pill ' + r.status}>
                      {requestStatus[r.status]}
                    </span>
                    <button className="small" onClick={() => setSelected(r)}>
                      Review
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="empty">Your first request will appear here.</p>
            )}
          </section>
        </div>

        <aside className="side stack">
          {selected ? (
            <>
              <section className="panel">
                <h2>{selected.manifest.title}</h2>
                <Badge status={selected.status} />
                <Recipients r={selected} />
                {selected.manifest.signers.map((s) => (
                  <div key={s.slotId}>
                    <h3>
                      <a
                        href={`/sign/${selected.manifest.requestId}/${s.slotId}`}
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
                          `${location.origin}/sign/${selected.manifest.requestId}/${s.slotId}`,
                        )
                        notice('Invitation copied')
                      }}
                    >
                      Copy {s.name ? name(s.name) : 'signer'}’s link
                    </button>
                    <div className="divider"></div>
                  </div>
                ))}
                <Downloads r={selected} />
                {selected.status === 'awaiting' ? (
                  <>
                    <div className="divider"></div>
                    <button
                      className="small"
                      onClick={async () => {
                        await api(`/requests/${selected.manifest.requestId}/cancel`, {})
                        await load()
                      }}
                    >
                      Cancel request
                    </button>
                  </>
                ) : null}
              </section>
              <Timeline r={selected} />
            </>
          ) : null}
        </aside>
      </div>
    </>
  )
}