import {store, tasra} from './learning-context.ts'

// Save fresh keys before the first network write; later runs reuse them.
await store.withLock('lesson', async () => {
  const creator = tasra.wallets.create({privateKey: await store.load<`0x${string}`>('creator-key')})
  await store.save('creator-key', creator.exportPrivateKey())
  console.log('Creator address:', creator.address)
  if (await tasra.chain.client.getBalance({address: creator.address}) === 0n) {
    console.log('Fund this creator address with AVAX on the selected network, then run again.')
    return
  }

  const issuer = tasra.identities.create({seed: await store.load<Uint8Array>('issuer-key')})
  await store.save('issuer-key', issuer.exportPrivateKey())
  const policy = tasra.credentials.policy({issuer, type: 'urn:my-app:member'})

  // One named signing slot, ready for later document-signing lessons.
  const slot = await tasra.slots.create({
    name: 'first-document-signer', mode: 'frost', policy,
    threshold: {k: 2, n: 3}, verifiers: {committee: 3, quorum: 2},
  }, {wallet: creator, onProgress: ({step, phase}) => console.log('Slot creation:', step, phase)})
  await store.save('slot-id', slot.slotId)
  console.log('Slot ready:', slot.slotId)
  console.log('Before signing: buy TSRA with EURC and fund this slot. Follow node_modules/tasra-sdk/docs/funding.md.')
})
