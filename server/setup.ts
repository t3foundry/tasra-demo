import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { hexToBytes } from '@t3foundry/tasra-sdk'
import { createFileStore } from '@t3foundry/tasra-sdk/app/node'
import { deployment, verifierAgentUrl, tasra, networkIdentity, assertSameNetwork, type NetworkIdentity } from './config'
import { stateDirectory, atomicSave, lockDirectory } from './store'
import { toHex, type Hex } from '../shared/model'

export type Setup = {
  schema: 'tasra-document-setup/v2'
  network: NetworkIdentity
  creatorKey: Hex
  issuerSeed: Hex
}

export function loadSetup(): Setup {
  const state = JSON.parse(readFileSync(join(stateDirectory, 'setup.json'), 'utf8')) as Setup
  if (state.schema !== 'tasra-document-setup/v2')
    throw new Error('Older setup state requires reconciliation. Preserve it; use a fresh TASRA_SIGN_DATA directory for this tutorial.')
  assertSameNetwork(state.network)
  return state
}

/** A 0x-prefixed 32-byte private key / identity seed, supplied via env as hex. */
const hexSeedRe = /^0x[0-9a-fA-F]{64}$/
function envSeed(name: string): Hex | undefined {
  const value = process.env[name]?.trim()
  if (!value) return undefined
  if (!hexSeedRe.test(value))
    throw new Error(`${name} must be a 0x-prefixed 64-hex-char private key`)
  return value as Hex
}

const unlock = lockDirectory()
try {
  if (!(await tasra.check()).ready)
    throw new Error('Network registries unavailable; check the downloaded manifest')
  const health = await fetch(verifierAgentUrl + '/health', { signal: AbortSignal.timeout(10000) })
  if (!health.ok) throw new Error('Verifier unavailable')

  // Resolve the creator key and issuer seed. Environment variables take precedence so a
  // previously-funded account (and its issuer identity) can be injected at deployment time;
  // otherwise fresh keys are generated and saved. Note: keys are NEVER generated/overwritten
  // when the env vars are present, so re-running is idempotent on the funded account.
  const file = join(stateDirectory, 'setup.json')
  const envCreatorKey = envSeed('TASRA_CREATOR_KEY')
  const envIssuerSeed = envSeed('TASRA_ISSUER_SEED')

  const newIdentitySeed = () => {
    const identity = tasra.identities.create()
    try {
      return toHex(identity.exportPrivateKey())
    } finally {
      identity.destroy()
    }
  }

  const state: Setup = (() => {
    if (envCreatorKey && envIssuerSeed) {
      return {
        schema: 'tasra-document-setup/v2',
        network: networkIdentity,
        creatorKey: envCreatorKey,
        issuerSeed: envIssuerSeed,
      }
    }
    if (existsSync(file))
      return loadSetup()
    return {
      schema: 'tasra-document-setup/v2',
      network: networkIdentity,
      creatorKey: envCreatorKey ?? tasra.wallets.create().exportPrivateKey(),
      issuerSeed: envIssuerSeed ?? newIdentitySeed(),
    }
  })()
  const save = () => atomicSave(file, state)
  save()
  const store = createFileStore(join(stateDirectory, 'sdk'))
  const creator = tasra.wallets.create({ privateKey: state.creatorKey })
  await store.save('creator-key', creator.exportPrivateKey())
  await store.save('network-pin', networkIdentity.manifestSha256)
  console.log(`Creator: ${creator.address} on chain ${deployment.chainId}.`)
  if ((await tasra.chain.client.getBalance({ address: creator.address })) < 5n * 10n ** 16n) {
    throw new Error('Fund this address with at least 0.05 AVAX using the official Fuji C-Chain faucet or your wallet, then rerun npm run setup. Saved creator state will be reused.')
  }

  // Derive the issuer DID so it can be persisted alongside the identity seed.
  const issuer = tasra.identities.create({ seed: hexToBytes(state.issuerSeed) })
  try {
    // Application records remain separate from the SDK's durable operation journals.
    // Slots, signers and encryption keys are no longer created here: they are created
    // and funded on demand through the running app (POST /api/signers, /api/encryption/keys),
    // each reusing the same funded creator account and issuer identity persisted below.
    const serviceFile = join(stateDirectory, 'service.json')
    const existing = existsSync(serviceFile)
      ? (JSON.parse(readFileSync(serviceFile, 'utf8')) as { senderToken?: string })
      : undefined
    atomicSave(serviceFile, {
      network: networkIdentity,
      creatorKey: state.creatorKey,
      slots: {},
      senderToken: process.env.TASRA_SENDER_TOKEN?.trim() || existing?.senderToken || randomBytes(32).toString('hex'),
      holderKeys: {},
    })
    atomicSave(join(stateDirectory, 'public.json'), {
      deployment,
      verifierAgentUrl,
      issuerDid: issuer.did,
      slots: {},
    })
  } finally {
    issuer.destroy()
  }
  console.log(
    'Setup complete. The funded creator account and issuer identity are saved. Create signer and encryption key slots through the running app.',
  )
} finally {
  unlock()
}
