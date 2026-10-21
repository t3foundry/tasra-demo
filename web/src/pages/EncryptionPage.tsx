import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, base64 } from '../api'
import { digest } from '../../../shared/model'
import { encryptEnvelope, hexToBytes, toBytes } from 'tasra-sdk'
import {
  ENCRYPTION_MAX_PDF_BYTES,
  encodeCompactJwt,
  type EncryptionRecord,
  type EncryptionManifest,
  type EncryptionEnvelope,
} from '../../../shared/encrypt'
import { useNotice } from '../notice'
import { shortSlot } from '../components'
import { FileUpload, type UploadedFile } from '../FileUpload'
import {
  listLocalEncryptionKeys,
  type LocalEncryptionKey,
} from '../localEncryptionKeys'
import {
  listLocalEncryptionRecords,
  localEncryptionStorageBytes,
  removeLocalEncryptionRecord,
  saveLocalEncryptionRecord,
} from '../localEncryptionDocuments'
import { useDemoVideoUrl } from '../videos'

const STORAGE_QUOTA = 5 * 1024 * 1024

function mbLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`
}

function StorageGauge({ used, quota }: { used: number; quota: number }) {
  const ratio = quota <= 0 ? 0 : Math.min(used / quota, 1)
  const pct = Math.round(ratio * 100)
  const fill =
    ratio < 0.7 ? 'var(--success)' : ratio < 0.9 ? 'var(--warn)' : 'var(--danger)'
  return (
    <div
      className="storage-gauge"
      role="meter"
      aria-valuenow={Math.round(used)}
      aria-valuemin={0}
      aria-valuemax={quota}
      aria-label={`Storage used: ${mbLabel(used)} of ${mbLabel(quota)} (${pct}%)`}
    >
      <span className="storage-gauge-label">
        {mbLabel(used)} / {mbLabel(quota)} · {pct}%
      </span>
      <div className="storage-gauge-bar">
        <div className="storage-gauge-fill" style={{ width: `${pct}%`, background: fill }} />
      </div>
    </div>
  )
}

function downloadBundle(record: EncryptionRecord) {
  const bundle = { manifest: record.manifest, envelope: record.envelope }
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
  const [storageBytes, setStorageBytes] = useState(0)
  const [title, setTitle] = useState('')
  const [pdf, setPdf] = useState<UploadedFile | null>(null)
  const [selectedSlot, setSelectedSlot] = useState('')
  const [busy, setBusy] = useState(false)
  const demoVideoUrl = useDemoVideoUrl('send-encrypted-email-attachment')

  const loadKeys = useCallback(() => {
    setKeys(listLocalEncryptionKeys())
  }, [])

  const loadRecords = useCallback(() => {
    setRecords(
      listLocalEncryptionRecords().sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    )
    setStorageBytes(localEncryptionStorageBytes())
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
      const recordId = crypto.randomUUID()

      // 1. Generate a fresh 32-byte AES key and 12-byte nonce in the browser.
      const aesKeyBytes = new Uint8Array(32)
      const nonce = new Uint8Array(12)
      crypto.getRandomValues(aesKeyBytes)
      crypto.getRandomValues(nonce)

      // 2. AES-256-GCM encrypt the PDF locally; the key never leaves the client.
      const aesCryptoKey = await crypto.subtle.importKey(
        'raw',
        aesKeyBytes.buffer as ArrayBuffer,
        'AES-GCM',
        false,
        ['encrypt'],
      )
      const aesCiphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer },
          aesCryptoKey,
          upload.buffer as ArrayBuffer,
        ),
      )

      // 3. The KEM identity (AAD) is the document's SHA-256 hex string.
      const documentSha256 = await digest(upload)
      const aad = new TextEncoder().encode(documentSha256)

      // 4. Resolve the slot's group public key + epoch and deployment chain/key-registry.
      const params = await api<{
        mpk: string
        epoch: number
        slotId: string
        chainId: number
        keyRegistry: string
      }>(`/encryption/keys/${selectedSlot}/group-key`, {})

      // 5. Transport the AES key + nonce in an unsigned compact JWT, then KEM-wrap
      //    that JWT under the slot's group key into a single opaque ciphertext.
      const jwt = encodeCompactJwt({ aesKey: aesKeyBytes, aesNonce: nonce })
      const kemEnv = encryptEnvelope(
        hexToBytes(selectedSlot),
        hexToBytes(params.mpk),
        aad,
        jwt,
        BigInt(params.epoch),
      )

      const envelope: EncryptionEnvelope = {
        encryptedAesKey: base64(toBytes(kemEnv)),
        aesCiphertext: base64(aesCiphertext),
        epoch: params.epoch,
      }
      const manifest: EncryptionManifest = {
        schema: 'tasra-encrypt/v2',
        recordId,
        title: title.trim(),
        version: 1,
        documentSha256,
        chainId: params.chainId,
        keyRegistry: params.keyRegistry as `0x${string}`,
        slotId: selectedSlot as `0x${string}`,
      }
      const record: EncryptionRecord = {
        manifest,
        envelope,
        pdfSize: upload.length,
        createdAt: new Date().toISOString(),
      }
      saveLocalEncryptionRecord(record)
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
            Select a BLS key, encrypt your PDF locally with a fresh AES key, and wrap
            that key so only the matching credential can unlock it.
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
              maxBytes={ENCRYPTION_MAX_PDF_BYTES}
              maxSizeLabel="3 MB"
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
                  Choose the BLS key whose group key wraps your document's AES key.
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
              The PDF is AES-encrypted in this browser; the AES key is then wrapped under
              the slot's group key. Neither the PDF nor the AES key ever reaches the server.
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
          <div className="panel-head">
            <h2>Encrypted documents</h2>
            <StorageGauge used={storageBytes} quota={STORAGE_QUOTA} />
          </div>
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
                    <button
                      className="button small danger"
                      onClick={() => {
                        if (
                          window.confirm(
                            'Remove this encrypted document from this browser? The ciphertext will be permanently lost.',
                          )
                        ) {
                          removeLocalEncryptionRecord(r.manifest.recordId)
                          loadRecords()
                        }
                      }}
                    >
                      Remove
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
            src={demoVideoUrl}
          />
        </aside>
      </div>
    </>
  )
}
