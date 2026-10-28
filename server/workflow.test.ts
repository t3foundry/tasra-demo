import { createIdentity, issueCredential } from '@t3foundry/tasra-sdk/app'
import { importWallet } from '../shared/wallet'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SigningBackend, RequestRecord, SessionRecord } from './workflow'
import { Workflow } from './workflow'
import { Store, lockDirectory } from './store'
import { digest, toHex, type Hex, type Proof } from '../shared/model'

const pdf = new TextEncoder().encode('%PDF-1.4\ntest')
const alice = `0x${'11'.repeat(32)}` as Hex
const bob = `0x${'22'.repeat(32)}` as Hex
const network = {
  chainId: 43112,
  keyRegistry: `0x${'33'.repeat(20)}` as Hex,
}
const signers = [
  { slotId: alice, name: 'alice' },
  { slotId: bob, name: 'bob' },
]

function attemptOf(
  r: { signers: Array<{ slotId: Hex; attemptId?: string }> },
  slotId: Hex,
): string {
  return r.signers.find((s) => s.slotId === slotId)?.attemptId as string
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'tasra-sign-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let submitted = 0
  const backend: SigningBackend = {
    async open() {
      return {
        sessionId: 'test',
        pollSecret: 'private',
        requestUri: 'https://example.test/request',
        qrPayload: 'test',
        requestHash: alice,
        operation: {},
      } as SessionRecord
    },
    async sign(_, slotId, __, before) {
      before()
      submitted++
      return {
        slotId,
        publicKey: alice,
        epoch: 1,
        r: alice,
        z: alice,
        receiptStatus: 'verified',
      } as Proof
    },
    async verify() {},
  }
  const store = new Store<RequestRecord>(root)
  const workflow = new Workflow(store, backend, network)
  return {
    root,
    store,
    backend,
    workflow,
    count: () => submitted,
    create: () =>
      workflow.create({
        id: randomUUID(),
        title: 'Agreement',
        version: 1,
        pdf,
        signers,
      }),
  }
}

void test('creation is idempotent, freezes bytes and hides sessions', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const id = r.manifest.requestId
  assert.deepEqual(
    await f.workflow.create({
      id,
      title: 'Agreement',
      version: 1,
      pdf,
      signers,
    }),
    r,
  )
  await assert.rejects(
    f.workflow.create({ id, title: 'Changed', version: 1, pdf, signers }),
    /different content/,
  )
  await assert.rejects(f.workflow.prepare(id, alice, 'wrong'), /differs/)
  const p = await f.workflow.prepare(id, alice, await digest(pdf))
  assert.ok(!('sessions' in p))
  assert.ok(!JSON.stringify(p).includes('private'))
})

void test('Bob may sign before Alice; concurrent retries sign once; state survives restart', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const id = r.manifest.requestId
  const hash = r.manifest.documentSha256
  const bobFirst = await f.workflow.prepare(id, bob, hash)
  assert.equal(
    (await f.workflow.complete(id, bob, attemptOf(bobFirst, bob))).status,
    'awaiting',
  )
  const prepared = await f.workflow.prepare(id, alice, hash)
  const attempt = attemptOf(prepared, alice)
  const [a, b] = await Promise.all([
    f.workflow.complete(id, alice, attempt),
    f.workflow.complete(id, alice, attempt),
  ])
  assert.deepEqual(a, b)
  assert.equal(f.count(), 2)
  const restarted = new Workflow(new Store<RequestRecord>(f.root), f.backend, network)
  restarted.recover()
  assert.deepEqual(await restarted.complete(id, alice, attempt), a)
  assert.equal(f.count(), 2)
  await assert.rejects(restarted.complete(id, alice, 'old'), /another attempt/)
  assert.equal(a.status, 'completed')
  await assert.rejects(restarted.close(id, 'cancelled'), /Cannot close/)
})

void test('post-submission failure is uncertain and never automatically retried', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const id = r.manifest.requestId
  f.backend.verify = async () => {
    throw new Error('Bad signature')
  }
  const p = await f.workflow.prepare(id, alice, r.manifest.documentSha256)
  await assert.rejects(
    f.workflow.complete(id, alice, attemptOf(p, alice)),
    /Bad signature/,
  )
  const signer = f.store.get(id).signers.find((s) => s.slotId === alice)!
  assert.equal(signer.phase, 'uncertain')
  await assert.rejects(
    f.workflow.prepare(id, alice, r.manifest.documentSha256),
    /reconciliation/,
  )
  await assert.rejects(f.workflow.close(id, 'cancelled'), /Cannot close/)
  assert.equal(f.count(), 1)
})

void test('crash during opening or signing is preserved; active writer cannot be duplicated', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const saved = f.store.get(r.manifest.requestId)
  saved.signers.find((s) => s.slotId === alice)!.phase = 'signing'
  saved.signers.find((s) => s.slotId === bob)!.phase = 'opening'
  f.store.save(saved)
  f.workflow.recover()
  const after = f.store.get(r.manifest.requestId)
  assert.equal(after.signers.find((s) => s.slotId === alice)!.phase, 'uncertain')
  assert.equal(after.signers.find((s) => s.slotId === bob)!.phase, 'uncertain')
  const unlock = lockDirectory(f.root)
  try {
    assert.throws(() => lockDirectory(f.root), /Another writer/)
  } finally {
    unlock()
  }
})

void test('credential refusal precedes submission and permits a fresh attempt', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const id = r.manifest.requestId
  f.backend.sign = async () => {
    const e = new Error('Denied')
    e.name = 'AuthorizationRefused'
    throw e
  }
  const p = await f.workflow.prepare(id, alice, r.manifest.documentSha256)
  await assert.rejects(
    f.workflow.complete(id, alice, attemptOf(p, alice)),
    /Denied/,
  )
  assert.equal(
    f.store.get(id).signers.find((s) => s.slotId === alice)!.phase,
    'refused',
  )
  assert.equal(f.count(), 0)
  const next = await f.workflow.prepare(id, alice, r.manifest.documentSha256)
  assert.notEqual(attemptOf(next, alice), attemptOf(p, alice))
  await assert.rejects(
    f.workflow.complete(id, alice, attemptOf(p, alice)),
    /another attempt/,
  )
})

void test('reset clears an abandoned wallet session so a fresh attempt can open', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const id = r.manifest.requestId
  const first = await f.workflow.prepare(id, alice, r.manifest.documentSha256)
  const firstAttempt = attemptOf(first, alice)
  assert.equal(f.store.get(id).signers.find((s) => s.slotId === alice)!.phase, 'awaiting_wallet')
  await f.workflow.reset(id, alice)
  const after = f.store.get(id).signers.find((s) => s.slotId === alice)!
  assert.equal(after.phase, 'pending')
  assert.equal(after.attemptId, undefined)
  assert.equal(f.store.get(id).sessions[alice.toLowerCase()], undefined)
  const next = await f.workflow.prepare(id, alice, r.manifest.documentSha256)
  assert.notEqual(attemptOf(next, alice), firstAttempt)
})

void test('reset refuses signed or uncertain work', async (t) => {
  const f = fixture(t)
  const r = await f.create()
  const id = r.manifest.requestId
  const p = await f.workflow.prepare(id, alice, r.manifest.documentSha256)
  await f.workflow.complete(id, alice, attemptOf(p, alice))
  await assert.rejects(f.workflow.reset(id, alice), /completed signature/)

  const signed = f.store.get(id)
  signed.signers.find((s) => s.slotId === bob)!.phase = 'uncertain'
  f.store.save(signed)
  await assert.rejects(f.workflow.reset(id, bob), /reconciliation/)
})

void test('cancel and decline close unsigned work permanently', async (t) => {
  for (const state of ['cancelled', 'declined'] as const) {
    const f = fixture(t)
    const r = await f.create()
    await f.workflow.close(
      r.manifest.requestId,
      state,
      state === 'declined' ? alice : undefined,
    )
    await assert.rejects(
      f.workflow.prepare(r.manifest.requestId, alice, r.manifest.documentSha256),
      /closed/,
    )
  }
})

test('a single signer may be requested', async (t) => {
  const f = fixture(t)
  const r = await f.workflow.create({
    id: randomUUID(),
    title: 'Solo',
    version: 1,
    pdf,
    signers: [{ slotId: alice, name: 'alice' }],
  })
  assert.equal(r.manifest.signers.length, 1)
  assert.equal(r.status, 'awaiting')
  const p = await f.workflow.prepare(r.manifest.requestId, alice, r.manifest.documentSha256)
  assert.equal(
    (await f.workflow.complete(r.manifest.requestId, alice, attemptOf(p, alice))).status,
    'completed',
  )
})

test('generated credential wallet imports with its identity and rejects swapped keys or subjects', () => {
  const issuer = createIdentity()
  const aliceIdentity = createIdentity()
  const otherIdentity = createIdentity()
  const credential = issueCredential({
    issuer,
    holder: aliceIdentity,
    type: 'DocumentSigner',
    subject: 'did:demo:alice',
    claims: { role: 'document-signer' },
  })
  const walletFile = {
    schema: 'tasra-demo-wallet/v1',
    name: 'alice',
    seed: toHex(aliceIdentity.exportPrivateKey()),
    credential,
  }
  try {
    const wallet = importWallet(JSON.stringify(walletFile))
    assert.equal(wallet.identity.did, aliceIdentity.did)
    assert.equal(wallet.credential, credential)
    wallet.identity.destroy()
    assert.throws(
      () =>
        importWallet(
          JSON.stringify({
            ...walletFile,
            seed: toHex(otherIdentity.exportPrivateKey()),
          }),
        ),
      /holder mismatch|subject mismatch/,
    )
    assert.throws(
      () => importWallet(JSON.stringify({ ...walletFile, name: 'bob' })),
      /subject mismatch/,
    )
  } finally {
    issuer.destroy()
    aliceIdentity.destroy()
    otherIdentity.destroy()
  }
})
