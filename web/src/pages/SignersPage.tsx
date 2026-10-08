import { useCallback, useEffect, useState } from 'react'
import { createIdentity, verifyCredential } from 'tasra-sdk/app'
import { ed25519DidKey } from 'tasra-sdk/oid4vp'
import { ed25519 } from '@noble/curves/ed25519'
import { api } from '../api'
import { name } from '../components'
import { DemoWalletLink } from '../DemoWalletLink'
import { useNotice } from '../notice'
import { toHex } from '../../../shared/model'
import { importWallet } from '../../../shared/wallet'

type DcqlClaim = { path: string[]; values?: unknown[] }
type DcqlQuery = {
  id: string
  format: string
  meta: Record<string, unknown>
  claims: DcqlClaim[]
}
type SignerInfo = {
  name: string
  slotId: string
  dcql?: { credentials: DcqlQuery[] }
}

type IssueVcResult = { offerUri: string; qrDataUrl: string }

type SignerJob = {
  name: string
  status: 'running' | 'completed' | 'failed'
  progress: string[]
  result?: { name: string; slotId: string; credential: string }
  error?: string
}

const explorer = (slotId: string) =>
  `https://explorer.t3-foundry.fuji.tasra.network/slots/${slotId}`

const walletKey = (person: string) => `tasra-wallet:${person}`
const walletSchema = 'tasra-demo-wallet/v1'



type WalletInfo = {
  did: string
  credential: string
  claims: Record<string, unknown>
}

function describeWallet(text: string): WalletInfo {
  const wallet = importWallet(text)
  try {
    return {
      did: wallet.identity.toJSON().did,
      credential: wallet.credential,
      claims: verifyCredential(wallet.credential, {
        holder: wallet.identity,
        type: 'DocumentSigner',
        subject: 'did:demo:' + wallet.name,
      }),
    }
  } finally {
    wallet.identity.destroy()
  }
}

function WalletUpload({ person }: { person: string }) {
  const [info, setInfo] = useState<WalletInfo | null>(null)

  useEffect(() => {
    const text = localStorage.getItem(walletKey(person))
    try {
      setInfo(text ? describeWallet(text) : null)
    } catch {
      setInfo(null)
    }
  }, [person])

  return (
    <details className="dcql">
      <summary>
        Demo wallet
        <span className={info ? 'tag stored' : 'tag'}>
          {info ? 'stored' : 'not stored'}
        </span>
      </summary>
      <div className="wallet">
        <p>
          {info
            ? 'A wallet is stored for this key-slot.'
            : 'No wallet stored for this signer.'}
        </p>
        {info ? (
          <div className="wallet-info">
            <p className="hint">DID</p>
            <pre className="code">{info.did}</pre>
            <p className="hint">Verifiable credential</p>
            <pre className="code">{JSON.stringify(info.claims, null, 2)}</pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}

export function SignersPage() {
  const notice = useNotice()
  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [showCreate, setShowCreate] = useState<'none' | 'local' | 'remote'>('none')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState<{
    name: string
    progress: string[]
  } | null>(null)
  const [vcOffer, setVcOffer] = useState<{ name: string; offer: IssueVcResult } | null>(null)
  const [issuingVc, setIssuingVc] = useState<string | null>(null)

  const load = useCallback(() => {
    void api<SignerInfo[]>('/signers')
      .then(setSigners)
      .catch((e) => notice((e as Error).message))
  }, [notice])

  useEffect(() => {
    load()
  }, [load])

  async function startCreation(raw: string) {
    const name = raw.trim().toLowerCase()
    if (!name) {
      notice('Enter a signer name')
      return
    }
    setShowCreate('none')
    const push = (message: string) =>
      setCreating((c) => (c ? { ...c, progress: [...c.progress, message] } : c))
    setCreating({ name, progress: ['Generating a key pair in this browser…'] })
    try {
      const identity = createIdentity()
      let seed = ''
      let holderDid = ''
      try {
        seed = toHex(identity.exportPrivateKey())
        holderDid = identity.toJSON().did
      } finally {
        identity.destroy()
      }
      push('Requesting credential issuance…')
      const { jobId } = await api<{ jobId: string }>(
        '/signers',
        { name, holderDid },
      )
      for (let i = 0; i < 1200; i++) {
        const job = await api<SignerJob>('/signers/jobs/' + jobId)
        if (job.status === 'completed') {
          const wallet = {
            schema: walletSchema,
            name,
            seed,
            credential: job.result!.credential,
          }
          localStorage.setItem(walletKey(name), JSON.stringify(wallet))
          setCreating(null)
          notice(`Signer ${name} created. Wallet stored in this browser.`)
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
      notice((e as Error).message)
    }
  }

  async function startRemoteCreation(raw: string) {
    const name = raw.trim().toLowerCase()
    if (!name) {
      notice('Enter a signer name')
      return
    }
    setShowCreate('none')
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
          }
          localStorage.setItem(walletKey(name), JSON.stringify(wallet))
          setCreating(null)
          notice(`Signer ${name} created with a remote W3C DID wallet.`)
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
      notice((e as Error).message)
    }
  }

  async function issueVc(name: string) {
    setIssuingVc(name)
    try {
      const offer = await api<IssueVcResult>(`/signers/${name}/issue-vc`, {})
      setVcOffer({ name, offer })
    } catch (e) {
      notice((e as Error).message)
    } finally {
      setIssuingVc(null)
    }
  }

  return (
    <div className="signers">
      <div className="eyebrow">Signers</div>
      <h1>Known signers.</h1>
      <p className="sub">
        Each signer holds a dedicated on-chain key slot gated by a credential rule
        (DCQL). Only the matching demo credential can authorize a signature.
      </p>

      <section className="panel create-signer">
        {showCreate === 'none' ? (
          <div className="actions">
            <button className="primary" onClick={() => setShowCreate('local')}>
              Create signer
            </button>
            <button onClick={() => setShowCreate('remote')}>
              Create remote signer
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void (showCreate === 'local'
                ? startCreation(newName)
                : startRemoteCreation(newName))
            }}
          >
            <label htmlFor="new-signer-name">
              {showCreate === 'local' ? 'New signer name' : 'Remote signer name'}
            </label>
            <div className="row">
              <input
                id="new-signer-name"
                type="text"
                value={newName}
                maxLength={32}
                autoFocus
                placeholder="e.g. carol"
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className="primary"
                type="submit"
                disabled={!newName.trim()}
              >
                Create
              </button>
            </div>
            {showCreate === 'remote' ? (
              <div className="wallet-callout">
                <p className="hint">
                  A remote signer keeps its DocumentSigner credential in an external
                  wallet. Open the demo wallet first, then name and create the signer
                  below.
                </p>
                <DemoWalletLink className="button">
                  Open the demo wallet ↗
                </DemoWalletLink>
              </div>
            ) : null}
            <div className="form-cancel">
              <button
                className="small"
                type="button"
                onClick={() => setShowCreate('none')}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {signers.map((s) => (
        <section className="panel" key={s.name}>
          <div className="person">
            <div className="avatar">{name(s.name)[0]}</div>
            <div>
              <p>{name(s.name)}</p>
              <small>
                DocumentSigner · did:demo:{s.name}
              </small>
            </div>
          </div>
          <WalletUpload person={s.name} />
          <h3>Key slot</h3>
          <div className="linkbox">
            <a href={explorer(s.slotId)} target="_blank" rel="noopener noreferrer">
              {s.slotId}
            </a>
          </div>
          <h3>Issue VC</h3>
          <button
            className="small"
            disabled={issuingVc === s.name}
            onClick={() => void issueVc(s.name)}
          >
            {issuingVc === s.name ? 'Creating QR…' : 'Issue VC'}
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
            </div>
          ) : null}
          {s.dcql ? (
            <details className="dcql">
              <summary>Configured DCQL</summary>
              <pre className="code">{JSON.stringify(s.dcql, null, 2)}</pre>
            </details>
          ) : (
            <>
              <h3>Configured DCQL</h3>
              <p className="hint">DCQL is unavailable for this deployment.</p>
            </>
          )}
        </section>
      ))}

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
          </div>
        </div>
      ) : null}
    </div>
  )
}