import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hexToBytes } from '@t3foundry/tasra-sdk'
import {
  issueSdJwtVc,
  verifyCompactJws,
  jwkFromDid,
  holderCnf,
  decodeJson,
} from '@t3foundry/tasra-sdk/oid4vp'
import { tasra } from './config'
import { readIssuerSeed } from './signers'
import { stateDirectory, atomicSave } from './store'

const PRE_AUTHORIZED_GRANT = 'urn:ietf:params:oauth:grant-type:pre-authorized_code'
const PROOF_TYP = 'openid4vci-proof+jwt'
const OFFER_TTL_MS = 30 * 60 * 1000 // offers expire ≤ 30 min (bounded by exp, §7)
const TOKEN_TTL_MS = 10 * 60 * 1000 // tokens ≤ 10 min
const IAT_WINDOW_BEFORE_MS = 300 * 1000
const IAT_WINDOW_AFTER_MS = 60 * 1000

type Exchange = {
  offerCode: string
  authCode: string
  credentialKind: 'DocumentSigner' | 'DocumentReader'
  name: string
  nonce?: string
  nonceIssuedAt: number
  tokenAt: number
  done: boolean
  expiresAt: number
}

type ExchangeState = { version: 1; exchanges: Exchange[]; tokens: Record<string, string> }

const exchangesFile = join(stateDirectory, 'vci-exchanges.json')

// Persisted exchange state so offers survive a server restart (e.g. `tsx watch`).
let exchanges = new Map<string, Exchange>() // keyed by offer code
let tokens = new Map<string, string>() // access_token -> offer code

function loadState() {
  if (!existsSync(exchangesFile)) return
  const data = JSON.parse(readFileSync(exchangesFile, 'utf8')) as ExchangeState
  if (data.version !== 1) return
  exchanges = new Map(data.exchanges.map((e) => [e.offerCode, e]))
  tokens = new Map(Object.entries(data.tokens ?? {}))
}
loadState()

function saveState() {
  purgeExpired()
  const state: ExchangeState = {
    version: 1,
    exchanges: [...exchanges.values()],
    tokens: Object.fromEntries(tokens),
  }
  atomicSave(exchangesFile, state)
}

function signerIssuer() {
  return tasra.identities.create({ seed: hexToBytes(readIssuerSeed()) })
}

export function issueForHolder(
  credentialKind: 'DocumentSigner' | 'DocumentReader',
  name: string,
  holderDid: string,
): string {
  const issuer = signerIssuer()
  try {
    if (credentialKind === 'DocumentReader') {
      return issueSdJwtVc({
        issuer: issuer.issuer,
        vct: 'DocumentReader',
        cnf: holderCnf({ did: holderDid }),
        claims: {
          key: name,
        },
        ttlSecs: 365 * 24 * 60 * 60,
      })
    }
    return issueSdJwtVc({
      issuer: issuer.issuer,
      vct: 'DocumentSigner',
      sub: 'did:demo:' + name,
      cnf: holderCnf({ did: holderDid }),
      claims: { role: 'document-signer' },
      ttlSecs: 365 * 24 * 60 * 60,
    })
  } finally {
    issuer.destroy()
  }
}

function purgeExpired() {
  const now = Date.now()
  for (const [code, ex] of exchanges) if (ex.expiresAt < now) exchanges.delete(code)
  for (const [token, code] of tokens)
    if (!exchanges.has(code)) tokens.delete(token)
}

export function createOffer(
  credentialKind: 'DocumentSigner' | 'DocumentReader',
  name: string,
  issuerBaseUrl: string,
): string {
  purgeExpired()
  const code = randomUUID().replaceAll('-', '')
  exchanges.set(code, {
    offerCode: code,
    authCode: randomUUID(),
    credentialKind,
    name,
    nonce: undefined,
    nonceIssuedAt: 0,
    tokenAt: 0,
    done: false,
    expiresAt: Date.now() + OFFER_TTL_MS,
  })
  saveState()
  const offerObject = {
    credential_issuer: issuerBaseUrl,
    credential_configuration_ids: [credentialKind],
    grants: {
      [PRE_AUTHORIZED_GRANT]: {
        'pre-authorized_code': code,
      },
    },
  }
  return (
    'openid-credential-offer://?credential_offer=' +
    encodeURIComponent(JSON.stringify(offerObject))
  )
}

export function issuerMetadata(issuerBaseUrl: string): Record<string, unknown> {
  return {
    credential_issuer: issuerBaseUrl,
    authorization_servers: [issuerBaseUrl],
    credential_endpoint: issuerBaseUrl + '/credential',
    token_endpoint: issuerBaseUrl + '/token',
    nonce_endpoint: issuerBaseUrl + '/nonce',
    credential_configurations_supported: {
      DocumentSigner: {
        format: 'dc+sd-jwt',
        vct: 'DocumentSigner',
        cryptographic_binding_methods_supported: ['did:jwk'],
        credential_signing_alg_values_supported: ['ES256'],
      },
      DocumentReader: {
        format: 'dc+sd-jwt',
        vct: 'DocumentReader',
        cryptographic_binding_methods_supported: ['did:jwk'],
        credential_signing_alg_values_supported: ['ES256'],
      },
    },
    proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256', 'EdDSA'] } },
  }
}

export function authorizationServerMetadata(
  tokenEndpoint: string,
): Record<string, unknown> {
  return {
    issuer: new URL(tokenEndpoint).origin,
    token_endpoint: tokenEndpoint,
    response_types_supported: ['token'],
    grant_types_supported: [PRE_AUTHORIZED_GRANT],
  }
}

function getExchangeByCode(code: string): Exchange {
  purgeExpired()
  const exchange = exchanges.get(code)
  if (!exchange) throw new Error('Unknown or expired credential offer')
  return exchange
}

function getExchangeByToken(token: string): Exchange | undefined {
  purgeExpired()
  const code = tokens.get(token)
  if (!code) return undefined
  return exchanges.get(code)
}

/** Redeem the pre-authorized code: single-use, returns an access token + one-time nonce. */
export function exchangeToken(code: string): {
  access_token: string
  c_nonce: string
  name: string
} {
  const exchange = getExchangeByCode(code)
  if (exchange.done) throw new Error('Credential offer already redeemed')
  const nonce = randomUUID()
  exchange.nonce = nonce
  exchange.nonceIssuedAt = Date.now()
  exchange.tokenAt = Date.now()
  const accessToken = 'tasra-' + randomUUID()
  tokens.set(accessToken, code)
  saveState()
  return { access_token: accessToken, c_nonce: nonce, name: exchange.name }
}

export function issueNonce(token: string): string {
  const exchange = getExchangeByToken(token)
  if (!exchange) throw new Error('Invalid or expired access token')
  const nonce = randomUUID()
  exchange.nonce = nonce
  exchange.nonceIssuedAt = Date.now()
  saveState()
  return nonce
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Verify the holder proof JWT against the exchange's one-time nonce and audience. */
export function verifyProofJwt(
  token: string,
  proof: string,
  expectedAud: string,
): { holderDid: string; credentialKind: 'DocumentSigner' | 'DocumentReader'; name: string } {
  const exchange = getExchangeByToken(token)
  if (!exchange) throw new Error('Invalid or expired access token')
  if (!exchange.nonce) throw new Error('Exchange has no live nonce')

  const headerPart = proof.split('.')[0]
  if (!headerPart) throw new Error('Malformed proof JWT')
  const header = decodeJson<Record<string, unknown>>(headerPart)

  if (header.typ !== PROOF_TYP) throw new Error('Not an OpenID4VCI proof')
  if (header.jwk !== undefined) throw new Error('Proof must not embed a holder key')
  const kid = header.kid
  if (typeof kid !== 'string') throw new Error('Proof carries no holder key identifier')
  // kid must be a bare did:jwk with a #0 fragment (§7); reject did:key and bare DIDs.
  if (!/^did:jwk:[A-Za-z0-9_-]+#0$/.test(kid))
    throw new Error('Proof kid must be a did:jwk holder with a #0 fragment')
  const holderDid = kid.slice(0, -2)
  const holderKey = jwkFromDid(holderDid)
  const expectedAlg = holderKey.crv === 'P-256' ? 'ES256' : 'EdDSA'

  const { header: verifiedHeader, payload } = verifyCompactJws<{
    aud?: string
    nonce?: string
    iat?: number
  }>(proof, holderKey)

  if (verifiedHeader.alg !== expectedAlg) throw new Error('Proof algorithm mismatch')
  if (payload.aud !== expectedAud) throw new Error('Proof audience mismatch')

  const now = Date.now()
  if (
    typeof payload.iat !== 'number' ||
    payload.iat * 1000 < now - IAT_WINDOW_BEFORE_MS ||
    payload.iat * 1000 > now + IAT_WINDOW_AFTER_MS
  )
    throw new Error('Proof issued at an invalid time')

  if (!payload.nonce || !constantTimeEqual(payload.nonce, exchange.nonce))
    throw new Error('Proof nonce differs from the exchange nonce')

  const name = exchange.name

  // Success burns the exchange + token: completed/expired exchanges 401 (§7, §13).
  exchange.done = true
  exchanges.delete(exchange.offerCode)
  tokens.delete(token)
  saveState()

  return { holderDid, credentialKind: exchange.credentialKind, name }
}
