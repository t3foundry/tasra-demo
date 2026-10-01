import {authorize} from './learning-authorize.js'
import {savedSlotId, tasra} from './learning-context.js'

const signer = await tasra.slots.frost(await savedSlotId())
const message = new TextEncoder().encode('I approve this first TASRA example.')
const result = await signer.sign(message, {authorize})
console.log('Signature verified:', result.signature)
console.log('Key epoch:', result.epoch)
