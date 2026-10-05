import { Hono, type Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pollOid4vpSession } from 'tasra-sdk/verifier-agent'
import { verifyCompactJws } from 'tasra-sdk/oid4vp'
import { loadService, liveBackend, readKey } from './backend'
import { deployment, verifierAgentUrl } from './config'
import { createZip, readZip } from './zip'
import { Store } from './store'
import { Workflow, publicView, Conflict, type RequestRecord } from './workflow'
import { people, verifyBundle, type Person, type Manifest, type Bundle } from '../shared/model'

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
    slots: config.slots,
  })
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

  app.get('/api/config', (c) =>
    c.json({
      chainId: deployment.chainId,
      keyRegistry: deployment.addresses.KeyRegistry,
      verifierAgentUrl,
      slots: config.slots,
    }),
  )

  app.get('/api/requests', (c) => {
    isOwner(c)
    return c.json(store.list().map(publicView).reverse())
  })

  app.post('/api/requests', async (c) => {
    isOwner(c)
    const b = await readBody(c)
    return c.json(
      await workflow.create({
        id: text(b.id),
        title: text(b.title),
        version: Number(b.version),
        pdf: Buffer.from(text(b.pdfBase64), 'base64'),
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
      signatures: people.map((p) => record.signers[p].signature!),
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
      signatures: people.map((p) => record.signers[p].signature!),
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

  app.post('/api/requests/:id/cancel', async (c) => {
    isOwner(c)
    return c.json(await workflow.close(c.req.param('id'), 'cancelled'))
  })

  app.post('/api/requests/:id/:person/:verb', async (c) => {
    const id = c.req.param('id')
    const person = c.req.param('person') as Person
    const verb = c.req.param('verb')
    if (!people.includes(person)) throw new Conflict('Unknown signer')
    const record = store.get(id)
    const b = await readBody(c)

    if (verb === 'prepare')
      return c.json(await workflow.prepare(id, person, text(b.documentSha256)))
    if (verb === 'decline') {
      const { header, payload } = verifyCompactJws(
        text(b.proof),
        config.holderKeys[person],
      )
      if (
        header.typ !== 'tasra-decline+jwt' ||
        payload.aud !== 'tasra-sign-decline/v1' ||
        payload.requestId !== id ||
        payload.documentSha256 !== record.manifest.documentSha256 ||
        payload.person !== person ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp < Date.now() / 1000 ||
        payload.exp > Date.now() / 1000 + 180
      )
        throw new Conflict('Invalid decline authorization')
      return c.json(await workflow.close(id, 'declined', person))
    }

    const attemptId = text(b.attemptId)
    if (verb === 'complete')
      return c.json(await workflow.complete(id, person, attemptId))

    const saved = record.sessions[person]
    if (
      record.signers[person].attemptId !== attemptId ||
      !saved ||
      record.signers[person].phase !== 'awaiting_wallet'
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
        operation: saved.operation,
        requestHash: saved.requestHash,
        bindingPreimage: status.bindingPreimage,
        status: status.status,
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