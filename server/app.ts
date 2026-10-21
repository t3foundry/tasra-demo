import { Hono, type Context } from 'hono'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { pollOid4vpSession } from 'tasra-sdk/verifier-agent'
import { verifyCompactJws, parseSdJwt, sdJwtClaims, type Jwk } from 'tasra-sdk/oid4vp'
import { loadService, liveBackend, readKey } from './backend'
import { deployment, verifierAgentUrl } from './config'
import { createZip, readZip } from './zip'
import { Store, stateDirectory } from './store'
import { Workflow, publicView, Conflict, migrateRecords, type RequestRecord } from './workflow'
import {
  createOffer,
  issuerMetadata,
  authorizationServerMetadata,
  exchangeToken,
  issueNonce,
  verifyProofJwt,
  issueForHolder,
} from './vci'
import {
  issueRemoteSignerCredential,
  createSignerSlot,
} from './signers'
import { verifyBundle, type Person, type Manifest, type Bundle, type Hex, type SignerRef } from '../shared/model'
import {
  type EncryptionManifest,
  type EncryptionEnvelope,
} from '../shared/encrypt'
import {
  createEncryptionSlot,
  groupKeyParams,
  openDecryptSession,
  decodeWrappedKey,
  decryptDocument,
  type DecryptSession,
} from './encryption'
import { demoVideoUrls } from './videos'

export type AppContext = { Variables: NonNullable<unknown> }

const root = join(import.meta.dirname, '..')
const serverPublic = join(import.meta.dirname, 'public')
const webDist = join(root, 'web', 'dist')
const webPublic = join(root, 'web', 'public')

/**
 * The public origin this server is reachable at. Behind a TLS-terminating reverse
 * proxy (nginx ingress, Cloudflare, etc.) the Node process sees an `http://`
 * request even though clients use `https://`, so `c.req.url` must not be trusted
 * for credential-issuer URLs — the wallet would be handed an HTTP issuer and be
 * blocked as mixed content.
 *
 * Resolution order:
 *  1. `PUBLIC_ORIGIN` env var (explicit, canonical) — recommended for deploys.
 *  2. `X-Forwarded-Proto`/`X-Forwarded-Host` — only when `TRUST_PROXY` is set.
 *  3. The request URL — accepted only for loopback hosts (local dev). For a
 *     remote host with no explicit configuration this fails closed instead of
 *     silently advertising an `http://` issuer.
 */
function firstForwarded(value: string | undefined): string | undefined {
  if (!value) return undefined
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** Hosts where a plain `http://` issuer is legitimate (local development). */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  )
}

function publicOrigin(c: Context): string {
  const configured = process.env.PUBLIC_ORIGIN
  if (configured) {
    const url = new URL(configured)
    // Fail closed: a public deployment must advertise itself over https.
    if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
      throw new Error('PUBLIC_ORIGIN must be an https:// origin when publicly reachable')
    }
    return url.origin
  }

  if (/^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '')) {
    const proto = firstForwarded(c.req.header('x-forwarded-proto'))
    const host = firstForwarded(c.req.header('x-forwarded-host'))
    if (proto && host) return `${proto}://${host}`
  }

  const url = new URL(c.req.url)
  // Fail closed on the fallback too: without PUBLIC_ORIGIN or TRUST_PROXY we can
  // only infer the scheme from the socket, which is `http` behind a TLS proxy.
  // Advertising `http://` to a browser wallet is guaranteed mixed content, so
  // refuse for any non-loopback host rather than emit a broken offer.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      'Cannot determine a public https:// origin for this host; set PUBLIC_ORIGIN (or TRUST_PROXY=1) and redeploy',
    )
  }
  return url.origin
}

function lookup(...paths: string[]) {
  for (const p of paths) if (existsSync(p)) return p
  return undefined
}

function serveFile(path: string, type: string) {
  return new Response(readFileSync(path), {
    status: 200,
    headers: { 'content-type': type },
  })
}

async function readBody(c: Context) {
  const value = (await c.req.json().catch(() => undefined)) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Conflict('Expected JSON object')
  return value as Record<string, unknown>
}

const text = (v: unknown) => {
  if (typeof v !== 'string') throw new Conflict('Expected text')
  return v
}

export function createApp() {
  const config = loadService()
  const store = new Store<RequestRecord>()
  const workflow = new Workflow(store, liveBackend(config), {
    chainId: deployment.chainId,
    keyRegistry: deployment.addresses.KeyRegistry!,
  })
  migrateRecords(store)
  workflow.recover()

  const app = new Hono()

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
    await next()
  })

  const isOwner = (c: Context) => {
    const supplied = Buffer.from(
      c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
    )
    const expected = Buffer.from(config.senderToken)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new Conflict('Open the private sender-console link printed by the server')
  }

  const holderKeys = new Map<string, Jwk>()
  for (const person of Object.keys(config.slots) as Person[]) {
    const slotId = config.slots[person]
    const jwk = config.holderKeys[person]
    if (slotId && jwk) holderKeys.set(slotId.toLowerCase(), jwk)
  }

  app.get('/api/config', (c) =>
    c.json({
      chainId: deployment.chainId,
      keyRegistry: deployment.addresses.KeyRegistry,
      verifierAgentUrl,
      slots: config.slots,
    }),
  )

  type RemoteSignerJob = {
    id: string
    name: string
    status: 'running' | 'completed' | 'failed'
    progress: string[]
    result?: { name: string; slotId: Hex; credential: string; holderDid: string }
    error?: string
  }
  const remoteSignerJobs = new Map<string, RemoteSignerJob>()

  app.post('/api/signers/remote', async (c) => {
    const b = await readBody(c)
    const name = text(b.name).trim().toLowerCase()
    const holderDid = text(b.holderDid)
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
      throw new Conflict('Signer name must be lowercase letters, digits and dashes')
    if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(holderDid))
      throw new Conflict('Holder DID must be an Ed25519 did:key identifier')
    if ([...remoteSignerJobs.values()].some((j) => j.status === 'running'))
      throw new Conflict('A signer creation is already in progress')

    const job: RemoteSignerJob = {
      id: randomUUID(),
      name,
      status: 'running',
      progress: [],
    }
    remoteSignerJobs.set(job.id, job)
    void (async () => {
      try {
        job.progress.push('Issuing the credential for the remote wallet…')
        const { credential } = issueRemoteSignerCredential(name, holderDid)
        job.progress.push('Credential issued')
        job.progress.push('Creating the key slot…')
        const slotId = await createSignerSlot(name, (message) =>
          job.progress.push(message),
        )
        job.status = 'completed'
        job.result = { name, slotId, credential, holderDid }
      } catch (e) {
        job.status = 'failed'
        job.error = (e as Error).message
      }
    })()
    return c.json({ jobId: job.id }, 202)
  })

  app.get('/api/signers/remote-jobs/:id', (c) => {
    const job = remoteSignerJobs.get(c.req.param('id'))
    if (!job) throw new Conflict('Unknown remote signer creation job')
    return c.json(job)
  })

  // Demo videos: presigned S3 URLs generated server-side (credentials stay private).
  app.get('/api/videos', (c) => c.json(demoVideoUrls()))

  // Encryption: BLS identity-encryption key slots and document encryption.
  type EncryptionKeyJob = {
    id: string
    name: string
    status: 'running' | 'completed' | 'failed'
    progress: string[]
    result?: { name: string; slotId: Hex }
    error?: string
  }
  const encryptionKeyJobs = new Map<string, EncryptionKeyJob>()

  app.post('/api/encryption/keys', async (c) => {
    const b = await readBody(c)
    const name = text(b.name).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
      throw new Conflict('Key name must be lowercase letters, digits and dashes')
    if ([...encryptionKeyJobs.values()].some((j) => j.status === 'running'))
      throw new Conflict('A key creation is already in progress')
    const job: EncryptionKeyJob = { id: randomUUID(), name, status: 'running', progress: [] }
    encryptionKeyJobs.set(job.id, job)
    void (async () => {
      try {
        job.progress.push('Creating the BLS key slot…')
        const slotId = await createEncryptionSlot(name, (message) =>
          job.progress.push(message),
        )
        job.progress.push('Key slot ready')
        job.status = 'completed'
        job.result = { name, slotId }
      } catch (e) {
        job.status = 'failed'
        job.error = (e as Error).message
      }
    })()
    return c.json({ jobId: job.id }, 202)
  })

  app.get('/api/encryption/keys/jobs/:id', (c) => {
    const job = encryptionKeyJobs.get(c.req.param('id'))
    if (!job) throw new Conflict('Unknown key creation job')
    return c.json(job)
  })

  app.post('/api/encryption/keys/:name/issue-vc', async (c) => {
    const name = c.req.param('name')
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
      throw new Conflict('Key name must be lowercase letters, digits and dashes')
    const offerUri = createOffer('DocumentReader', name, vciOrigin(c))
    const dataUrl = await QRCode.toDataURL(offerUri)
    return c.json({ offerUri, qrDataUrl: dataUrl })
  })

  // Public params for local envelope encryption: the slot's group public key,
  // epoch and deployment identity the browser needs to build a v2 bundle.
  app.post('/api/encryption/keys/:slotId/group-key', async (c) => {
    const slotId = c.req.param('slotId') as Hex
    if (!/^0x[0-9a-f]{64}$/i.test(slotId))
      throw new Conflict('Invalid key slot identifier')
    const { mpk, epoch } = await groupKeyParams(slotId.toLowerCase() as Hex)
    return c.json({
      mpk,
      epoch,
      slotId: slotId.toLowerCase(),
      chainId: deployment.chainId,
      keyRegistry: deployment.addresses.KeyRegistry,
    })
  })

  // Decryption: an uploaded bundle names a key slot and the group-key wrapped AES
  // key; a remote wallet presents its DocumentReader credential to authorize
  // threshold unwrapping of the JWT that carries the AES key + nonce.
  type DecryptEntry = {
    manifest: EncryptionManifest
    envelope: EncryptionEnvelope
    session: DecryptSession
    fileName: string
    phase: 'awaiting_wallet' | 'decrypting' | 'done' | 'failed'
    jwtBase64?: string
    error?: string
  }
  // Decrypt sessions intentionally stay in this map after reaching `done` or
  // `failed`: the client's polling loop fetches the terminal status (and, on
  // `done`, the wrapped AES key) on a subsequent request, so removing the entry
  // immediately would surface "Unknown decryption session". A TTL sweep to
  // reclaim these entries could be added later.
  const decryptSessions = new Map<string, DecryptEntry>()

  app.post('/api/encryption/decrypt', async (c) => {
    const b = await readBody(c)
    const manifest = b.manifest as Partial<EncryptionManifest> | undefined
    const envelope = b.envelope as Partial<EncryptionEnvelope> | undefined
    if (
      !manifest ||
      !envelope ||
      manifest.schema !== 'tasra-encrypt/v2' ||
      typeof manifest.title !== 'string' ||
      !manifest.title.trim() ||
      manifest.title.length > 120 ||
      !Number.isSafeInteger(manifest.version) ||
      (manifest.version as number) < 1 ||
      !/^[0-9a-f-]{36}$/i.test(manifest.recordId ?? '') ||
      !/^[0-9a-f]{64}$/.test(manifest.documentSha256 ?? '') ||
      manifest.chainId !== deployment.chainId ||
      !/^0x[0-9a-f]{40}$/i.test(manifest.keyRegistry ?? '') ||
      (manifest.keyRegistry ?? '').toLowerCase() !==
        deployment.addresses.KeyRegistry!.toLowerCase() ||
      !/^0x[0-9a-f]{64}$/i.test(manifest.slotId ?? '') ||
      typeof envelope.encryptedAesKey !== 'string' ||
      typeof envelope.aesCiphertext !== 'string' ||
      !Number.isSafeInteger(envelope.epoch) ||
      (envelope.epoch as number) < 0
    )
      throw new Conflict('Upload a valid Tasra encryption bundle')
    const env = envelope as EncryptionEnvelope
    const isStrictBase64 = (s: string) =>
      /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0
    if (
      !isStrictBase64(env.encryptedAesKey) ||
      !isStrictBase64(env.aesCiphertext) ||
      Buffer.from(env.encryptedAesKey, 'base64').length === 0 ||
      Buffer.from(env.aesCiphertext, 'base64').length === 0
    )
      throw new Conflict('Upload a valid Tasra encryption bundle')
    const slotId = manifest.slotId!.toLowerCase() as Hex
    const wrapped = decodeWrappedKey(
      envelope as EncryptionEnvelope,
      manifest.documentSha256!,
    )
    const session = await openDecryptSession(
      slotId,
      wrapped.aad,
      wrapped.ciphertext,
      `Decrypt ${manifest.title} (version ${manifest.version})`,
    )
    const fileName = `${manifest.title.replace(/[^\w.-]+/g, '_')} (v${manifest.version}).pdf`
    const id = randomUUID()
    decryptSessions.set(id, {
      manifest: manifest as EncryptionManifest,
      envelope: envelope as EncryptionEnvelope,
      session,
      fileName,
      phase: 'awaiting_wallet',
    })
    return c.json({
      id,
      qrPayload: session.qrPayload,
      qrDataUrl: await QRCode.toDataURL(session.qrPayload),
      manifest,
    })
  })

  app.post('/api/encryption/decrypt/:id/status', async (c) => {
    const entry = decryptSessions.get(c.req.param('id'))
    if (!entry) throw new Conflict('Unknown decryption session')
    if (entry.phase === 'done')
      return c.json({ status: 'done', jwtBase64: entry.jwtBase64 })
    if (entry.phase === 'failed')
      return c.json({ status: 'failed', error: entry.error })
    if (entry.phase === 'decrypting') return c.json({ status: 'processing' })
    const status = await pollOid4vpSession(
      verifierAgentUrl,
      entry.session.sessionId,
      entry.session.pollSecret,
    )
    if (status.status !== 'done')
      return c.json({
        status: 'awaiting',
        qrPayload: entry.session.qrPayload,
        qrDataUrl: await QRCode.toDataURL(entry.session.qrPayload),
      })
    entry.phase = 'decrypting'
    try {
      const wrapped = decodeWrappedKey(
        entry.envelope,
        entry.manifest.documentSha256,
      )
      const jwtBytes = await decryptDocument(
        entry.session,
        wrapped.ciphertext,
        wrapped.epoch,
        wrapped.aad,
        () => {},
      )
      try {
        entry.jwtBase64 = Buffer.from(jwtBytes).toString('base64')
      } finally {
        jwtBytes.fill(0)
      }
      entry.phase = 'done'
      return c.json({ status: 'done', jwtBase64: entry.jwtBase64 })
    } catch (e) {
      entry.phase = 'failed'
      entry.error =
        e instanceof Error && e.name === 'AuthorizationRefused'
          ? 'The verifier refused this credential'
          : e instanceof Error
            ? e.message
            : 'Decryption failed'
      return c.json({ status: 'failed', error: entry.error })
    }
  })

  // OpenID4VCI issuer: a remote wallet scans the QR and receives a DocumentSigner SD-JWT.
  const vciOrigin = (c: Context) => publicOrigin(c)

  // The wallet is a browser PWA on a different origin (e.g. the Tasra Vault). Reflect the
  // request origin so it may fetch this local issuer cross-origin and complete redemption.
  const corsHeaders = (c: Context) => {
    const origin = c.req.header('origin')
    return {
      'Access-Control-Allow-Origin': origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    }
  }
  const vci = (c: Context) => {
    const headers = corsHeaders(c)
    c.header('Access-Control-Allow-Origin', headers['Access-Control-Allow-Origin'])
    c.header('Access-Control-Allow-Methods', headers['Access-Control-Allow-Methods'])
    c.header('Access-Control-Allow-Headers', headers['Access-Control-Allow-Headers'])
    c.header('Access-Control-Max-Age', headers['Access-Control-Max-Age'])
  }
  app.options('/*', (c) => {
    vci(c)
    return c.body(null, 204)
  })

  app.post('/api/signers/:name/issue-vc', async (c) => {
    const name = c.req.param('name')
    const offerUri = createOffer('DocumentSigner', name, vciOrigin(c))
    const dataUrl = await QRCode.toDataURL(offerUri)
    return c.json({ offerUri, qrDataUrl: dataUrl })
  })

  app.get('/.well-known/openid-credential-issuer', (c) => {
    vci(c)
    return c.json(issuerMetadata(vciOrigin(c)))
  })

  app.get('/.well-known/oauth-authorization-server', (c) => {
    vci(c)
    return c.json(authorizationServerMetadata(vciOrigin(c) + '/token'))
  })

  app.get('/.well-known/openid-configuration', (c) => {
    vci(c)
    return c.json(authorizationServerMetadata(vciOrigin(c) + '/token'))
  })

  app.post('/token', async (c) => {
    vci(c)
    try {
      const body = await c.req.parseBody()
      const code = String(body['pre-authorized_code'] ?? '')
      if (!code) return c.json({ error: 'invalid_request', error_description: 'Missing pre-authorized code' }, 400)
      const { access_token, c_nonce } = exchangeToken(code)
      return c.json({
        access_token,
        token_type: 'bearer',
        expires_in: 600,
        c_nonce,
        c_nonce_expires_in: 600,
      })
    } catch (e) {
      return c.json({ error: 'invalid_grant', error_description: (e as Error).message }, 400)
    }
  })

  app.post('/nonce', async (c) => {
    vci(c)
    const auth = c.req.header('authorization') ?? ''
    const token = auth.replace(/^Bearer /, '')
    const c_nonce = issueNonce(token)
    return c.json({ c_nonce })
  })

  app.post('/credential', async (c) => {
    vci(c)
    try {
      const auth = c.req.header('authorization') ?? ''
      const token = auth.replace(/^Bearer /, '')
      const b = (await c.req.json().catch(() => ({}))) as {
        credential_configuration_id?: string
        proofs?: { jwt?: string[] }
      }
      const credentialKind = b.credential_configuration_id
      if (credentialKind !== 'DocumentSigner' && credentialKind !== 'DocumentReader')
        return c.json({ error: 'unsupported_credential_type', error_description: 'Unsupported credential configuration' }, 400)
      const proof = b.proofs?.jwt?.[0]
      if (!proof)
        return c.json({ error: 'invalid_request', error_description: 'Missing holder proof' }, 400)
      const { holderDid, credentialKind: exchangeKind, name } = verifyProofJwt(
        token,
        proof,
        vciOrigin(c),
      )
      if (exchangeKind !== credentialKind)
        return c.json({ error: 'invalid_proof', error_description: 'Credential configuration does not match the offer' }, 400)
      const credential = issueForHolder(credentialKind, name, holderDid)
      console.log(
        `[vci] issued ${credentialKind} VC for name=${name} holder=${holderDid}`,
      )
      console.log('[vci] compact:', credential)
      console.log('[vci] claims:', JSON.stringify(sdJwtClaims(parseSdJwt(credential)), null, 2))
      return c.json({
        credentials: [{ credential }],
        notification_id: randomUUID(),
      })
    } catch (e) {
      return c.json({ error: 'invalid_proof', error_description: (e as Error).message }, 400)
    }
  })

  app.get('/api/requests', (c) =>
    c.json(store.list().map(publicView).reverse()),
  )

  app.post('/api/requests', async (c) => {
    const b = await readBody(c)
    const signers = (Array.isArray(b.signers) ? b.signers : []) as SignerRef[]
    return c.json(
      await workflow.create({
        id: text(b.id),
        title: text(b.title),
        version: Number(b.version),
        pdf: Buffer.from(text(b.pdfBase64), 'base64'),
        signers,
      }),
      201,
    )
  })

  app.post('/api/verify', async (c) => {
    const b = await readBody(c)
    const expected = b.expected as Manifest
    if (
      expected.chainId !== deployment.chainId ||
      expected.keyRegistry !== deployment.addresses.KeyRegistry
    )
      throw new Conflict('Unexpected deployment')
    await verifyBundle(
      Buffer.from(text(b.pdfBase64), 'base64'),
      expected,
      b.bundle as Bundle,
      readKey,
    )
    return c.json({
      verified: true,
      policy: 'Current anchored signer keys; not an archival timestamp',
      signers: expected.signers,
    })
  })

  app.post('/api/verify-zip', async (c) => {
    const b = await readBody(c)
    const files = readZip(Buffer.from(text(b.zipBase64), 'base64'))
    const pdf = files.get('document.pdf')
    const request = files.get('request.json')
    const signatures = files.get('signatures.json')
    if (!pdf || !request || !signatures)
      throw new Conflict(
        'Bundle must contain document.pdf, request.json and signatures.json',
      )
    const expected = JSON.parse(request.toString('utf8')) as Manifest
    const bundle = JSON.parse(signatures.toString('utf8')) as Bundle
    if (
      expected.chainId !== deployment.chainId ||
      expected.keyRegistry !== deployment.addresses.KeyRegistry
    )
      throw new Conflict('Unexpected deployment')
    await verifyBundle(pdf, expected, bundle, readKey)
    return c.json({
      verified: true,
      policy: 'Current anchored signer keys; not an archival timestamp',
      title: expected.title,
      version: expected.version,
      signers: expected.signers,
    })
  })

  app.get('/api/requests/:id', (c) =>
    c.json(publicView(store.get(c.req.param('id')))),
  )

  app.get('/api/requests/:id/pdf', (c) => {
    const record = store.get(c.req.param('id'))
    return c.body(Buffer.from(record.pdfBase64, 'base64'), 200, {
      'content-type': 'application/pdf',
      'content-disposition': 'inline; filename="document.pdf"',
    })
  })

  app.get('/api/requests/:id/request', (c) => {
    const record = store.get(c.req.param('id'))
    return c.body(JSON.stringify(record.manifest, null, 2), 200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="request.json"',
    })
  })

  app.get('/api/requests/:id/bundle', async (c) => {
    const record = store.get(c.req.param('id'))
    if (record.status !== 'completed')
      throw new Conflict('Both signatures are required')
    const bundle = {
      manifest: record.manifest,
      signatures: record.signers.map((s) => s.signature!),
    }
    await verifyBundle(
      Buffer.from(record.pdfBase64, 'base64'),
      record.manifest,
      bundle,
      readKey,
    )
    return c.body(JSON.stringify(bundle, null, 2), 200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="signatures.json"',
    })
  })

  app.get('/api/requests/:id/bundle.zip', async (c) => {
    const record = store.get(c.req.param('id'))
    if (record.status !== 'completed')
      throw new Conflict('Both signatures are required')
    const pdf = Buffer.from(record.pdfBase64, 'base64')
    const bundle = {
      manifest: record.manifest,
      signatures: record.signers.map((s) => s.signature!),
    }
    await verifyBundle(pdf, record.manifest, bundle, readKey)
    const zip = createZip([
      { name: 'document.pdf', data: pdf },
      { name: 'request.json', data: Buffer.from(JSON.stringify(record.manifest, null, 2) + '\n') },
      { name: 'signatures.json', data: Buffer.from(JSON.stringify(bundle, null, 2) + '\n') },
    ])
    return c.body(new Uint8Array(zip), 200, {
      'content-type': 'application/zip',
      'content-disposition': 'attachment; filename="bundle.zip"',
    })
  })

  app.post('/api/requests/:id/cancel', async (c) =>
    c.json(await workflow.close(c.req.param('id'), 'cancelled')),
  )

  app.post('/api/requests/:id/:slot/:verb', async (c) => {
    const id = c.req.param('id')
    const slotId = c.req.param('slot') as Hex
    const verb = c.req.param('verb')
    const record = store.get(id)
    const signer = record.signers.find(
      (s) => s.slotId.toLowerCase() === slotId.toLowerCase(),
    )
    if (!signer) throw new Conflict('Unknown signer')
    const b = await readBody(c)

    if (verb === 'prepare')
      return c.json(await workflow.prepare(id, slotId, text(b.documentSha256)))
    if (verb === 'decline') {
      const jwk = holderKeys.get(slotId.toLowerCase())
      if (!jwk) throw new Conflict('This signer cannot decline from the demo wallet')
      const { header, payload } = verifyCompactJws(text(b.proof), jwk)
      if (
        header.typ !== 'tasra-decline+jwt' ||
        payload.aud !== 'tasra-sign-decline/v1' ||
        payload.requestId !== id ||
        payload.documentSha256 !== record.manifest.documentSha256 ||
        typeof payload.slotId !== 'string' ||
        payload.slotId.toLowerCase() !== slotId.toLowerCase() ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp < Date.now() / 1000 ||
        payload.exp > Date.now() / 1000 + 180
      )
        throw new Conflict('Invalid decline authorization')
      return c.json(await workflow.close(id, 'declined', slotId))
    }

    if (verb === 'reset')
      return c.json(await workflow.reset(id, slotId))

    const attemptId = text(b.attemptId)
    if (verb === 'complete')
      return c.json(await workflow.complete(id, slotId, attemptId))

    const saved = record.sessions[slotId.toLowerCase()]
    if (
      signer.attemptId !== attemptId ||
      !saved ||
      signer.phase !== 'awaiting_wallet'
    )
      throw new Conflict('Wallet session is no longer active')

    if (verb === 'session') {
      const status = await pollOid4vpSession(
        verifierAgentUrl,
        saved.sessionId,
        saved.pollSecret,
      )
      return c.json({
        sessionId: saved.sessionId,
        requestUri: saved.requestUri,
        qrPayload: saved.qrPayload,
        qrDataUrl: await QRCode.toDataURL(saved.qrPayload),
        operation: saved.operation,
        requestHash: saved.requestHash,
        bindingPreimage: status.bindingPreimage,
        status: status.status,
        error: status.error,
      })
    }

    if (verb === 'transport') {
      const target = new URL(text(b.url))
      const method = b.method === 'POST' ? 'POST' : 'GET'
      const allowed =
        target.origin === new URL(verifierAgentUrl).origin &&
        ((method === 'GET' &&
          (target.href === saved.requestUri ||
            (target.pathname === '/.well-known/did.json' && !target.search))) ||
          (method === 'POST' &&
            target.href === verifierAgentUrl + '/v1/response?session=' + saved.sessionId))
      if (!allowed)
        throw new Conflict('Wallet transport is outside the configured session')
      const response = await fetch(target, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers:
          method === 'POST'
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : { accept: 'application/json, application/oauth-authz-req+jwt' },
        body: method === 'POST' ? text(b.body) : undefined,
      })
      return c.json({
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: await response.text(),
      })
    }

    throw new Conflict('Unknown action')
  })

  // Static assets used by the browser PDF preview and the sample document.
  app.get('/sample.pdf', (c) =>
    serveFile(join(serverPublic, 'sample.pdf'), 'application/pdf'),
  )

  app.get('/pdf-assets/*', (c) => {
    const rel = new URL(c.req.url).pathname.replace(/^\/pdf-assets\//, '')
    const path = lookup(
      join(webDist, 'pdf-assets', rel),
      join(webPublic, 'pdf-assets', rel),
    )
    if (!path) return c.notFound()
    if (statSync(path).isDirectory()) return c.notFound()
    const type = path.endsWith('.mjs')
      ? 'text/javascript'
      : path.endsWith('.wasm')
        ? 'application/wasm'
        : 'application/octet-stream'
    return serveFile(path, type)
  })

  // Production: serve the built React bundle with an SPA fallback.
  app.get('*', (c) => {
    if (!existsSync(webDist))
      return c.text(
        'Frontend not built; run "npm run build:web" or use the Vite dev server.',
        404,
      )
    const url = new URL(c.req.url)
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const asset = lookup(join(webDist, pathname))
    if (asset && !statSync(asset).isDirectory()) {
      const type = asset.endsWith('.html')
        ? 'text/html'
        : asset.endsWith('.css')
          ? 'text/css'
          : asset.endsWith('.js')
            ? 'text/javascript'
            : 'application/octet-stream'
      return serveFile(asset, type)
    }
    return serveFile(join(webDist, 'index.html'), 'text/html')
  })

  app.onError((err, c) => {
    const message =
      err instanceof Conflict
        ? err.message
        : err instanceof Error && err.name === 'AuthorizationRefused'
          ? 'The verifier refused this credential'
          : 'Request failed; inspect the request status and local configuration'
    const status =
      err instanceof Conflict
        ? 409
        : err instanceof Error && err.name === 'AuthorizationRefused'
          ? 403
          : 400
    return c.json({ error: message }, status)
  })

  return app
}