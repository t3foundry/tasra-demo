import { Link } from 'react-router-dom'

function Section({
  eyebrow,
  title,
  description,
  to,
  cta,
  points,
}: {
  eyebrow: string
  title: string
  description: string
  to: string
  cta: string
  points: string[]
}) {
  return (
    <section className="panel landing-card">
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p className="sub">{description}</p>
      <ul className="landing-points">
        {points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <Link className="button primary" to={to}>
        {cta}
      </Link>
    </section>
  )
}

export function Landing() {
  return (
    <>
      <div className="landing-grid">
        <Section
          eyebrow="Signing"
          title="From draft to signed."
          description="Upload a PDF, choose signers from the registry, and keep a verifiable record of their approval."
          to="/signing"
          cta="Open Signing"
          points={[
            'Threshold FROST signatures anchored to on-chain key slots',
            'Credential-gated approvals via OID4VP',
            'Offline verification of the saved bundle',
          ]}
        />
        <Section
          eyebrow="Encryption"
          title="Encrypt a document."
          description="Create a BLS identity-encryption key on Tasra, then encrypt documents to a scoped identity."
          to="/encryption"
          cta="Open Encryption"
          points={[
            'Create and fund a BLS key slot on the Fuji testnet',
            'Identity-scoped encryption under the issuer',
            'Download the ciphertext bundle for later opening',
          ]}
        />
      </div>
    </>
  )
}