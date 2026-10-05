import { useRef, useState } from 'react'
import { api, base64 } from '../api'

type SlotLink = { name?: string; slotId: string }

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)

export function VerifyPage() {
  const [status, setStatus] = useState('')
  const [className, setClassName] = useState('')
  const [slots, setSlots] = useState<SlotLink[]>([])
  const originalRef = useRef<HTMLInputElement>(null)
  const expectedRef = useRef<HTMLInputElement>(null)
  const bundleRef = useRef<HTMLInputElement>(null)
  const bundleZipRef = useRef<HTMLInputElement>(null)

  function success() {
    setClassName('success')
    setStatus('Verified. Alice and Bob signed this exact document and request.')
  }

  async function verify() {
    setStatus('Checking…')
    setClassName('')
    setSlots([])
    try {
      const original = originalRef.current?.files?.[0]
      const expected = expectedRef.current?.files?.[0]
      const bundle = bundleRef.current?.files?.[0]
      if (!original || !expected || !bundle) throw new Error('Select all three files')
      const result = await api<{ signers?: SlotLink[] }>('/verify', {
        pdfBase64: base64(new Uint8Array(await original.arrayBuffer())),
        expected: JSON.parse(await expected.text()),
        bundle: JSON.parse(await bundle.text()),
      })
      setSlots(result.signers ?? [])
      success()
    } catch (e) {
      setClassName('error')
      setStatus(e instanceof Error ? e.message : 'Verification failed')
    }
  }

  async function verifyBundleZip() {
    setStatus('Checking…')
    setClassName('')
    setSlots([])
    try {
      const zip = bundleZipRef.current?.files?.[0]
      if (!zip) throw new Error('Select the downloaded bundle (.zip)')
      const result = await api<{ signers?: SlotLink[] }>('/verify-zip', {
        zipBase64: base64(new Uint8Array(await zip.arrayBuffer())),
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
        Use the original PDF, the request you saved before signing, and the downloaded
        signature bundle. Verification checks both signatures against the current on-chain
        keys.
      </p>
      <section className="panel">
        <div className="field">
          <label htmlFor="original">Original PDF</label>
          <input id="original" type="file" accept="application/pdf" ref={originalRef} />
        </div>
        <div className="field">
          <label htmlFor="expected">Previously saved request.json</label>
          <input id="expected" type="file" accept="application/json" ref={expectedRef} />
        </div>
        <div className="field">
          <label htmlFor="bundle">signatures.json</label>
          <input id="bundle" type="file" accept="application/json" ref={bundleRef} />
        </div>
        <button className="primary" onClick={verify}>
          Verify both signatures
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
        <p className="hint">
          Keep request.json from a trusted source. Inferring the expected request from an
          untrusted bundle cannot detect a substituted agreement. This check is not an
          archival timestamp or a legal certification.
        </p>
      </section>

      <section className="panel">
        <h2>Verify from the downloaded bundle</h2>
        <p className="hint">
          Upload the single <code>bundle.zip</code> you saved after both signatures were
          completed. It contains the document, request and signatures together.
        </p>
        <div className="field">
          <label htmlFor="bundleZip">Bundle (.zip)</label>
          <input id="bundleZip" type="file" accept="application/zip" ref={bundleZipRef} />
        </div>
        <button className="primary" onClick={verifyBundleZip}>
          Verify downloaded bundle
        </button>
      </section>
    </div>
  )
}