import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })
for (const entry of await readdir('src')) {
  if (entry.endsWith('.js')) await cp(join('src', entry), join('lib', entry))
}
console.log('built lib from src')
