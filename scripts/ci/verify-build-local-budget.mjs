// 装机性能门禁：执行 make build-local 并校验增量预算。
// 首次（无基线）只记录耗时不 fail；后续增量构建超过 BUDGET_MS 即 fail，
// 防止构建机制变更再次造成装机性能无声回归（BUG-20260816-001，用户批准 2026-08-16）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const BUDGET_MS = 300_000 // 增量装机预算：5 分钟
const statePath = join(homedir(), '.cache', 'hexclaw-package', 'build-local-last-duration.json')

function previousBaseline() {
  try {
    const value = JSON.parse(readFileSync(statePath, 'utf8'))
    if (Number.isSafeInteger(value?.durationMs) && value.durationMs > 0) {
      return value.durationMs
    }
  } catch {
    // 无基线（首次装机）不视为失败
  }
  return null
}

const baseline = previousBaseline()
const startedAt = Date.now()
let status
try {
  status = execFileSync('make', ['build-local'], { stdio: 'inherit' })
} catch {
  process.exitCode = 1
  console.error('BUILD-LOCAL FAILED: make build-local exited non-zero')
  process.exit(process.exitCode ?? 1)
}
const durationMs = Date.now() - startedAt
mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
writeFileSync(
  statePath,
  `${JSON.stringify({ durationMs, at: new Date().toISOString() })}\n`,
  { mode: 0o600 },
)
const seconds = Math.round(durationMs / 1_000)
if (baseline !== null && durationMs > BUDGET_MS) {
  console.error(
    `BUILD-LOCAL BUDGET VIOLATION: ${seconds}s > ${BUDGET_MS / 1_000}s incremental budget ` +
      `(previous incremental baseline ${Math.round(baseline / 1_000)}s)`,
  )
  process.exitCode = 1
} else {
  const mode = baseline === null ? 'first build (baseline recorded)' : 'incremental'
  console.log(`build-local ok: ${seconds}s (${mode}, budget ${BUDGET_MS / 1_000}s)`)
}
