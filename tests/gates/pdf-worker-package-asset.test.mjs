import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createPDFWorkerPackageAssetPlugin,
  rewritePDFWorkerSyntheticHome,
} from '../../scripts/ci/pdf-worker-package-asset.mjs'

const require = createRequire(import.meta.url)
const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')

test('PDF worker package asset removes the synthetic Linux home before content hashing', async () => {
  const source = await readFile(workerPath, 'utf8')
  const rewritten = rewritePDFWorkerSyntheticHome(source)

  assert.equal(source.match(/HOME: "\/home\/web_user"/gu)?.length, 1)
  assert.equal(rewritten.includes('/home/web_user'), false)
  assert.equal(rewritten.includes('HOME: "/"'), true)
})

test('PDF worker package asset fails closed when the upstream contract changes', () => {
  assert.throws(
    () => rewritePDFWorkerSyntheticHome('const worker = {}'),
    /PDF worker synthetic home contract changed/u,
  )
  assert.throws(
    () => rewritePDFWorkerSyntheticHome('HOME: "/home/web_user"; HOME: "/home/web_user"'),
    /PDF worker synthetic home contract changed/u,
  )
})

test('PDF worker package plugin emits only the rewritten pinned worker URL asset', async () => {
  const plugin = createPDFWorkerPackageAssetPlugin()
  const emitted = []

  assert.equal(plugin.apply, 'build')
  const result = await plugin.load.call(
    {
      emitFile(asset) {
        emitted.push(asset)
        return 'pdf-worker-reference'
      },
    },
    `${workerPath}?url`,
  )

  assert.equal(result, 'export default import.meta.ROLLUP_FILE_URL_pdf-worker-reference;\n')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'asset')
  assert.equal(emitted[0].name, 'pdf.worker.mjs')
  assert.equal(emitted[0].source.includes('/home/web_user'), false)
  assert.equal(await plugin.load.call({}, `${workerPath}?raw`), null)
})
