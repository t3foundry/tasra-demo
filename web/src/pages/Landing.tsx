import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'

type App = {
  eyebrow: string
  title: string
  description: string
  to: string
  cta: string
  points: string[]
  accent: string
}

const demoApps: App[] = [
  {
    eyebrow: 'Demo app · Signing',
    title: 'From draft to signed',
    description:
      'Upload a PDF, choose signers from the registry, and keep a verifiable record of their approval.',
    to: '/signing',
    cta: 'Open Signing',
    points: [
      'Threshold FROST signatures anchored to on-chain key slots',
      'Credential-gated approvals via OID4VP',
      'Offline verification of the saved bundle',
    ],
    accent: 'var(--lime)',
  },
  {
    eyebrow: 'Demo app · Encryption',
    title: 'Encrypt a document',
    description:
      'Create a BLS identity-encryption key on Tasra, then encrypt documents to a scoped identity.',
    to: '/encryption',
    cta: 'Open Encryption',
    points: [
      'Create and fund a BLS key slot on the Fuji testnet',
      'Identity-scoped encryption under the issuer',
      'Download the ciphertext bundle for later opening',
    ],
    accent: 'var(--gold)',
  },
]

type Eco = {
  title: string
  tagline: string
  description: string
  href: string
  accent: string
}

const ecosystem: Eco[] = [
  {
    title: 'Tasra Vault',
    tagline: 'Demo wallet',
    description:
      'Hold and present your verifiable credentials to authorize signatures and decryption.',
    href: 'https://vault.t3-foundry.fuji.tasra.network/wallet/#/',
    accent: 'var(--brand)',
  },
  {
    title: 'Tasra Explorer',
    tagline: 'Demo On-chain Data',
    description:
      'Inspect key slots, verifiers and the live state of the Fuji testnet.',
    href: 'https://explorer.t3-foundry.fuji.tasra.network/verifiers',
    accent: 'var(--success)',
  },
  {
    title: 'Tasra Docs',
    tagline: 'SDK documentation',
    description:
      'Guides, API reference and tutorials for building with the Tasra SDK.',
    href: 'https://docs.tasra.network',
    accent: 'var(--gold)',
  },
  {
    title: 'GitHub',
    tagline: 'Open source',
    description:
      'The t3foundry organisation — SDKs, tooling and example apps.',
    href: 'https://github.com/t3foundry',
    accent: 'var(--purple)',
  },
  {
    title: 'Telegram',
    tagline: 'Latest news',
    description:
      'Announcements, releases and updates from the Tasra team.',
    href: 'https://t.me/+eTA2Uz0TbSA2ZTI0',
    accent: '#2aabee',
  },
  {
    title: 'Key Registry contract',
    tagline: 'Testnet Smart Contract',
    description:
      'The Tasra key registry deployed on the Avalanche Fuji C-Chain testnet.',
    href: 'https://testnet.snowtrace.io/address/0x45F432aB5709e9920b5ec349D29663D7200A8C39/contract/43113/code?chainid=43113',
    accent: 'var(--warn)',
  },
]

function AppCard({ app }: { app: App }) {
  return (
    <section
      className="panel app-card"
      style={{ '--card-accent': app.accent } as CSSProperties}
    >
      <div className="eyebrow">{app.eyebrow}</div>
      <h2>{app.title}</h2>
      <p className="sub">{app.description}</p>
      <ul className="app-points">
        {app.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <Link className="button primary" to={app.to}>
        {app.cta}
      </Link>
    </section>
  )
}

function EcoCard({ item }: { item: Eco }) {
  return (
    <a
      className="eco-card"
      href={item.href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ '--card-accent': item.accent } as CSSProperties}
    >
      <div className="eco-card-top">
        <span className="eco-tagline">{item.tagline}</span>
        <span className="eco-arrow" aria-hidden="true">
          ↗
        </span>
      </div>
      <h3>{item.title}</h3>
      <p>{item.description}</p>
    </a>
  )
}

export function Landing() {
  return (
    <>
      <section className="landing-hero">
        <div className="landing-hero-grid" aria-hidden="true" />
        <div className="eyebrow landing-hero-eyebrow">
          Fuji testnet · now live
        </div>
        <h1 className="landing-hero-title">The Tasra testnet hub</h1>
        <p className="landing-hero-sub">
          Sign and encrypt documents, hold credentials in your demo wallet, browse
          on-chain state and dig into the SDK — everything you need in one place.
        </p>
      </section>

      <div className="landing-section">
        <div className="landing-section-head">
          <h2>Demo apps</h2>
          <span className="landing-section-note">
            Run locally · Fuji C-Chain
          </span>
        </div>
        <div className="app-grid">
          {demoApps.map((app) => (
            <AppCard key={app.to} app={app} />
          ))}
        </div>
      </div>

      <div className="landing-section">
        <div className="landing-section-head">
          <h2>Ecosystem</h2>
          <span className="landing-section-note">
            Wallet · Explorer · Docs · Community
          </span>
        </div>
        <div className="eco-grid">
          {ecosystem.map((item) => (
            <EcoCard key={item.title} item={item} />
          ))}
        </div>
      </div>
    </>
  )
}