// 装机结果级指纹跳过（P10 优化批 2）：源码五仓与关键构建输入未变时，
// 跳过整个 build-local 编译，直接复用已有 App 产物——装机从分钟级降到秒级。
// 指纹 = desktop 与四 Go 仓的 git HEAD + 工作树状态 + 关键构建输入文件哈希。
// 命中且产物有效（App/Sidecar 存在、版本匹配）才可复用；任何漂移 fail-safe 走全量。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readlinkSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 路径由脚本位置推导（scripts/ci/ 上两级 = desktop 根），不硬编码宿主用户名。
const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK_ROOT = resolve(DESKTOP_ROOT, '..')
const REPOS = ['hexclaw-desktop', 'hexclaw', 'ai-core', 'hexagon', 'toolkit']
const STATE_PATH = join(homedir(), '.cache', 'hexclaw-package', 'build-local-fingerprint.json')
const APP_BUNDLE = join(
  DESKTOP_ROOT,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'macos',
  'HexClaw.app',
)
const SIDECAR = join(DESKTOP_ROOT, 'src-tauri', 'binaries', 'hexclaw-x86_64-apple-darwin')
const INPUT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.package-local.conf.json',
]

function gitOutput(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  })
}

function nulPaths(root, args) {
  return gitOutput(root, [...args, '-z'])
    .split('\0')
    .filter(Boolean)
    .sort()
}

function pathContentDigest(root, paths) {
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(path)
    hash.update('\0')
    try {
      const stat = lstatSync(join(root, path))
      hash.update(`${stat.mode & 0o7777}:`)
      if (stat.isSymbolicLink()) {
        hash.update('symlink:')
        hash.update(readlinkSync(join(root, path)))
      } else if (stat.isFile()) {
        hash.update('file:')
        hash.update(gitOutput(root, ['hash-object', '--no-filters', '--', path]))
      } else {
        hash.update(`special:${stat.size}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      hash.update('missing')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

function repoFingerprint(name) {
  const root = name === 'hexclaw-desktop' ? DESKTOP_ROOT : join(WORK_ROOT, name)
  const head = gitOutput(root, ['rev-parse', 'HEAD']).trim()
  const status = gitOutput(root, ['status', '--porcelain'])
  const staged = createHash('sha256')
    .update(
      gitOutput(root, ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z'], null),
    )
    .digest('hex')
  const unstaged = pathContentDigest(root, nulPaths(root, ['diff', '--name-only', '--no-renames']))
  const untracked = pathContentDigest(
    root,
    nulPaths(root, ['ls-files', '--others', '--exclude-standard']),
  )
  return `${name}:${head}:${status}:${staged}:${unstaged}:${untracked}`
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

function productValid(fingerprint) {
  try {
    const appPath = join(APP_BUNDLE, 'Contents', 'MacOS', 'hexclaw-desktop')
    const app = lstatSync(appPath)
    const sidecar = lstatSync(SIDECAR)
    if (!app.isFile() || !sidecar.isFile()) return false
    // 产物新鲜度强门禁（BUG-20260816-007 防回归）：dist 内容指纹必须等于当前源码指纹，
    // 且 App 二进制构建时间必须晚于该 manifest 写入（tauri-build 已嵌入该版本 dist）。
    const manifest = JSON.parse(
      readFileSync(join(DESKTOP_ROOT, 'dist', 'build-manifest.json'), 'utf8'),
    )
    if (manifest?.fingerprint !== fingerprint) return false
    return app.mtimeMs >= lstatSync(join(DESKTOP_ROOT, 'dist', 'build-manifest.json')).mtimeMs
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
const writeManifest = process.argv.includes('--write-manifest')
if (writeManifest) {
  // 在 pnpm build 后、tauri build 前写入 dist 内容指纹；tauri-build 将其嵌入二进制，
  // 装机复用时以二进制内嵌指纹校验产物新鲜度（BUG-20260816-007 防回归）。
  mkdirSync(join(homedir(), '.cache', 'hexclaw-package'), { recursive: true, mode: 0o700 })
  const manifest = JSON.stringify({ fingerprint, builtAt: new Date().toISOString() })
  writeFileSync(join(DESKTOP_ROOT, 'dist', 'build-manifest.json'), `${manifest}\n`, { mode: 0o600 })
  console.log('dist build-manifest written')
  process.exit(0)
}
if (previous() === fingerprint && productValid(fingerprint)) {
  console.log('build-local fingerprint hit: sources unchanged, reusing existing app bundle')
  process.exit(0)
}
console.log('build-local fingerprint miss: sources changed, full build required')
mkdirSync(join(homedir(), '.cache', 'hexclaw-package'), { recursive: true, mode: 0o700 })
writeFileSync(STATE_PATH, `${JSON.stringify({ fingerprint, at: new Date().toISOString() })}\n`, {
  mode: 0o600,
})
process.exit(2)
