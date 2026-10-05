/** Explicit purchases and usage deposits for a saved tutorial creator. */
import { TasraClient } from 'tasra-sdk/app'
import { createFileStore } from 'tasra-sdk/app/node'
import { bondingCurveAbi, createTasraWriteClient } from 'tasra-sdk/chain'
import { loadNetwork } from './network'

// Amounts are positive integer base units: EURC has 6 decimals; TSRA has 18.
const args = process.argv.slice(2)
const slotFlag = args.indexOf('--slot')
const explicitSlot = slotFlag < 0 ? undefined : args.splice(slotFlag, 2)[1]
if (slotFlag >= 0 && !explicitSlot) throw new Error('--slot requires a full slot ID')
const [directory, action = 'status', amountText, minimumText] = args
if (!directory || !['status', 'buy', 'fund', 'mint-test-eurc'].includes(action) || args.length > 4) {
  throw new Error('Usage: npm run fund-slot -- <state-directory> status|buy|fund|mint-test-eurc [amount] [minimum-TSRA-for-buy] [--slot 0x...]')
}
function positive(value: string | undefined, label: string): bigint {
  if (!value || !/^[1-9][0-9]*$/.test(value) || value.length > 78) throw new Error(label + ' must be positive integer base units')
  const amount = BigInt(value)
  if (amount >= 2n ** 256n) throw new Error(label + ' exceeds uint256')
  return amount
}
const amount = action === 'status' ? undefined : positive(amountText, 'Amount')
const minimum = action === 'buy' ? positive(minimumText, 'Minimum TSRA output') : undefined
if ((action === 'status' && (amountText || minimumText)) || (action !== 'buy' && minimumText)) throw new Error('Unexpected amount argument')

// Restore the same account and verified manifest; never generate a replacement key.
const network = loadNetwork()
const tasra = new TasraClient({ manifest: network.deployment })
const store = createFileStore(directory)
const pin = await store.load<string>('network-pin')
if (!pin || pin !== network.deployment.provenance?.manifestSha256) throw new Error('State does not match this downloaded network manifest')
const privateKey = await store.load<`0x${string}`>('creator-key')
if (!privateKey) throw new Error('Saved creator key missing; run the tutorial setup first')
const creator = tasra.wallets.create({ privateKey })
// The release manifest may omit the EURC token. Read it from the pinned curve.
const curve = tasra.deployment.addresses.BondingCurve
if (!curve) throw new Error('Network manifest has no BondingCurve')
const eurc = await tasra.chain.client.readContract({ address: curve, abi: bondingCurveAbi, functionName: 'eurc' })
if (tasra.deployment.addresses.MockEurc && tasra.deployment.addresses.MockEurc.toLowerCase() !== eurc.toLowerCase()) {
  throw new Error('Manifest EURC address does not match BondingCurve')
}
const writer = createTasraWriteClient({
  ...tasra.deployment,
  addresses: { ...tasra.deployment.addresses, MockEurc: eurc },
  wallet: creator.wallet,
})
const slotId = explicitSlot ?? (await store.load<string>('slot-id'))
if (!slotId || !/^0x[0-9a-fA-F]{64}$/.test(slotId)) throw new Error('Saved slot missing; use the slot ID printed by the tutorial with --slot')
const slot = slotId as `0x${string}`
await tasra.slots.get(slot) // Settlement accepts arbitrary IDs, so validate before depositing.

async function status() {
  console.log('Creator:', creator.address, 'Chain:', tasra.deployment.chainId)
  console.log('AVAX (wei):', (await writer.ethBalance()).toString())
  console.log('EURC (base units):', (await writer.eurcBalance(creator.address)).toString())
  console.log('Wallet TSRA (base units):', (await writer.tsraBalance()).toString())
  console.log('Slot:', slot, 'TSRA credit (base units):', (await writer.settlementBalance(slot)).toString())
}
await status()
if (action !== 'status') {
  // A repeated explicit command spends again. Never retry an uncertain outcome blindly.
  await store.withLock('funding', async () => {
    console.log('Submitting:', action, amount!.toString())
    if (action === 'mint-test-eurc') {
      console.log('Mint confirmed:', await writer.mintMockEurc(creator.address, amount!))
    } else if (action === 'buy') {
      console.log('EURC approval confirmed:', await writer.approveEurcForCurve(amount!))
      console.log('Purchase confirmed:', await writer.buyTsra(amount!, minimum!))
    } else {
      const receipt = await writer.fundSlot(slot, amount!)
      console.log('TSRA approval confirmed:', receipt.approveTx)
      console.log('Slot funding confirmed:', receipt.fundTx)
    }
  })
  await status()
}