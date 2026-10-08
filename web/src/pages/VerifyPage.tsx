import { useState } from 'react'
import { api, base64 } from '../api'
import { FileUpload, type UploadedFile } from '../FileUpload'

type SlotLink = { name?: string; slotId: string }

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)

export function VerifyPage() {
  const [status, setStatus] = useState('')
  const [className, setClassName] = useState('')
  const [slots, setSlots] = useState<SlotLink[]>([])
  const [bundle, setBundle] = useState<UploadedFile | null>(null)

  function success() {
    setClassName('success')
    setStatus('Verified. Alice and Bob signed this exact document and request.')
  }

  async function verifyBundleZip() {
    setStatus('Checking…')
    setClassName('')
    setSlots([])
    try {
      if (!bundle) throw new Error('Select the downloaded bundle (.zip)')
      const result = await api<{ signers?: SlotLink[] }>('/verify-zip', {
        zipBase64: base64(bundle.bytes),
      })
      setSlots(result.signers ?? [])
      success()
    } catch (e) {
      setClassName('error')
      setStatus(e instanceof Error ? e.message : 'Verification failed')
    }
  }

  return (
    <div className="verify">
      <div className="eyebrow">Independent verification</div>
      <h1>Check the agreement.</h1>
      <p className="sub">
        Upload a signed document bundle to verify both signatures against the current
        on-chain keys.
      </p>
      <section className="panel">
        <h2>Verify signed document from downloaded bundle</h2>
        <p className="hint">
          Upload the single <code>bundle.zip</code> you saved after both signatures were
          completed. It contains the document, request and signatures together.
        </p>
        <FileUpload
          file={bundle}
          onChange={setBundle}
          accept="application/zip,.zip"
          extensions={['zip']}
          label="Drag & drop your bundle here"
          typeLabel="ZIP"
        />
        <button
          className="primary"
          disabled={!bundle}
          onClick={verifyBundleZip}
        >
          Verify downloaded bundle
        </button>
        <p id="result" role="status" className={className}>
          {status}
        </p>
        {slots.length ? (
          <p className="hint">
            Key slots:{' '}
            {slots.map((s, i) => (
              <span key={s.slotId}>
                {i > 0 ? ' · ' : ''}
                <a
                  href={explorer(s.slotId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {s.name ? cap(s.name) : s.slotId.slice(0, 12) + '…'}
                </a>
              </span>
            ))}
          </p>
        ) : null}
      </section>
    </div>
  )
}