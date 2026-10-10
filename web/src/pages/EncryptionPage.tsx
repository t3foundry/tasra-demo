import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, base64 } from '../api'
import { digest } from '../../../shared/model'
import type { EncryptionRecord } from '../../../shared/encrypt'
import { useNotice } from '../notice'
import { shortSlot } from '../components'
import { FileUpload, type UploadedFile } from '../FileUpload'
import {
  listLocalEncryptionKeys,
  type LocalEncryptionKey,
} from '../localEncryptionKeys'
import {
  listLocalEncryptionRecords,
  saveLocalEncryptionRecord,
} from '../localEncryptionDocuments'

function downloadBundle(record: EncryptionRecord) {
  const bundle = { manifest: record.manifest, ciphertext: record.ciphertext }
  const name = record.manifest.title.replace(/[^\w.-]+/g, '_')
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name + '.encrypted.json'
  anchor.click()
  URL.revokeObjectURL(url)
}

export function EncryptionPage() {
  const notice = useNotice()
  const [keys, setKeys] = useState<LocalEncryptionKey[]>([])
  const [records, setRecords] = useState<EncryptionRecord[]>([])
  const [title, setTitle] = useState('')
  const [pdf, setPdf] = useState<UploadedFile | null>(null)
  const [selectedSlot, setSelectedSlot] = useState('')
  const [busy, setBusy] = useState(false)

  const loadKeys = useCallback(() => {
    setKeys(listLocalEncryptionKeys())
  }, [])

  const loadRecords = useCallback(() => {
    setRecords(
      listLocalEncryptionRecords().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    )
  }, [])

  useEffect(() => {
    loadKeys()
    loadRecords()
  }, [loadKeys, loadRecords])

  async function encrypt() {
    setBusy(true)
    try {
      const upload = pdf?.bytes
      if (!upload) throw new Error('Choose a PDF first')
      const key = keys.find((k) => k.slotId === selectedSlot)
      if (!key) throw new Error('Select a BLS encryption key')
      const fingerprint = JSON.stringify({
        hash: await digest(upload),
        title,
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
        version: 1,
        slotId: selectedSlot,
        keyName: key.name,
        pdfBase64: base64(upload),
      })
      sessionStorage.removeItem('pending-encrypt')
      saveLocalEncryptionRecord(created)
      setTitle('')
      setPdf(null)
      setSelectedSlot('')
      loadRecords()
      notice('Document encrypted. Download the bundle to send the ciphertext.', 'success')
    } catch (e) {
      notice((e as Error).message, 'error')
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
            Select an identity key, lock your PDF to a specific recipient, and ensure only
            someone with the matching credential can open it.
          </p>
        </div>
      </div>
      <div className="grid">
        <div className="stack">
        <section className="panel">
          <h2>Encrypt a document</h2>

          <div className="send-step">
            <div className="send-step-head">
              <span className="send-step-num" aria-hidden="true">
                1
              </span>
              <div>
                <h3 className="send-step-title">Document</h3>
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
                placeholder="e.g. Private agreement"
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
                <h3 className="send-step-title">Encryption key</h3>
                <p className="send-step-sub">
                  Choose the BLS key your document is encrypted to.
                </p>
              </div>
            </div>
            <div className="field">
              <label>BLS encryption key</label>
              {keys.length ? (
                <>
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
                          {k.name}
                          <small className="muted"> {shortSlot(k.slotId)}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <Link className="new-signature-link" to="/keys">
                    + Create a new key
                  </Link>
                </>
              ) : (
                <div className="no-signatures">
                  <p>No encryption keys yet. Create one to encrypt documents.</p>
                  <Link className="button small" to="/keys">
                    Create a key
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="send-step send-step-foot">
            <p className="hint">
              Encryption binds the document to a scoped identity under the issuer. The
              plaintext never leaves the browser except for the encrypted ciphertext.
            </p>
            <button
              className="primary"
              disabled={busy || !title.trim() || !pdf || !selectedSlot}
              onClick={encrypt}
            >
              Encrypt document
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Encrypted documents</h2>
          {records.length ? (
            records.map((r) => (
              <div className="request" key={r.manifest.recordId}>
                <div className="request-row">
                  <div>
                    <strong className="request-title">{r.manifest.title}</strong>
                  </div>
                  <div className="request-actions">
                    <button
                      className="button small"
                      onClick={() => downloadBundle(r)}
                    >
                      Download encrypted document
                    </button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="empty">Your first encrypted document will appear here.</p>
          )}
        </section>
        </div>

        <aside className="side stack">
          <div className="demo-head">
            <h3>Send an encrypted attachment</h3>
            <p>
              Here's a scenario — try to replicate it with the demo: send a confidential
              PDF by email so only the intended recipient can open it.
            </p>
          </div>
          <video
            className="vertical-video"
            controls
            playsInline
            preload="metadata"
            src="https://s3.eu-west-1.filonecontent.com/tasra-videos/send-encrypted-email-attachment.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=G53R2Y4SV19KXEM3K4K6%2F20261010%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20261010T194218Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=c5641d76880a9f273269ec6fda31812000335c00ef73e0775be323081829b6ef"
          />
        </aside>
      </div>
    </>
  )
}
