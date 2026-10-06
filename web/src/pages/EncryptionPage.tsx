import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { api, base64 } from '../api'
import { digest } from '../../../shared/model'
import type { EncryptionRecord } from '../../../shared/encrypt'
import { useNotice } from '../notice'
import { shortSlot } from '../components'

type KeySlotOption = { slotId: string; name?: string; dcql?: unknown }

type IssueVcResult = { offerUri: string; qrDataUrl: string }

type EncryptionKeyJob = {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: string[]
  result?: { name: string; slotId: string }
  error?: string
}

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

export function EncryptionPage() {
  const notice = useNotice()
  const [keys, setKeys] = useState<KeySlotOption[]>([])
  const [records, setRecords] = useState<EncryptionRecord[]>([])
  const [title, setTitle] = useState('Private agreement')
  const [version, setVersion] = useState('1')
  const [chosen, setChosen] = useState('')
  const [bytes, setBytes] = useState<Uint8Array>()
  const [selectedSlot, setSelectedSlot] = useState('')
  const [busy, setBusy] = useState(false)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState<{
    name: string
    progress: string[]
  } | null>(null)
  const [vcOffer, setVcOffer] = useState<{ name: string; offer: IssueVcResult } | null>(null)
  const [issuingVc, setIssuingVc] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadKeys = useCallback(() => {
    void api<KeySlotOption[]>('/encryption/keys')
      .then(setKeys)
      .catch((e) => notice(e.message))
  }, [notice])

  const loadRecords = useCallback(() => {
    void api<EncryptionRecord[]>('/encryption/documents')
      .then(setRecords)
      .catch((e) => notice(e.message))
  }, [notice])

  useEffect(() => {
    loadKeys()
    loadRecords()
  }, [loadKeys, loadRecords])

  async function createKey() {
    const name = createName.trim().toLowerCase()
    if (!name) {
      notice('Enter a key name')
      return
    }
    const push = (message: string) =>
      setCreating((c) => (c ? { ...c, progress: [...c.progress, message] } : c))
    setCreating({ name, progress: ['Creating the BLS key slot…'] })
    try {
      const { jobId } = await api<{ jobId: string }>('/encryption/keys', { name })
      for (let i = 0; i < 1200; i++) {
        const job = await api<EncryptionKeyJob>('/encryption/keys/jobs/' + jobId)
        if (job.status === 'completed') {
          setCreating(null)
          setCreateName('')
          setKeys((prev) => [...prev, { slotId: job.result!.slotId, name: job.result!.name }])
          notice('BLS encryption key created')
          return
        }
        if (job.status === 'failed')
          throw new Error(job.error ?? 'Key creation failed')
        setCreating((c) => (c ? { ...c, progress: job.progress } : c))
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw new Error('Key creation timed out')
    } catch (e) {
      setCreating(null)
      notice((e as Error).message)
    }
  }

  async function issueVc(name: string) {
    setIssuingVc(name)
    try {
      const offer = await api<IssueVcResult>(
        `/encryption/keys/${encodeURIComponent(name)}/issue-vc`,
        {},
      )
      setVcOffer({ name, offer })
      notice(`Credential offer created for ${name}. Scan with a remote wallet.`)
    } catch (e) {
      notice((e as Error).message)
    } finally {
      setIssuingVc(null)
    }
  }

  async function encrypt() {
    setBusy(true)
    try {
      const upload =
        bytes ?? (fileRef.current?.files?.[0]
          ? new Uint8Array(await fileRef.current.files[0].arrayBuffer())
          : undefined)
      if (!upload) throw new Error('Choose a PDF first')
      if (!selectedSlot) throw new Error('Select a BLS encryption key')
      const fingerprint = JSON.stringify({
        hash: await digest(upload),
        title,
        version,
        slotId: selectedSlot,
      })
      const pending = JSON.parse(
        sessionStorage.getItem('pending-encrypt') ?? 'null',
      ) as { fingerprint: string; id: string } | null
      const id =
        pending?.fingerprint === fingerprint ? pending.id : crypto.randomUUID()
      sessionStorage.setItem(
        'pending-encrypt',
        JSON.stringify({ fingerprint, id }),
      )
      const created = await api<EncryptionRecord>('/encryption/documents', {
        id,
        title,
        version: Number(version),
        slotId: selectedSlot,
        pdfBase64: base64(upload),
      })
      sessionStorage.removeItem('pending-encrypt')
      notice('Document encrypted. Download the bundle to save the ciphertext.')
      await loadRecords()
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
          <div className="eyebrow">Encryption</div>
          <h1>Encrypt a document.</h1>
          <p className="sub">
            Create a BLS identity-encryption key on Tasra, then encrypt a PDF to a scoped
            identity. Only a holder with the matching credential can later open it.
          </p>
        </div>
      </div>
      <div className="grid">
        <div className="stack">
          <section className="panel">
            <h2>Encrypt a document</h2>
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
            <div className="field">
              <label htmlFor="key">BLS encryption key</label>
              {keys.length ? (
                <div className="signer-list">
                  {keys.map((k) => (
                    <label className="consent" key={k.slotId}>
                      <input
                        type="radio"
                        name="encryption-key"
                        checked={selectedSlot === k.slotId}
                        onChange={() => setSelectedSlot(k.slotId)}
                      />
                      <span>
                        {k.name ?? shortSlot(k.slotId)}
                        {k.name ? (
                          <small className="muted"> {shortSlot(k.slotId)}</small>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="hint">Loading BLS key slots from the registry…</p>
              )}
            </div>
            <p className="hint">
              Encryption binds the document to a scoped identity under the issuer. The
              plaintext never leaves the browser except for the encrypted ciphertext.
            </p>
            <button className="primary" disabled={busy} onClick={encrypt}>
              Encrypt document
            </button>
          </section>

          <section className="panel">
            <h2>Encrypted documents</h2>
            {records.length ? (
              records.map((r) => (
                <div className="request" key={r.manifest.recordId}>
                  <div>
                    <strong>{r.manifest.title}</strong>
                    <small>
                      Version {r.manifest.version} ·{' '}
                      {Math.round(r.pdfSize / 1024)} KB plaintext
                    </small>
                  </div>
                  <div className="actions">
                    <a
                      className="button small"
                      href={`/api/encryption/documents/${r.manifest.recordId}/bundle`}
                    >
                      Download ciphertext
                    </a>
                  </div>
                </div>
              ))
            ) : (
              <p className="empty">Your first encrypted document will appear here.</p>
            )}
          </section>
        </div>

        <aside className="side stack">
          <section className="panel">
            <h2>BLS encryption keys</h2>
            <p className="hint">
              Each key is a 2-of-3 BLS slot gated by a DocumentReader credential scope.
              Creating a key funds it with TSRA from the creator wallet.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void createKey()
              }}
            >
              <label htmlFor="new-key-name">New key name</label>
              <div className="row">
                <input
                  id="new-key-name"
                  type="text"
                  value={createName}
                  maxLength={32}
                  placeholder="e.g. notes"
                  onChange={(e) => setCreateName(e.target.value)}
                />
                <button
                  className="primary"
                  type="submit"
                  disabled={!createName.trim() || creating !== null}
                >
                  Create
                </button>
              </div>
            </form>
            {keys.length ? (
              keys.map((k) => (
                <Fragment key={k.slotId}>
                  <div className="request">
                    <div>
                    <strong>{k.name ?? 'Unnamed key'}</strong>
                    <small>
                      <a
                        href={explorer(k.slotId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {shortSlot(k.slotId)} ↗
                      </a>
                    </small>
                    {k.dcql ? (
                      <details className="dcql">
                        <summary>Configured DCQL</summary>
                        <pre className="code">{JSON.stringify(k.dcql, null, 2)}</pre>
                      </details>
                    ) : null}
                  </div>
                  {k.name ? (
                    <button
                      className="small"
                      disabled={issuingVc !== null}
                      onClick={() => void issueVc(k.name!)}
                    >
                      {issuingVc === k.name ? 'Creating QR…' : 'Issue VC'}
                    </button>
                  ) : null}
                </div>
                {k.name && vcOffer && vcOffer.name === k.name ? (
                  <div className="vc-offer">
                    <img
                      src={vcOffer.offer.qrDataUrl}
                      alt="Credential offer QR code"
                      width={200}
                      height={200}
                    />
                    <p className="hint">
                      Scan with a remote wallet to receive this key’s DocumentReader
                      credential. Offer expires in 30 minutes.
                    </p>
                    <div className="linkbox">
                      <small>{vcOffer.offer.offerUri}</small>
                    </div>
                  </div>
                ) : null}
              </Fragment>
            ))
            ) : (
              <p className="hint">No BLS keys found.</p>
            )}
          </section>
        </aside>
      </div>

      {creating ? (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Creating BLS key {creating.name}</h2>
            <ol className="progress">
              {creating.progress.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
            <p className="hint">This can take a minute or two. Do not close this page.</p>
          </div>
        </div>
      ) : null}
    </>
  )
}