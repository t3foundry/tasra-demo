import { Hono, type Context } from 'hono'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { pollOid4vpSession } from 'tasra-sdk/verifier-agent'
import { verifyCompactJws, jwkFromDid, parseSdJwt, sdJwtClaims, type Jwk } from 'tasra-sdk/oid4vp'
import { loadService, liveBackend, readKey } from './backend'
import { deployment, verifierAgentUrl, tasra } from './config'
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
  listSigners,
  listKeySlots,
  hasSigner,
  addSigner,
  issueSignerCredential,
  issueRemoteSignerCredential,
  createSignerSlot,
} from './signers'
import { verifyBundle, type Person, type Manifest, type Bundle, type Hex, type SignerRef } from '../shared/model'

export type AppContext = { Variables: NonNullable<unknown> }

const root = join(import.meta.dirname, '..')
const serverPublic = join(import.meta.dirname, 'public')
const webDist = join(root, 'web', 'dist')
const webPublic = join(root, 'web', 'public')

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

  const publicJson = JSON.parse(
    readFileSync(join(stateDirectory, 'public.json'), 'utf8'),
  ) as { issuerDid?: string }

  const holderKeys = new Map<string, Jwk>()
  for (const person of Object.keys(config.slots) as Person[]) {
    const slotId = config.slots[person]
    const jwk = config.holderKeys[person]
    if (slotId && jwk) holderKeys.set(slotId.toLowerCase(), jwk)
  }
  for (const s of listSigners())
    if (s.holderKey) holderKeys.set(s.slotId.toLowerCase(), s.holderKey)

  app.get('/api/config', (c) =>
    c.json({
      chainId: deployment.chainId,
      keyRegistry: deployment.addresses.KeyRegistry,
      verifierAgentUrl,
      slots: config.slots,
    }),
  )

  app.get('/api/signers', (c) =>
    c.json(
      listSigners().map((s) => ({
        name: s.name,
        slotId: s.slotId,
        dcql: publicJson.issuerDid
          ? JSON.parse(
              tasra.credentials.policy({
                issuer: publicJson.issuerDid,
                type: 'DocumentSigner',
                subjects: ['did:demo:' + s.name],
                claims: { role: ['document-signer'] },
              }),
            )
          : undefined,
      })),
    ),
  )

  app.get('/api/key-slots', async (c) => c.json(await listKeySlots()))

  type SignerJob = {
    id: string
    name: string
    status: 'running' | 'completed' | 'failed'
    progress: string[]
    result?: { name: string; slotId: Hex; credential: string }
    error?: string
  }
  const signerJobs = new Map<string, SignerJob>()

  app.post('/api/signers', async (c) => {
    const b = await readBody(c)
    const name = text(b.name).trim().toLowerCase()
    const holderDid = text(b.holderDid)
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name))
      throw new Conflict('Signer name must be lowercase letters, digits and dashes')
    if (!/^did:jwk:[A-Za-z0-9_-]+$/.test(holderDid))
      throw new Conflict('Holder DID must be a did:jwk identifier')
    if (hasSigner(name))
      throw new Conflict('A signer named "' + name + '" already exists')
    if ([...signerJobs.values()].some((j) => j.status === 'running'))
      throw new Conflict('A signer creation is already in progress')

    const job: SignerJob = { id: randomUUID(), name, status: 'running', progress: [] }
    signerJobs.set(job.id, job)
    void (async () => {
      try {
        job.progress.push('Issuing the signer credential…')
        const credential = issueSignerCredential(name, holderDid)
        job.progress.push('Credential issued')
        job.progress.push('Creating the key slot…')
        const slotId = await createSignerSlot(name, (message) =>
          job.progress.push(message),
        )
        job.progress.push('Persisting the signer…')
        addSigner({ name, slotId, holderKey: jwkFromDid(holderDid) })
        job.status = 'completed'
        job.result = { name, slotId, credential }
      } catch (e) {
        job.status = 'failed'
        job.error = (e as Error).message
      }
    })()
    return c.json({ jobId: job.id }, 202)
  })

  app.get('/api/signers/jobs/:id', (c) => {
    const job = signerJobs.get(c.req.param('id'))
    if (!job) throw new Conflict('Unknown signer creation job')
    return c.json(job)
  })

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
    if (hasSigner(name))
      throw new Conflict('A signer named "' + name + '" already exists')
    if ([...signerJobs.values(), ...remoteSignerJobs.values()].some((j) => j.status === 'running'))
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
        const { credential, holderKey } = issueRemoteSignerCredential(name, holderDid)
        job.progress.push('Credential issued')
        job.progress.push('Creating the key slot…')
        const slotId = await createSignerSlot(name, (message) =>
          job.progress.push(message),
        )
        job.progress.push('Persisting the signer…')
        addSigner({ name, slotId, holderKey })
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

  // OpenID4VCI issuer: a remote wallet scans the QR and receives a DocumentSigner SD-JWT.
  const vciOrigin = (c: Context) => new URL(c.req.url).origin

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
    if (!listSigners().some((s) => s.name === name))
      throw new Conflict('Unknown signer')
    const offerUri = createOffer(name, vciOrigin(c))
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
      if (b.credential_configuration_id !== 'DocumentSigner')
        return c.json({ error: 'unsupported_credential_type', error_description: 'Unsupported credential configuration' }, 400)
      const proof = b.proofs?.jwt?.[0]
      if (!proof)
        return c.json({ error: 'invalid_request', error_description: 'Missing holder proof' }, 400)
      const { holderDid, signerName } = verifyProofJwt(token, proof, vciOrigin(c))
      const credential = issueForHolder(signerName, holderDid)
      console.log(
        `[vci] issued DocumentSigner VC for signer=${signerName} holder=${holderDid}`,
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