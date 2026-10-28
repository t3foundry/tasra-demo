import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyFrostSignature, hexToBytes } from '@t3foundry/tasra-sdk'
import {
  openVerifierAgentSession,
  awaitVerifierAgentResult,
  VerifierAgentSessionError,
  type OpenedVerifierAgentSession,
  type Jwk,
} from '@t3foundry/tasra-sdk/oid4vp'
import { chain, deployment, tasra, verifierAgentUrl, assertSameNetwork, type NetworkIdentity } from './config'
import { stateDirectory } from './store'
import { statement, toHex, type Hex, type Person, type Proof, type Manifest } from '../shared/model'
import type { SigningBackend, SessionRecord } from './workflow'

export type ServiceConfig = {
  network: NetworkIdentity
  creatorKey: Hex
  slots: Record<Person, Hex>
  holderKeys: Record<Person, Jwk>
  senderToken: string
}

export function loadService(): ServiceConfig {
  const service = JSON.parse(
    readFileSync(join(stateDirectory, 'service.json'), 'utf8'),
  ) as ServiceConfig
  assertSameNetwork(service.network)
  return service
}

export function restoreSession(saved: SessionRecord): OpenedVerifierAgentSession {
  return {
    ...saved,
    verifierAgentUrl,
    requestHash: hexToBytes(saved.requestHash),
  } as OpenedVerifierAgentSession
}

export async function readKey(id: Hex) {
  if ((await chain.client.getChainId()) !== deployment.chainId)
    throw new Error('RPC chain differs from deployment')
  const key = await chain.readers.keyRegistry.getKeySlot(id)
  if (!key.exists) throw new Error('Signer slot does not exist')
  return {
    publicKey: key.publicKey,
    epoch: Number(key.epoch),
    mode: Number(key.mode),
    cancelled: key.cancelled,
  }
}

export function liveBackend(config: ServiceConfig): SigningBackend {
  assertSameNetwork(config.network)
  const creator = tasra.wallets.create({ privateKey: config.creatorKey })
  const name = (manifest: Manifest, slotId: Hex) =>
    manifest.signers.find(
      (s) => s.slotId.toLowerCase() === slotId.toLowerCase(),
    )?.name
  const verify = async (manifest: Manifest, proof: Proof) => {
    if (
      !manifest.signers.some(
        (s) => s.slotId.toLowerCase() === proof.slotId.toLowerCase(),
      )
    )
      throw new Error('Unassigned signer')
    const key = await readKey(proof.slotId)
    if (
      key.cancelled ||
      key.mode !== 0 ||
      key.publicKey !== proof.publicKey ||
      key.epoch !== proof.epoch ||
      !verifyFrostSignature(hexToBytes(key.publicKey), statement(manifest), {
        r: hexToBytes(proof.r),
        z: hexToBytes(proof.z),
      })
    )
      throw new Error('Signature verification failed')
  }
  return {
    async open(manifest, slotId) {
      const session = await openVerifierAgentSession({
        chainId: deployment.chainId,
        keyRegistry: deployment.addresses.KeyRegistry!,
        slotId,
        action: 'sign',
        message: statement(manifest),
        description: `${name(manifest, slotId) ?? slotId}: sign ${manifest.title}, version ${manifest.version}`,
        verifierAgentUrl,
        signer: creator.signer,
      })
      return {
        sessionId: session.sessionId,
        pollSecret: session.pollSecret,
        requestUri: session.requestUri,
        qrPayload: session.qrPayload,
        operation: { ...session.operation },
        requestHash: toHex(session.requestHash),
      }
    },
    async sign(manifest, slotId, saved, beforeSubmit) {
      let grant
      try {
        grant = await awaitVerifierAgentResult(restoreSession(saved), {
          timeoutMs: 45000,
          intervalMs: 500,
        })
      } catch (e) {
        if (e instanceof VerifierAgentSessionError && e.kind === 'refused') {
          const denied = new Error('Credential refused')
          denied.name = 'AuthorizationRefused'
          throw denied
        }
        throw e
      }
      if (!grant.verifierProofs?.length)
        throw new Error('Missing verifier membership proofs')
      const handle = await tasra.slots.frost(slotId)
      beforeSubmit()
      const signed = await handle.sign(statement(manifest), {
        requireReceipt: true,
        signal: AbortSignal.timeout(120000),
        authorize: async () => ({
          token: grant.token,
          verifierProofs: grant.verifierProofs!,
        }),
      })
      return {
        name: name(manifest, slotId),
        slotId,
        publicKey: toHex(signed.groupPublicKey),
        epoch: signed.epoch,
        r: toHex(signed.signature.r),
        z: toHex(signed.signature.z),
        receiptStatus: 'verified',
      }
    },
    verify,
  }
}
