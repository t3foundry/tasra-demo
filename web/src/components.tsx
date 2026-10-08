import type { PublicRequest, SignerState } from '../../shared/model'

export const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
      c as '&' | '<' | '>' | '"' | "'"
    ],
  )

export const name = (p: string) => p[0]!.toUpperCase() + p.slice(1)

export const shortSlot = (slotId: string) =>
  slotId.slice(0, 10) + '…' + slotId.slice(-6)

export const signerLabel = (s: SignerState) =>
  s.name ? name(s.name) : shortSlot(s.slotId)

export function Badge({ status }: { status: PublicRequest['status'] }) {
  const closed = ['declined', 'cancelled'].includes(status)
  return (
    <span
      className={`badge ${status === 'completed' ? 'done' : closed ? 'closed' : ''}`}
    >
      {status === 'awaiting' ? 'Pending' : status.replaceAll('_', ' ')}
    </span>
  )
}

export function Recipients({ r }: { r: PublicRequest }) {
  return (
    <>
      {r.signers.map((s) => (
        <div className="person" key={s.slotId}>
          <div className="avatar">{signerLabel(s)[0]}</div>
          <div>
            <p>{signerLabel(s)}</p>
            <small>{s.phase.replaceAll('_', ' ')}</small>
          </div>
        </div>
      ))}
    </>
  )
}

export function Downloads({ r, notice }: { r: PublicRequest; notice?: (m: string) => void }) {
  return (
    <div className="actions">
      <a
        className="button small"
        href={`/api/requests/${r.manifest.requestId}/pdf`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open PDF
      </a>
      <a
        className="button small"
        href={`/api/requests/${r.manifest.requestId}/request`}
      >
        Save request
      </a>
      {r.status === 'completed' ? (
        <a
          className="button small"
          href={`/api/requests/${r.manifest.requestId}/bundle`}
        >
          Download signatures
        </a>
      ) : null}
      {r.status === 'completed' ? (
        <a
          className="button small"
          href={`/api/requests/${r.manifest.requestId}/bundle.zip`}
        >
          Download bundle (.zip)
        </a>
      ) : null}
      {notice ? null : null}
    </div>
  )
}

export function Timeline({ r }: { r: PublicRequest }) {
  return (
    <section className="panel">
      <h2>Activity</h2>
      <ol className="timeline">
        {r.history.map((h, i) => (
          <li key={i}>
            {h.person ? name(h.person) + ': ' : ''}
            {h.event}
            <time>{new Date(h.at).toLocaleString()}</time>
          </li>
        ))}
      </ol>
    </section>
  )
}