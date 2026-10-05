import { useCallback, useEffect, useRef, useState } from 'react'
import { api, base64 } from '../api'
import { digest, people, type PublicRequest } from '../../../shared/model'
import { useNotice } from '../notice'
import { useSender } from '../sender'
import { Badge, Recipients, Timeline, Downloads, name } from '../components'

export function Dashboard() {
  const notice = useNotice()
  const sender = useSender()
  const [list, setList] = useState<PublicRequest[]>([])
  const [selected, setSelected] = useState<PublicRequest>()
  const [title, setTitle] = useState('Consulting agreement')
  const [version, setVersion] = useState('1')
  const [chosen, setChosen] = useState('')
  const [bytes, setBytes] = useState<Uint8Array>()
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const l = await api<PublicRequest[]>('/requests', undefined, true)
    setList(l)
    setSelected((prev) => {
      if (!prev) return prev
      return l.find((r) => r.manifest.requestId === prev.manifest.requestId) ?? prev
    })
  }, [])

  useEffect(() => {
    if (sender) void load().catch((e) => notice(e.message))
  }, [sender, load, notice])

  async function send() {
    setBusy(true)
    try {
      const upload =
        bytes ?? (fileRef.current?.files?.[0]
          ? new Uint8Array(await fileRef.current.files[0].arrayBuffer())
          : undefined)
      if (!upload) throw new Error('Choose a PDF first')
      const fingerprint = JSON.stringify({
        hash: await digest(upload),
        title,
        version,
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
      const created = await api<PublicRequest>(
        '/requests',
        { id, title, version: Number(version), pdfBase64: base64(upload) },
        true,
      )
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

  if (!sender) {
    return (
      <>
        <h1>Your signing workspace</h1>
        <p>
          Open the private sender-console link printed by <code>npm run serve</code>, or
          open your Alice or Bob invitation.
        </p>
      </>
    )
  }

  return (
    <>
      <div className="topline">
        <div>
          <div className="eyebrow">Documents</div>
          <h1>From draft to signed.</h1>
          <p className="sub">
            Upload a PDF. Invite Alice, then Bob. Keep a verifiable record of their
            approval.
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
                  onChange={(e) => setVersion(e.target.value)}
                />
              </div>
            </div>
            <div className="drop">
              <p>Choose your PDF · up to 8 MB</p>
              <input
                id="pdf"
                type="file"
                accept="application/pdf"
                onChange={() => {
                  setBytes(undefined)
                  setChosen(fileRef.current?.files?.[0]?.name ?? '')
                }}
                ref={fileRef}
              />
              <p className="hint">Or start with the included sample agreement.</p>
              <button
                className="small"
                onClick={async () => {
                  setBytes(new Uint8Array(await (await fetch('/sample.pdf')).arrayBuffer()))
                  setChosen('Sample agreement selected')
                }}
              >
                Use sample PDF
              </button>
            </div>
            <p className="hint">{chosen}</p>
            <p className="hint">
              Both Alice and Bob must sign. Sending freezes the PDF, version and recipients.
            </p>
            <button className="primary" disabled={busy} onClick={send}>
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
                  <button
                    className="small"
                    onClick={() => setSelected(r)}
                  >
                    {r.status.replaceAll('_', ' ')}
                  </button>
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
                {people.map((p) => (
                  <div key={p}>
                    <h3>{name(p)}’s invitation</h3>
                    <div className="linkbox">
                      <a
                        href={`/sign/${selected.manifest.requestId}/${p}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {location.origin}/sign/{selected.manifest.requestId}/{p}
                      </a>
                    </div>
                    <button
                      className="small"
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          `${location.origin}/sign/${selected.manifest.requestId}/${p}`,
                        )
                        notice('Invitation copied')
                      }}
                    >
                      Copy {name(p)}’s link
                    </button>
                    <div className="divider"></div>
                  </div>
                ))}
                <Downloads r={selected} />
                {['awaiting_alice', 'awaiting_bob'].includes(selected.status) ? (
                  <>
                    <div className="divider"></div>
                    <button
                      className="small"
                      onClick={async () => {
                        await api(`/requests/${selected.manifest.requestId}/cancel`, {}, true)
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