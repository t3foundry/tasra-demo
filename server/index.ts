import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app'
import { loadService } from './backend'
import { lockDirectory, stateDirectory } from './store'

// Load local secrets from the git-ignored `.env` file when present.
const envPath = join(import.meta.dirname, '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const port = Number(process.env.PORT ?? 4177)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid PORT')
// Bind to loopback by default for local use; containers set HOST=0.0.0.0.
const host = process.env.HOST ?? '127.0.0.1'
const origin = `http://${host}:${port}`

// Run the tutorial setup first (npm run setup). The start URL requires service.json.
if (!existsSync(join(stateDirectory, 'service.json'))) {
  console.error('No service.json found. Run "npm run setup" first.')
  process.exit(1)
}

const config = loadService()
const unlock = lockDirectory()
const app = createApp()

let stopped = false
function stop() {
  if (stopped) return
  stopped = true
  server.close(() => {
    unlock()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

const server = serve({ fetch: app.fetch, port, hostname: host }, () =>
  console.log(`Sender console (private): ${origin}/#sender=${config.senderToken}`),
)
console.log(`Tasra Sign server listening on ${origin}`)
console.log('Web: use "npm run dev:web" (Vite dev server) or open a built bundle from "npm run build:web".')