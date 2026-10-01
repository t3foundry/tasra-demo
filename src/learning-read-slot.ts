import {savedSlotId, tasra} from './learning-context.js'

const slotId = await savedSlotId()
const slot = await tasra.slots.get(slotId)
console.log('Slot:', slot.slotId)
console.log('Key ready:', slot.ready)
console.log('Key epoch:', slot.epoch)
console.log('Threshold:', slot.threshold)
