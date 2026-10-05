import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
  unlinkSync,
  readdirSync,
  rmdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const stateDirectory = resolve(
  process.env.TASRA_SIGN_DATA ?? join(import.meta.dirname, '.tasra'),
)

export function atomicSave(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  writeFileSync(
    temporary,
    JSON.stringify(
      value,
      (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ) + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  const fd = openSync(temporary, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  const dir = openSync(resolve(path, '..'), 'r')
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }
}

export class Store<T extends { manifest: { requestId: string } }> {
  readonly directory: string
  private queues = new Map<string, Promise<unknown>>()
  constructor(root = stateDirectory) {
    this.directory = join(root, 'requests')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
  }
  private file(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid request ID')
    return join(this.directory, id + '.json')
  }
  get(id: string): T {
    return JSON.parse(readFileSync(this.file(id), 'utf8')) as T
  }
  has(id: string) {
    return existsSync(this.file(id))
  }
  save(value: T) {
    atomicSave(this.file(value.manifest.requestId), value)
  }
  list(): T[] {
    return readdirSync(this.directory)
      .filter((n) => n.endsWith('.json'))
      .map((n) => this.get(n.slice(0, -5)))
  }
  async exclusive<R>(id: string, work: () => Promise<R> | R): Promise<R> {
    const before = this.queues.get(id) ?? Promise.resolve()
    const running = before.catch(() => {}).then(work)
    this.queues.set(id, running)
    try {
      return await running
    } finally {
      if (this.queues.get(id) === running) this.queues.delete(id)
    }
  }
}

// This tutorial runs one Node writer. A second process must never mutate the same store.
export function lockDirectory(root = stateDirectory) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = join(root, 'writer.lock')
  if (existsSync(dir)) {
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new Error('Invalid writer lock; inspect before recovering')
    try {
      process.kill(pid, 0)
      throw new Error('Another writer is active')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    }
    unlinkSync(join(dir, 'pid'))
    rmdirSync(dir)
  }
  mkdirSync(dir)
  writeFileSync(join(dir, 'pid'), String(process.pid), {
    mode: 0o600,
    flag: 'wx',
  })
  return () => {
    unlinkSync(join(dir, 'pid'))
    rmdirSync(dir)
  }
}