import {savedCreator, store, tasra} from './learning-context.js'

// Restore the issuer whose rule was committed when this slot was created.
const issuerKey = await store.load<Uint8Array>('issuer-key')
if (!issuerKey) throw new Error('Complete the create-slot lesson first')
const issuer = tasra.identities.create({seed: issuerKey})
const alice = await store.withLock('alice', async () => {
  const identity = tasra.identities.create({seed: await store.load<Uint8Array>('alice-key')})
  await store.save('alice-key', identity.exportPrivateKey())
  return identity
})
const credential = tasra.credentials.issue({
  issuer, holder: alice, type: 'urn:my-app:member', claims: {name: 'Alice'},
})
const creator = await savedCreator()
if (!tasra.verifierAgentUrl) throw new Error('The network manifest must advertise a verifier agent')

// Prepare the callback; credentials are presented only when an operation calls it.
export const authorize = tasra.credentials.authorize({
  verifierAgentUrl: tasra.verifierAgentUrl, signer: creator.signer,
  identity: alice, credentials: [credential],
})
console.log('Alice has a membership credential ready for the signing lesson.')
