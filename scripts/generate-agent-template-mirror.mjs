import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const values = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--check') values.set(key, true)
  else if (key === '--source' || key === '--output') values.set(key, process.argv[++i])
  else throw new Error(`Unknown argument: ${key}`)
}
if (!values.get('--source') || !values.get('--output')) throw new Error('--source and --output are required')
const source = resolve(values.get('--source')), output = resolve(values.get('--output'))
const input = await readFile(source, 'utf8'), catalog = JSON.parse(input)
if (catalog.schema_version !== 1 || typeof catalog.catalog_version !== 'string' || !Array.isArray(catalog.templates)) throw new Error('Unsupported template catalog')
const keys = new Set()
for (const template of catalog.templates) {
  if (!template.template_key || !template.template_version || !template.slug || keys.has(template.template_key)) throw new Error('Invalid template identity')
  keys.add(template.template_key)
  for (const locale of ['zh-CN', 'en', 'ug-CN']) {
    const value = template.locales?.[locale]
    if (!value?.name || !value.description || !value.system_prompt || !Array.isArray(value.expertise)) throw new Error(`Missing locale: ${locale}`)
  }
}
// 数组顺序是已有模板货架顺序；只规范对象键，不改人设、语言或控件映射。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const sourceDigest = createHash('sha256').update(JSON.stringify(canonical(catalog))).digest('hex')
for (const template of catalog.templates) {
  for (const [locale, value] of Object.entries(template.locales)) {
    const snapshot = { catalog_version: catalog.catalog_version, template_key: template.template_key, template_version: template.template_version, locale, slug: template.slug, icon_key: template.icon_key, ...value }
    value.template_digest = createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex')
  }
}
const generated = JSON.stringify({ ...catalog, source_catalog_sha256: sourceDigest, generator_version: 1 }, null, 2) + '\n'
if (values.get('--check')) {
  if (await readFile(output, 'utf8') !== generated) throw new Error('Agent template mirror differs from its source')
  console.log(`Agent template mirror verified: ${keys.size} templates`)
} else {
  await mkdir(dirname(output), { recursive: true })
  const temporary = output + '.pending-' + process.pid
  try { await writeFile(temporary, generated); await rename(temporary, output) } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  console.log(`Agent template mirror generated: ${keys.size} templates`)
}
