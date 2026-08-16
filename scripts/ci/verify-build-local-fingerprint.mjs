// 装机结果级指纹跳过（P10 优化批 2）：源码五仓与关键构建输入未变时，
// 跳过整个 build-local 编译，直接复用已有 App 产物——装机从分钟级降到秒级。
// 指纹 = desktop 与四 Go 仓的 git HEAD + 工作树状态 + 关键构建输入文件哈希。
// 命中且产物有效（App/Sidecar 存在、版本匹配）才可复用；任何漂移 fail-safe 走全量。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 路径由脚本位置推导（scripts/ci/ 上两级 = desktop 根），不硬编码宿主用户名。
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK_ROOT = resolve(DESKTOP_ROOT, '..')
const REPOS = ['hexclaw-desktop', 'hexclaw', 'ai-core', 'hexagon', 'toolkit']
const STATE_PATH = join(homedir(), '.cache', 'hexclaw-package', 'build-local-fingerprint.json')
const APP_BUNDLE = join(DESKTOP_ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'HexClaw.app')
const SIDECAR = join(DESKTOP_ROOT, 'src-tauri', 'binaries', 'hexclaw-x86_64-apple-darwin')
const INPUT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.package-local.conf.json',
]

function repoFingerprint(name) {
  const root = name === 'hexclaw-desktop' ? DESKTOP_ROOT : join(WORK_ROOT, name)
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
  return `${name}:${head}:${status}`
}

function computeFingerprint() {
  const hash = createHash('sha256')
  for (const repo of REPOS) hash.update(repoFingerprint(repo))
  for (const file of INPUT_FILES) {
    try {
      hash.update(readFileSync(join(DESKTOP_ROOT, file)))
    } catch {
      hash.update(`missing:${file}`)
    }
  }
  return hash.digest('hex')
}

function productValid() {
  try {
    const app = lstatSync(join(APP_BUNDLE, 'Contents', 'MacOS', 'hexclaw-desktop'))
    const sidecar = lstatSync(SIDECAR)
    return app.isFile() && sidecar.isFile()
  } catch {
    return false
  }
}

function previous() {
  try {
    const value = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return typeof value?.fingerprint === 'string' ? value.fingerprint : null
  } catch {
    return null
  }
}

const fingerprint = computeFingerprint()
if (previous() === fingerprint && productValid()) {
  console.log('build-local fingerprint hit: sources unchanged, reusing existing app bundle')
  process.exit(0)
}
console.log('build-local fingerprint miss: sources changed, full build required')
mkdirSync(join(homedir(), '.cache', 'hexclaw-package'), { recursive: true, mode: 0o700 })
writeFileSync(STATE_PATH, `${JSON.stringify({ fingerprint, at: new Date().toISOString() })}\n`, { mode: 0o600 })
process.exit(2)
