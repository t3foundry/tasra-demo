import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'web', 'public', 'pdf-assets')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(pdfjsDir, 'build', 'pdf.worker.mjs'), join(out, 'pdf.worker.mjs'))
for (const dir of ['cmaps', 'standard_fonts', 'wasm'])
  cpSync(join(pdfjsDir, dir), join(out, dir), { recursive: true })
console.log('Copied pdfjs-dist assets to web/public/pdf-assets')