import {
  fetchRequestObject,
  defaultKeyResolver,
  derivedNonce,
  requestHash,
  planPresentation,
  buildResponse,
  submitResponse,
  signCompactJws,
} from 'tasra-sdk/oid4vp'
import { hexToBytes } from 'tasra-sdk'
import {
  createIdentity,
  verifyCredential,
  type TasraIdentity,
} from 'tasra-sdk/app'
import { digest, statement, toHex, type Manifest, type Person } from './model'

export type DemoWallet = {
  name: string
  identity: TasraIdentity
  credential: string
}

export function importWallet(text: string): DemoWallet {
  const value = JSON.parse(text) as {
    schema: string
    name: string
    seed: string
    credential: string
  }
  if (
    value.schema !== 'tasra-demo-wallet/v1' ||
    !['alice', 'bob', 'mallory'].includes(value.name) ||
    !/^0x[0-9a-f]{64}$/i.test(value.seed) ||
    typeof value.credential !== 'string'
  )
    throw new Error('Expected a generated demo wallet file')
  const identity = createIdentity({ seed: hexToBytes(value.seed) })
  try {
    verifyCredential(value.credential, {
      holder: identity,
      type: 'DocumentSigner',
      subject: 'did:demo:' + value.name,
    })
    return { name: value.name, identity, credential: value.credential }
  } catch (error) {
    identity.destroy()
    throw error
  }
}

export type PublicSession = {
  sessionId: string
  requestUri: string
  requestHash: `0x${string}`
  operation: Record<string, unknown>
  bindingPreimage: Record<string, unknown>
  status: string
}

export async function present(
  wallet: DemoWallet,
  manifest: Manifest,
  person: Person,
  session: PublicSession,
  verifierUrl: string,
  transport: typeof fetch,
) {
  const expected = manifest.signers.find((s) => s.name === person)!
  const message = statement(manifest)
  const hash = requestHash(
    manifest.chainId,
    hexToBytes(expected.slotId),
    'sign',
    hexToBytes(('0x' + (await digest(message))) as `0x${string}`),
  )
  const op = session.operation
  const binding = session.bindingPreimage
  if (
    session.requestHash !== toHex(hash) ||
    op.chain_id !== manifest.chainId ||
    op.slot_id !== expected.slotId ||
    op.action !== 'sign' ||
    op.payload_digest !== '0x' + (await digest(message)) ||
    !binding
  )
    throw new Error('Wallet request differs from reviewed document')
  const bound = binding.operation as Record<string, unknown>
  if (!bound || Object.entries(op).some(([k, v]) => bound[k] !== v))
    throw new Error('Creator operation binding differs')
  const ro = await fetchRequestObject(session.requestUri, {
    fetchImpl: transport,
    resolveKey: defaultKeyResolver({ fetchImpl: transport }),
  })
  const verifier = new URL(verifierUrl)
  const expectedDid = 'did:web:' + encodeURIComponent(verifier.host)
  if (
    ro.signerDid !== expectedDid ||
    ro.claims.client_id !== 'decentralized_identifier:' + expectedDid ||
    ro.claims.response_uri !==
      verifierUrl + '/v1/response?session=' + session.sessionId ||
    ro.claims.response_mode !== 'direct_post.jwt'
  )
    throw new Error('Unexpected wallet provider or callback')
  const integer = (key: string) => {
    const n = binding[key]
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      throw new Error('Invalid nonce context')
    return n
  }
  const hex = (key: string) => {
    const v = binding[key]
    if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/i.test(v))
      throw new Error('Invalid nonce hash')
    return hexToBytes(v as `0x${string}`)
  }
  if (
    typeof op.exp !== 'number' ||
    !Number.isSafeInteger(op.exp) ||
    op.exp < Date.now() / 1000
  )
    throw new Error('Operation expired')
  const nonce = derivedNonce(hash, hex('random'), {
    epoch: integer('epoch'),
    snapshotRoot: hex('snapshot_root'),
    registrySize: integer('registry_size'),
    committee: integer('committee_count'),
    quorum: integer('quorum'),
    operationExp: op.exp,
  })
  if (ro.claims.nonce !== nonce || binding.nonce !== nonce)
    throw new Error('Wallet nonce differs')
  if (ro.claims.exp === undefined || ro.claims.exp > op.exp)
    throw new Error('Request expiry differs')
  const plan = planPresentation(ro, [{ sdJwt: wallet.credential }])
  if (!plan.chosen) throw new Error('This wallet does not satisfy the signer rule')
  await submitResponse(
    ro,
    buildResponse({ ro, candidate: plan.chosen, holder: wallet.identity.holder }),
    transport,
  )
}

export function declineProof(
  wallet: DemoWallet,
  manifest: Manifest,
  person: Person,
) {
  return signCompactJws(
    { alg: 'EdDSA', typ: 'tasra-decline+jwt' },
    {
      aud: 'tasra-sign-decline/v1',
      requestId: manifest.requestId,
      documentSha256: manifest.documentSha256,
      person,
      exp: Math.floor(Date.now() / 1000) + 120,
    },
    wallet.identity.issuer.signer,
  )
}