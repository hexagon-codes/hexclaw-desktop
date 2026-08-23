import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

test('周练打印清单记录当前 native-dialog 路径', () => {
  const source = read('tests/e2e/branch-ui-fidelity-manifest.ts')
  const start = source.indexOf("id: 'k12.weekly-native-print'")
  const end = source.indexOf("id: 'k12.mistakes-list'", start)
  assert.ok(start >= 0 && end > start, 'missing k12.weekly-native-print manifest entry')

  const entry = source.slice(start, end)
  assert.match(entry, /statusReason:\s*[\s\S]*?native-dialog/)
  assert.doesNotMatch(entry, /still routes[\s\S]*?K12PrintPreviewModal/)
})

test('原生打印证据只登记安全系统边界并明确禁止实体出纸', () => {
  const source = read('tests/native/bug-20260802-014-macos-print.mjs')
  const start = source.indexOf('const evidence = {')
  const end = source.indexOf("writeFileSync(join(evidenceRoot, 'report.json')", start)
  assert.ok(start >= 0 && end > start, 'missing native print evidence report')

  const report = source.slice(start, end)
  assert.match(report, /status:\s*'PASS'/)
  assert.match(
    report,
    /acceptance:\s*\['DESKTOP-BOUNDARY-PRINT-003',\s*'DESKTOP-BOUNDARY-PRINT-005'\]/,
  )
  assert.doesNotMatch(report, /LIVE-PRINT-LA-001/)
  assert.doesNotMatch(report, /PASS_WITH_PHYSICAL_SUCCESS_GATE_PENDING/)
  assert.match(report, /physicalPrinterOutput:\s*'OUT_OF_SCOPE\/FORBIDDEN'/)
  assert.match(report, /remainingBoundary:\s*'NONE_WITHIN_APPROVED_SCOPE'/)
  assert.doesNotMatch(report, /physical printer output remains intentionally unexecuted/)
  assert.doesNotMatch(report, /require explicit user authorization/)
})
