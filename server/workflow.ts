import { randomUUID } from 'node:crypto'
import type { OpenedVerifierAgentSession } from 'tasra-sdk/oid4vp'
import type { Hex } from '../shared/model'
import { Store } from './store'
import {
  digest,
  statement,
  people,
  type Person,
  type Manifest,
  type Proof,
  type PublicRequest,
} from '../shared/model'

export type SessionRecord = {
  sessionId: string
  pollSecret: string
  requestUri: string
  qrPayload: string
  requestHash: Hex
  operation: OpenedVerifierAgentSession['operation']
}
export type RequestRecord = PublicRequest & {
  pdfBase64: string
  sessions: Partial<Record<Person, SessionRecord>>
}
export interface SigningBackend {
  open(manifest: Manifest, person: Person): Promise<SessionRecord>
  sign(
    manifest: Manifest,
    person: Person,
    session: SessionRecord,
    beforeSubmit: () => void,
  ): Promise<Proof>
  verify(manifest: Manifest, proof: Proof): Promise<void>
}
export class Conflict extends Error {}
export function publicView(record: RequestRecord): PublicRequest {
  const { manifest, status, signers, history } = record
  return structuredClone({ manifest, status, signers, history })
}
export class Workflow {
  constructor(
    readonly store: Store<RequestRecord>,
    readonly backend: SigningBackend,
    readonly network: {
      chainId: number
      keyRegistry: Hex
      slots: Record<Person, Hex>
    },
  ) {}
  private event(r: RequestRecord, event: string, person?: Person) {
    r.history.push({
      at: new Date().toISOString(),
      event,
      ...(person ? { person } : {}),
    })
  }
  private active(r: RequestRecord) {
    if (['cancelled', 'declined'].includes(r.status))
      throw new Conflict('This request is closed')
  }
  async create(input: { id: string; title: string; version: number; pdf: Uint8Array }) {
    if (
      !input.title.trim() ||
      input.title.length > 120 ||
      input.pdf.length > 8 * 1024 * 1024 ||
      new TextDecoder().decode(input.pdf.slice(0, 5)) !== '%PDF-' ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1
    )
      throw new Error('Provide a PDF up to 8 MB, a title and a positive version')
    const manifest: Manifest = {
      schema: 'tasra-sign/v1',
      requestId: input.id,
      version: input.version,
      title: input.title.trim(),
      documentSha256: await digest(input.pdf),
      chainId: this.network.chainId,
      keyRegistry: this.network.keyRegistry,
      signers: people.map((name) => ({ name, slotId: this.network.slots[name] })),
    }
    return this.store.exclusive(input.id, () => {
      if (this.store.has(input.id)) {
        const existing = this.store.get(input.id)
        if (
          Buffer.compare(
            Buffer.from(statement(existing.manifest)),
            Buffer.from(statement(manifest)),
          )
        )
          throw new Conflict('Request ID already belongs to different content')
        return publicView(existing)
      }
      const record: RequestRecord = {
        manifest,
        status: 'awaiting_alice',
        signers: { alice: { phase: 'pending' }, bob: { phase: 'pending' } },
        history: [],
        pdfBase64: Buffer.from(input.pdf).toString('base64'),
        sessions: {},
      }
      this.event(record, 'Request created')
      this.store.save(record)
      return publicView(record)
    })
  }
  async prepare(id: string, person: Person, documentSha256: string) {
    return this.store.exclusive(id, async () => {
      const r = this.store.get(id)
      this.active(r)
      if (documentSha256 !== r.manifest.documentSha256)
        throw new Conflict('Reviewed document differs')
      const signer = r.signers[person]
      if (signer.phase === 'signed') return publicView(r)
      if (signer.phase === 'awaiting_wallet') return publicView(r)
      if (signer.phase !== 'pending' && signer.phase !== 'refused')
        throw new Conflict('Operation requires reconciliation; do not submit another signature')
      // Persist before opening. A crash with no returned session is explicitly uncertain.
      signer.phase = 'opening'
      signer.attemptId = randomUUID()
      delete signer.error
      this.store.save(r)
      try {
        r.sessions[person] = await this.backend.open(r.manifest, person)
        signer.phase = 'awaiting_wallet'
        this.event(r, 'Wallet request opened', person)
        this.store.save(r)
        return publicView(r)
      } catch {
        signer.phase = 'uncertain'
        signer.error = 'Session opening outcome unknown'
        this.store.save(r)
        throw new Conflict(signer.error)
      }
    })
  }
  async complete(id: string, person: Person, attemptId: string) {
    return this.store.exclusive(id, async () => {
      const r = this.store.get(id)
      this.active(r)
      const signer = r.signers[person]
      if (attemptId !== signer.attemptId)
        throw new Conflict('Completion belongs to another attempt')
      if (signer.phase === 'signed') return publicView(r) // duplicate completion returns the saved proof
      if (signer.phase !== 'awaiting_wallet' || !r.sessions[person])
        throw new Conflict('Request is not awaiting this wallet')
      try {
        const proof = await this.backend.sign(
          r.manifest,
          person,
          r.sessions[person]!,
          () => {
            signer.phase = 'signing'
            this.store.save(r) // flush before keeper submission
          },
        )
        await this.backend.verify(r.manifest, proof)
        signer.signature = proof
        signer.phase = 'signed'
        delete signer.error
        delete r.sessions[person]
        r.status = people.every((p) => r.signers[p].phase === 'signed')
          ? 'completed'
          : r.signers.alice.phase === 'signed'
            ? 'awaiting_bob'
            : 'awaiting_alice'
        this.event(r, 'Signature verified', person)
        this.store.save(r)
        return publicView(r)
      } catch (e) {
        // A verifier refusal precedes signing and is safe to correct with a new presentation.
        // A transport/verification failure after submission may hide a completed signature.
        if (
          signer.phase === 'awaiting_wallet' &&
          e instanceof Error &&
          e.name === 'AuthorizationRefused'
        ) {
          signer.phase = 'refused'
          signer.error = 'The verifier refused this credential'
          delete r.sessions[person]
          this.event(r, 'Credential refused', person)
        } else if ((signer.phase as string) === 'signing') {
          signer.phase = 'uncertain'
          signer.error = 'Signing outcome unknown; preserve this request'
          this.event(r, 'Reconciliation required', person)
        }
        this.store.save(r)
        throw e
      }
    })
  }
  async close(id: string, status: 'cancelled' | 'declined', person?: Person) {
    return this.store.exclusive(id, () => {
      const r = this.store.get(id)
      this.active(r)
      if (
        (person && r.signers[person].phase === 'signed') ||
        r.status === 'completed' ||
        people.some((p) => ['opening', 'signing', 'uncertain'].includes(r.signers[p].phase))
      )
        throw new Conflict('Cannot close completed or uncertain work')
      r.status = status
      this.event(
        r,
        status === 'cancelled' ? 'Sender cancelled' : 'Signer declined',
        person,
      )
      r.sessions = {}
      this.store.save(r)
      return publicView(r)
    })
  }
  recover() {
    for (const r of this.store.list()) {
      let changed = false
      for (const p of people)
        if (['opening', 'signing'].includes(r.signers[p].phase)) {
          r.signers[p].phase = 'uncertain'
          r.signers[p].error = 'Interrupted operation; reconciliation required'
          changed = true
        }
      if (changed) {
        this.event(r, 'Interrupted operation preserved')
        this.store.save(r)
      }
    }
  }
}