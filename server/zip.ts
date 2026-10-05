import { inflateRawSync } from 'node:zlib'

// Minimal ZIP writer/reader for the signing bundle. Entries are stored
// uncompressed (method 0) so the already-compressed PDF is not re-compressed.

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[i] = c >>> 0
}

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  }
}

export function createZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  const { time, date } = dosTime()
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const size = data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(date, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(size, 20)
    entry.writeUInt32LE(size, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    entry.writeUInt32LE(0, 38)
    entry.writeUInt32LE(offset, 42)

    chunks.push(local, nameBuf, Buffer.from(data))
    central.push(entry, nameBuf)
    offset += local.length + nameBuf.length + size
  }

  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, cd, eocd])
}

function findEocd(buf: Buffer): Buffer {
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.subarray(i, i + 22)
  }
  throw new Error('Not a zip file')
}

export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf)
  const total = eocd.readUInt16LE(10)
  const cdOffset = eocd.readUInt32LE(16)
  const out = new Map<string, Buffer>()
  let p = cdOffset
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error('Corrupt zip central directory')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    const lnameLen = buf.readUInt16LE(localOffset + 26)
    const lextraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lnameLen + lextraLen
    const compressed = buf.subarray(dataStart, dataStart + compSize)

    let data: Buffer
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed)
    else throw new Error('Unsupported zip compression method')

    if (data.length !== uncompSize) throw new Error('Zip entry size differs')
    if (crc32(data) !== crc) throw new Error('Zip entry checksum differs')
    out.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}