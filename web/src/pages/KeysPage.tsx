import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { shortSlot } from '../components'
import { DemoWalletLink } from '../DemoWalletLink'
import { useNotice } from '../notice'
import {
  listLocalEncryptionKeys,
  listPendingLocalEncryptionKeys,
  promotePendingEncryptionKey,
  savePendingLocalEncryptionKey,
  type LocalEncryptionKey,
} from '../localEncryptionKeys'

type EncryptionKeyJob = {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: string[]
  result?: { name: string; slotId: string }
  error?: string
}

type IssueVcResult = { offerUri: string; qrDataUrl: string }

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

export function KeysPage() {
  const notice = useNotice()
  const [keys, setKeys] = useState<LocalEncryptionKey[]>([])
  const [pending, setPending] = useState<LocalEncryptionKey[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState<{
    name: string
    progress: string[]
  } | null>(null)
  const [vcOffer, setVcOffer] = useState<{ name: string; offer: IssueVcResult } | null>(null)
  const [issuingVc, setIssuingVc] = useState<string | null>(null)
  const [copiedVc, setCopiedVc] = useState(false)

  const load = useCallback(() => {
    setKeys(listLocalEncryptionKeys())
    setPending(listPendingLocalEncryptionKeys())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function startCreation(raw: string) {
    const name = raw.trim().toLowerCase()
    if (!name) {
      notice('Enter a key name', 'error')
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
          savePendingLocalEncryptionKey({
            name: job.result!.name,
            slotId: job.result!.slotId,
          })
          setCreating(null)
          notice(`Key ${name} created. Now issue its credential from step 3.`, 'success')
          load()
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
      notice((e as Error).message, 'error')
    }
  }

  async function issueVc(name: string) {
    setIssuingVc(name)
    promotePendingEncryptionKey(name)
    setPending(listPendingLocalEncryptionKeys())
    setKeys(listLocalEncryptionKeys())
    try {
      const offer = await api<IssueVcResult>(
        `/encryption/keys/${encodeURIComponent(name)}/issue-vc`,
        {},
      )
      setVcOffer({ name, offer })
    } catch (e) {
      notice((e as Error).message, 'error')
    } finally {
      setIssuingVc(null)
    }
  }

  async function copyVc() {
    if (!vcOffer) return
    try {
      await navigator.clipboard.writeText(vcOffer.offer.offerUri)
      setCopiedVc(true)
      setTimeout(() => setCopiedVc(false), 1500)
    } catch (e) {
      notice((e as Error).message, 'error')
    }
  }

  return (
    <div className="signers">
      <div className="eyebrow">Encryption keys</div>
      <h1>Add a key.</h1>
      <p className="sub">
        Each key is a 2-of-3 BLS slot gated by a DocumentReader credential scope.
        Creating a key funds it with TSRA from the creator wallet. A credential is
        required to unlock documents encrypted to that key.
      </p>

      <section className="panel create-signer">
        <h2>Create a key</h2>

        <div className="send-step">
          <div className="send-step-head">
            <span className="send-step-num" aria-hidden="true">
              1
            </span>
            <div>
              <h3 className="send-step-title">Create the encryption key</h3>
              <p className="send-step-sub">
                Name your key and generate its on-chain BLS key slot.
              </p>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void startCreation(newName)
            }}
          >
            <div className="row">
              <input
                id="new-key-name"
                type="text"
                value={newName}
                maxLength={32}
                placeholder="e.g. notes"
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className="primary"
                type="submit"
                disabled={!newName.trim() || !!creating}
              >
                Create
              </button>
            </div>
          </form>
        </div>

        <div className="send-step">
          <div className="send-step-head">
            <span className="send-step-num" aria-hidden="true">
              2
            </span>
            <div>
              <h3 className="send-step-title">Access the demo wallet</h3>
              <p className="send-step-sub">
                Open the demo wallet on your mobile device and create an identity if
                you haven’t already.
              </p>
            </div>
          </div>
          <DemoWalletLink className="button">
            Open the demo wallet on mobile ↗
          </DemoWalletLink>
        </div>

        <div className="send-step">
          <div className="send-step-head">
            <span className="send-step-num" aria-hidden="true">
              3
            </span>
            <div>
              <h3 className="send-step-title">Issue the VC & scan it</h3>
              <p className="send-step-sub">
                Issue the DocumentReader credential, then scan the QR with your mobile
                wallet. The key becomes usable once issued.
              </p>
            </div>
          </div>
          {pending.length ? (
            pending.map((k) => (
              <div className="issue-box" key={k.name}>
                <div className="person">
                  <div className="avatar">{k.name[0]}</div>
                  <div>
                    <p>{k.name}</p>
                    <small>{shortSlot(k.slotId)}</small>
                  </div>
                </div>
                <button
                  className="small"
                  disabled={issuingVc === k.name}
                  onClick={() => void issueVc(k.name)}
                >
                  {issuingVc === k.name
                    ? 'Creating QR…'
                    : vcOffer?.name === k.name
                      ? 'Regenerate QR'
                      : 'Issue VC'}
                </button>
                {vcOffer?.name === k.name ? (
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
                    <button className="small" type="button" onClick={() => void copyVc()}>
                      {copiedVc ? 'Copied' : 'Copy URL'}
                    </button>
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <p className="hint">Create a key in step 1 to issue its credential.</p>
          )}
        </div>
      </section>

      {keys.length ? (
        <>
          <h2>Your keys</h2>
          {keys.map((k) => (
            <section className="panel" key={k.name}>
              <div className="person">
                <div className="avatar">{k.name[0]}</div>
                <div>
                  <p>{k.name}</p>
                  <small>DocumentReader · BLS identity-encryption key</small>
                </div>
              </div>
              <h3>Key slot</h3>
              <div className="linkbox">
                <a href={explorer(k.slotId)} target="_blank" rel="noopener noreferrer">
                  {k.slotId}
                </a>
              </div>
              <button
                className="small"
                disabled={issuingVc === k.name}
                onClick={() => void issueVc(k.name)}
              >
                {issuingVc === k.name
                  ? 'Creating QR…'
                  : vcOffer?.name === k.name
                    ? 'Regenerate QR'
                    : 'Issue VC'}
              </button>
              {vcOffer?.name === k.name ? (
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
                  <button className="small" type="button" onClick={() => void copyVc()}>
                    {copiedVc ? 'Copied' : 'Copy URL'}
                  </button>
                </div>
              ) : null}
            </section>
          ))}
        </>
      ) : (
        <p className="empty">No keys yet. Create one above.</p>
      )}

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
    </div>
  )
}