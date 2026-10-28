import { randomUUID } from 'node:crypto'
import type { OpenedVerifierAgentSession } from '@t3foundry/tasra-sdk/oid4vp'
import type { Hex, SignerRef, SignerState, Proof } from '../shared/model'
import {
  digest,
  statement,
  type Manifest,
  type PublicRequest,
} from '../shared/model'
import { Store } from './store'

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
  sessions: Record<string, SessionRecord | undefined>
}
export interface SigningBackend {
  open(manifest: Manifest, slotId: Hex): Promise<SessionRecord>
  sign(
    manifest: Manifest,
    slotId: Hex,
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

/** Normalize records saved by the earlier fixed alice/bob layout. */
export function migrateRecords(store: Store<RequestRecord>) {
  for (const raw of store.list()) {
    let changed = false
    if (!Array.isArray(raw.signers)) {
      const legacy = raw.signers as unknown as Record<
        string,
        Partial<SignerState> | undefined
      >
      raw.signers = raw.manifest.signers.map((s) => {
        const old = legacy[s.name ?? ''] ?? {}
        return {
          slotId: s.slotId,
          ...(s.name ? { name: s.name } : {}),
          phase: (old.phase ?? 'pending') as SignerState['phase'],
          ...(old.attemptId ? { attemptId: old.attemptId } : {}),
          ...(old.signature ? { signature: old.signature } : {}),
          ...(old.error ? { error: old.error } : {}),
        }
      })
      const sessions = raw.sessions as unknown as Record<
        string,
        SessionRecord | undefined
      >
      const nextSessions: Record<string, SessionRecord | undefined> = {}
      for (const [name, sess] of Object.entries(sessions)) {
        const match = raw.manifest.signers.find((s) => s.name === name)
        if (match && sess) nextSessions[match.slotId.toLowerCase()] = sess
      }
      raw.sessions = nextSessions
      changed = true
    }
    const status = raw.status as string
    if (status === 'awaiting_alice' || status === 'awaiting_bob') {
      raw.status = 'awaiting'
      changed = true
    }
    if (changed) store.save(raw)
  }
}

const key = (slotId: Hex) => slotId.toLowerCase()
const slotRe = /^0x[0-9a-f]{64}$/i

export class Workflow {
  constructor(
    readonly store: Store<RequestRecord>,
    readonly backend: SigningBackend,
    readonly network: { chainId: number; keyRegistry: Hex },
  ) {}
  private signer(r: RequestRecord, slotId: Hex): SignerState | undefined {
    return r.signers.find(
      (s) => s.slotId.toLowerCase() === slotId.toLowerCase(),
    )
  }
  private event(r: RequestRecord, event: string, person?: string) {
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
  async create(input: {
    id: string
    title: string
    version: number
    pdf: Uint8Array
    signers: SignerRef[]
  }) {
    if (
      !input.title.trim() ||
      input.title.length > 120 ||
      input.pdf.length > 8 * 1024 * 1024 ||
      new TextDecoder().decode(input.pdf.slice(0, 5)) !== '%PDF-' ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1 ||
      !Array.isArray(input.signers) ||
      input.signers.length < 1 ||
      new Set(input.signers.map((s) => s.slotId.toLowerCase())).size !==
        input.signers.length ||
      input.signers.some(
        (s) =>
          !slotRe.test(s.slotId) ||
          (s.name !== undefined && !s.name.trim()),
      )
    )
      throw new Error(
        'Provide a PDF up to 8 MB, a title, a positive version and at least one signer',
      )
    const manifest: Manifest = {
      schema: 'tasra-sign/v1',
      requestId: input.id,
      version: input.version,
      title: input.title.trim(),
      documentSha256: await digest(input.pdf),
      chainId: this.network.chainId,
      keyRegistry: this.network.keyRegistry,
      signers: input.signers.map((s) => ({
        slotId: s.slotId,
        ...(s.name ? { name: s.name } : {}),
      })),
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
        status: 'awaiting',
        signers: manifest.signers.map((s) => ({
          slotId: s.slotId,
          name: s.name,
          phase: 'pending',
        })),
        history: [],
        pdfBase64: Buffer.from(input.pdf).toString('base64'),
        sessions: {},
      }
      this.event(record, 'Request created')
      this.store.save(record)
      return publicView(record)
    })
  }
  async prepare(id: string, slotId: Hex, documentSha256: string) {
    return this.store.exclusive(id, async () => {
      const r = this.store.get(id)
      this.active(r)
      if (documentSha256 !== r.manifest.documentSha256)
        throw new Conflict('Reviewed document differs')
      const signer = this.signer(r, slotId)
      if (!signer) throw new Conflict('Unknown signer')
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
        r.sessions[key(signer.slotId)] = await this.backend.open(r.manifest, signer.slotId)
        signer.phase = 'awaiting_wallet'
        this.event(r, 'Wallet request opened', signer.name)
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
  async complete(id: string, slotId: Hex, attemptId: string) {
    return this.store.exclusive(id, async () => {
      const r = this.store.get(id)
      this.active(r)
      const signer = this.signer(r, slotId)
      if (!signer) throw new Conflict('Unknown signer')
      if (attemptId !== signer.attemptId)
        throw new Conflict('Completion belongs to another attempt')
      if (signer.phase === 'signed') return publicView(r) // duplicate completion returns the saved proof
      if (signer.phase !== 'awaiting_wallet' || !r.sessions[key(signer.slotId)])
        throw new Conflict('Request is not awaiting this wallet')
      try {
        const proof = await this.backend.sign(
          r.manifest,
          signer.slotId,
          r.sessions[key(signer.slotId)]!,
          () => {
            signer.phase = 'signing'
            this.store.save(r) // flush before keeper submission
          },
        )
        await this.backend.verify(r.manifest, proof)
        signer.signature = proof
        signer.phase = 'signed'
        delete signer.error
        delete r.sessions[key(signer.slotId)]
        r.status = r.signers.every((s) => s.phase === 'signed')
          ? 'completed'
          : 'awaiting'
        this.event(r, 'Signature verified', signer.name ?? signer.slotId)
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
          delete r.sessions[key(signer.slotId)]
          this.event(r, 'Credential refused', signer.name)
        } else if ((signer.phase as string) === 'signing') {
          signer.phase = 'uncertain'
          signer.error = 'Signing outcome unknown; preserve this request'
          this.event(r, 'Reconciliation required', signer.name ?? signer.slotId)
        }
        this.store.save(r)
        throw e
      }
    })
  }
  /** Clear an abandoned wallet session so a later attempt can open a fresh one.
   *  Safe only before any keeper submission has started. */
  async reset(id: string, slotId: Hex) {
    return this.store.exclusive(id, () => {
      const r = this.store.get(id)
      this.active(r)
      const signer = this.signer(r, slotId)
      if (!signer) throw new Conflict('Unknown signer')
      if (signer.phase === 'signed')
        throw new Conflict('Cannot reset a completed signature')
      if (!['pending', 'refused', 'awaiting_wallet'].includes(signer.phase))
        throw new Conflict('Operation requires reconciliation; do not reset')
      if (signer.phase === 'awaiting_wallet') {
        signer.phase = 'pending'
        delete signer.attemptId
        delete signer.error
        delete r.sessions[key(signer.slotId)]
        this.event(r, 'Wallet session reset', signer.name)
        this.store.save(r)
      }
      return publicView(r)
    })
  }

  async close(id: string, status: 'cancelled' | 'declined', slotId?: Hex) {
    return this.store.exclusive(id, () => {
      const r = this.store.get(id)
      this.active(r)
      const target = slotId ? this.signer(r, slotId) : undefined
      if (slotId && !target) throw new Conflict('Unknown signer')
      if (
        (target && target.phase === 'signed') ||
        r.status === 'completed' ||
        r.signers.some((s) => ['opening', 'signing', 'uncertain'].includes(s.phase))
      )
        throw new Conflict('Cannot close completed or uncertain work')
      r.status = status
      this.event(
        r,
        status === 'cancelled' ? 'Sender cancelled' : 'Signer declined',
        target ? target.name ?? target.slotId : undefined,
      )
      r.sessions = {}
      this.store.save(r)
      return publicView(r)
    })
  }
  recover() {
    for (const r of this.store.list()) {
      let changed = false
      for (const signer of r.signers)
        if (['opening', 'signing'].includes(signer.phase)) {
          signer.phase = 'uncertain'
          signer.error = 'Interrupted operation; reconciliation required'
          changed = true
        }
      if (changed) {
        this.event(r, 'Interrupted operation preserved')
        this.store.save(r)
      }
    }
  }
}
