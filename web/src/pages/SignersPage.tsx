import { useCallback, useEffect, useState } from 'react'
import { ed25519DidKey } from 'tasra-sdk/oid4vp'
import { ed25519 } from '@noble/curves/ed25519'
import { api } from '../api'
import { name, shortSlot } from '../components'
import { DemoWalletLink } from '../DemoWalletLink'
import { useNotice } from '../notice'
import { toHex } from '../../../shared/model'
import {
  listLocalSigners,
  listPendingSigners,
  promotePendingSigner,
  pendingKey,
  type LocalSigner,
} from '../localSigners'

type SignerJob = {
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: string[]
  result?: { name: string; slotId: string; credential: string }
  error?: string
}

type IssueVcResult = { offerUri: string; qrDataUrl: string }

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

const walletSchema = 'tasra-demo-wallet/v1'

export function SignersPage() {
  const notice = useNotice()
  const [signers, setSigners] = useState<LocalSigner[]>([])
  const [pending, setPending] = useState<LocalSigner[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState<{
    name: string
    progress: string[]
    done?: boolean
  } | null>(null)
  const [vcOffer, setVcOffer] = useState<{ name: string; offer: IssueVcResult } | null>(null)
  const [issuingVc, setIssuingVc] = useState<string | null>(null)
  const [copiedVc, setCopiedVc] = useState(false)

  const load = useCallback(() => {
    setSigners(listLocalSigners())
    setPending(listPendingSigners())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function startCreation(raw: string) {
    const name = raw.trim().toLowerCase()
    if (!name) {
      notice('Enter a signer name', 'error')
      return
    }
    const push = (message: string) =>
      setCreating((c) => (c ? { ...c, progress: [...c.progress, message] } : c))
    setCreating({ name, progress: ['Generating a W3C DID key in this browser…'] })
    try {
      const seed = ed25519.utils.randomSecretKey()
      const holderDid = ed25519DidKey(ed25519.getPublicKey(seed))
      push('Requesting credential issuance to the W3C DID wallet…')
      const { jobId } = await api<{ jobId: string }>(
        '/signers/remote',
        { name, holderDid },
      )
      for (let i = 0; i < 1200; i++) {
        const job = await api<SignerJob>('/signers/remote-jobs/' + jobId)
        if (job.status === 'completed') {
          const wallet = {
            schema: walletSchema,
            name,
            seed: toHex(seed),
            credential: job.result!.credential,
            slotId: job.result!.slotId,
          }
          localStorage.setItem(pendingKey(name), JSON.stringify(wallet))
          setCreating((c) => (c ? { ...c, progress: job.progress, done: true } : c))
          setNewName('')
          notice(`Signer ${name} created. Now issue its credential from step 3.`, 'success')
          load()
          return
        }
        if (job.status === 'failed')
          throw new Error(job.error ?? 'Signer creation failed')
        setCreating((c) => (c ? { ...c, progress: job.progress } : c))
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw new Error('Signer creation timed out')
    } catch (e) {
      setCreating(null)
      notice((e as Error).message, 'error')
    }
  }

  async function issueVc(name: string) {
    setIssuingVc(name)
    promotePendingSigner(name)
    setPending(listPendingSigners())
    setSigners(listLocalSigners())
    try {
      const offer = await api<IssueVcResult>(`/signers/${name}/issue-vc`, {})
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
      <div className="eyebrow">Signing keys</div>
      <h1>Add a signer.</h1>
      <p className="sub">
        Every signer has a secure, reserved key that requires a specific digital
        credential to authorize their signature.
      </p>

      <section className="panel create-signer">
        <h2>Create a signer</h2>

        <div className="send-step">
          <div className="send-step-head">
            <span className="send-step-num" aria-hidden="true">
              1
            </span>
            <div>
              <h3 className="send-step-title">Create the signer</h3>
              <p className="send-step-sub">
                Name your signer and generate its on-chain key slot.
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
                id="new-signer-name"
                type="text"
                value={newName}
                maxLength={32}
                placeholder="e.g. carol"
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
                Issue the credential, then scan the QR with your mobile wallet.
              </p>
            </div>
          </div>
          {pending.length ? (
            pending.map((p) => (
              <div className="issue-box" key={p.name}>
                <div className="person">
                  <div className="avatar">{name(p.name)[0]}</div>
                  <div>
                    <p>{name(p.name)}</p>
                    <a href={explorer(p.slotId)} target="_blank" rel="noopener noreferrer">
                      {shortSlot(p.slotId)}
                    </a>
                  </div>
                </div>
                <button
                  className="small"
                  disabled={issuingVc === p.name}
                  onClick={() => void issueVc(p.name)}
                >
                  {issuingVc === p.name
                    ? 'Creating QR…'
                    : vcOffer?.name === p.name
                      ? 'Regenerate QR'
                      : 'Issue VC'}
                </button>
                {vcOffer?.name === p.name ? (
                  <div className="vc-offer">
                    <img
                      src={vcOffer.offer.qrDataUrl}
                      alt="Credential offer QR code"
                      width={200}
                      height={200}
                    />
                    <p className="hint">
                      Scan with a remote wallet to receive this signer’s
                      DocumentSigner credential. Offer expires in 15 minutes.
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
            <p className="hint">Create a signer in step 1 to issue its credential.</p>
          )}
        </div>
      </section>

      {signers.length ? (
        <>
          <h2>Your signers</h2>
          {signers.map((s) => (
            <section className="panel" key={s.name}>
              <div className="person">
                <div className="avatar">{name(s.name)[0]}</div>
                <div>
                  <p>{name(s.name)}</p>
                  <small>DocumentSigner · did:demo:{s.name}</small>
                </div>
              </div>
              <h3>Key slot</h3>
              <div className="linkbox">
                <a href={explorer(s.slotId)} target="_blank" rel="noopener noreferrer">
                  {s.slotId}
                </a>
              </div>
              <button
                className="small"
                disabled={issuingVc === s.name}
                onClick={() => void issueVc(s.name)}
              >
                {issuingVc === s.name
                  ? 'Creating QR…'
                  : vcOffer?.name === s.name
                    ? 'Regenerate QR'
                    : 'Issue VC'}
              </button>
              {vcOffer?.name === s.name ? (
                <div className="vc-offer">
                  <img
                    src={vcOffer.offer.qrDataUrl}
                    alt="Credential offer QR code"
                    width={200}
                    height={200}
                  />
                  <p className="hint">
                    Scan with a remote wallet to receive this signer’s DocumentSigner
                    credential. Offer expires in 15 minutes.
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
        <p className="empty">No signers yet. Create one above.</p>
      )}

      {creating ? (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Creating signer {name(creating.name)}</h2>
            <ol className="progress">
              {creating.progress.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
            <p className="hint">This can take a minute or two. Do not close this page.</p>
            {creating.done ? (
              <button className="primary" type="button" onClick={() => setCreating(null)}>
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}