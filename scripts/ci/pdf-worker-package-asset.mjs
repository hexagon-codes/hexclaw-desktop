import { readFile } from 'node:fs/promises'

const PDF_WORKER_PATH_SUFFIX = '/pdfjs-dist/legacy/build/pdf.worker.mjs'
const SYNTHETIC_HOME = /\bHOME:\s*"\/home\/web_user"/gu
const SYNTHETIC_HOME_VALUE = '/home/web_user'

export function rewritePDFWorkerSyntheticHome(source) {
  if (typeof source !== 'string') {
    throw new TypeError('PDF worker source must be a string')
  }
  const matches = [...source.matchAll(SYNTHETIC_HOME)]
  if (matches.length !== 1) {
    throw new Error('PDF worker synthetic home contract changed')
  }
  // Worker 与压缩解码器只在属性空白上不同，替换唯一属性值并保留其它字节。
  const first = matches[0].index + matches[0][0].indexOf(SYNTHETIC_HOME_VALUE)
  return `${source.slice(0, first)}/${source.slice(first + SYNTHETIC_HOME_VALUE.length)}`
}

export function createPDFWorkerPackageAssetPlugin() {
  return {
    name: 'hexclaw-pdf-worker-package-asset',
    apply: 'build',
    enforce: 'pre',
    async load(id) {
      if (typeof id !== 'string') return null
      const queryIndex = id.indexOf('?')
      if (queryIndex < 0) return null
      const queries = new Set(id.slice(queryIndex + 1).split('&'))
      const pathname = id.slice(0, queryIndex)
      if (!queries.has('url') || !pathname.replaceAll('\\', '/').endsWith(PDF_WORKER_PATH_SUFFIX)) {
        return null
      }

      // PDF.js 的 OpenJPEG Worker 使用固定的 Emscripten 虚拟 HOME；发布资产统一改为已存在的虚拟根目录。
      const source = rewritePDFWorkerSyntheticHome(await readFile(pathname, 'utf8'))
      const reference = this.emitFile({ type: 'asset', name: 'pdf.worker.mjs', source })
      return `export default import.meta.ROLLUP_FILE_URL_${reference};\n`
    },
  }
}
