import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const sourceRoot = process.env.HEXCLAW_SOURCE_ROOT || resolve(scriptsDir, '../../hexclaw')
const source = JSON.parse(await readFile(resolve(sourceRoot, 'engine/product_facts.json'), 'utf8'))

// 与Go公开投影使用相同筛选和键序；只同步静态公开事实。
function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    if (value.visibility === 'internal') return undefined
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      if (key.startsWith('_') || ['visibility', 'facts_digest', 'source_digest'].includes(key)) return []
      const child = publicValue(value[key])
      return child === undefined ? [] : [[key, child]]
    }))
  }
  return value
}

function canonical(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

const payload = publicValue(source)
if (!payload || payload.product_id !== 'hexclaw') throw new Error('Invalid product facts identity')
const factsDigest = `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`
const output = JSON.stringify({ ...payload, facts_digest: factsDigest }, null, 2) + '\n'
const destination = resolve(scriptsDir, '../src/generated/product-facts.json')
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw new Error('Product facts projection is out of date')
} else {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, output)
}
