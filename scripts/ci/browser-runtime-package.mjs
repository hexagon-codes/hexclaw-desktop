#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { runBoundedProcess } from './run-bounded-process.mjs'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE_ROOT = join(DESKTOP_ROOT, 'scripts', 'browser-runtime')
const NODE_VERSION = '22.23.4'
const MCP_VERSION = '0.0.84'
const PLAYWRIGHT_VERSION = '1.65.0-alpha-2026-10-30'
const CHROMIUM_VERSION = '157.0.8103.15'
const CHROMIUM_REVISION = '1252'
const INVENTORY_NAME = 'resources.json'
const GENERATED_NAMES = ['node', 'node_modules', 'chromium', 'package.json', 'package-lock.json', 'manifest.json', INVENTORY_NAME]
const IGNORED_ROOT_NAMES = new Set(['README.md', '.gitignore', INVENTORY_NAME])

// Node 摘要来自对应版本的官方 SHASUMS256.txt；浏览器摘要绑定官方 CDN 的固定归档。
// runtimeContentSHA256 由这些已核归档及 npm integrity 锁定的内容推导，独立于本轮 staging 清单。
const TARGETS = Object.freeze({
  'aarch64-apple-darwin': {
    platform: 'darwin', arch: 'arm64', nodePlatform: 'darwin-arm64',
    nodeSHA256: 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
    browserPlatform: 'mac-arm64', browserArchive: 'chrome-mac-arm64',
    browserSHA256: 'fde975f7813b7d4fd8a3db531bcdaffa458277e18f85aa3b1fc0e6d480eb35c4',
    runtimeContentSHA256: '021f60f6d618e35ac60ca9104c3a4218d3fce976896aa2609a5a6653b2db9bd0',
    browserExecutable: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  },
  'x86_64-apple-darwin': {
    platform: 'darwin', arch: 'amd64', nodePlatform: 'darwin-x64',
    nodeSHA256: 'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
    browserPlatform: 'mac-x64', browserArchive: 'chrome-mac-x64',
    browserSHA256: 'a4325f0edf30ed1ddbf79c8c183de6f9049ce79b3582c9fe22b7a59f482a3bc8',
    runtimeContentSHA256: 'db6a7e6fbf2efa0637568bb1ec6790e776115e17c6c79583d6fe023b4a2e8e13',
    browserExecutable: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  },
  'x86_64-unknown-linux-gnu': {
    platform: 'linux', arch: 'amd64', nodePlatform: 'linux-x64',
    nodeSHA256: 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
    browserPlatform: 'linux64', browserArchive: 'chrome-linux64',
    browserSHA256: 'ab9dd0ba103be79cc602962d8b21e285f26731a5115c1a759a0814da1346b54d',
    runtimeContentSHA256: '7c76e27832b3628e3392278a1680a06ab4f468a1018822b9fd9dbcff66f79bcc',
    browserExecutable: 'chrome-linux64/chrome',
  },
  'x86_64-pc-windows-msvc': {
    platform: 'windows', arch: 'amd64', nodePlatform: 'win-x64',
    nodeSHA256: 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
    browserPlatform: 'win64', browserArchive: 'chrome-win64',
    browserSHA256: '9b79d71060f08e8953e396a3f3c705105cca1c5862ec708f89bfa080fee78af6',
    runtimeContentSHA256: 'f86fb78bc5880f2f8fab67dd15ff581cb1bff0d9e654345abd332a280cb34129',
    browserExecutable: 'chrome-win64/chrome.exe',
  },
})

function fail(category) {
  throw new Error(`Browser runtime package failed: ${category}`)
}

async function digestFile(pathname, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest(encoding)
}

function checkedTarget(targetTriple) {
  const target = TARGETS[targetTriple]
  if (!target) fail('unsupported-target')
  if (!/^[a-f0-9]{64}$/u.test(target.browserSHA256)) fail('missing-browser-digest')
  return target
}

async function cachedArchive({ url, cacheRoot, name, algorithm = 'sha256', digest, encoding = 'hex' }) {
  await mkdir(cacheRoot, { recursive: true })
  const archive = join(cacheRoot, name)
  try {
    if (await digestFile(archive, algorithm, encoding) === digest) return archive
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporary = await mkdtemp(join(cacheRoot, '.download-'))
  const pending = join(temporary, name)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) })
    if (!response.ok || !response.body) fail(`download-${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(pending, { flags: 'wx' }))
    if (await digestFile(pending, algorithm, encoding) !== digest) fail('archive-digest')
    await rm(archive, { force: true })
    await rename(pending, archive)
    return archive
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function extractArchive(archive, destination, { strip = false } = {}) {
  await mkdir(destination, { recursive: true })
  const zip = archive.endsWith('.zip')
  let command
  let args
  if (process.platform === 'darwin' && zip) {
    // ditto 保留 Chromium Framework 的合法内部符号链接和可执行位。
    command = '/usr/bin/ditto'
    args = ['-x', '-k', archive, destination]
  } else if (process.platform === 'linux' && zip) {
    command = '/usr/bin/unzip'
    args = ['-q', archive, '-d', destination]
  } else {
    command = process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar'
    args = ['-xf', archive, '-C', destination, ...(strip ? ['--strip-components=1'] : [])]
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const env = process.platform === 'win32'
    ? { SystemRoot: systemRoot, PATH: join(systemRoot, 'System32'), TEMP: destination, TMP: destination }
    : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }
  const options = { cwd: destination, env, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 1024 * 1024 }
  if (process.platform === 'win32') {
    // 现有 bounded-process 仅支持 Unix；Windows 归档器为单个本机进程。
    await promisify(execFile)(command, args, { cwd: destination, env, windowsHide: true, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes })
  } else {
    await runBoundedProcess(command, args, options)
  }
}

async function readRuntimeLock(packageRoot) {
  const [packageBytes, lockBytes] = await Promise.all([
    readFile(join(packageRoot, 'package.json')),
    readFile(join(packageRoot, 'package-lock.json')),
  ])
  const pkg = JSON.parse(packageBytes)
  const lock = JSON.parse(lockBytes)
  const versions = { '@playwright/mcp': MCP_VERSION, playwright: PLAYWRIGHT_VERSION, 'playwright-core': PLAYWRIGHT_VERSION }
  if (pkg.dependencies?.['@playwright/mcp'] !== MCP_VERSION || lock.lockfileVersion !== 3 ||
      lock.packages?.['']?.dependencies?.['@playwright/mcp'] !== MCP_VERSION ||
      Object.keys(lock.packages).length !== 4) fail('runtime-lock')
  for (const [name, version] of Object.entries(versions)) {
    const entry = lock.packages[`node_modules/${name}`]
    if (entry?.version !== version || !/^sha512-[A-Za-z0-9+/]+=*$/u.test(entry.integrity ?? '') ||
        !entry.resolved?.startsWith('https://registry.npmjs.org/')) fail('runtime-lock')
  }
  return { packageBytes, lockBytes, lock }
}

async function runtimeInventory(root) {
  const entries = []
  async function visit(directory, prefix = '') {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      if (!prefix && IGNORED_ROOT_NAMES.has(name)) continue
      const pathname = join(directory, name)
      const nameInRoot = prefix ? `${prefix}/${name}` : name
      const stat = await lstat(pathname)
      if (stat.isSymbolicLink()) {
        const target = await readlink(pathname)
        const inRoot = relative(root, resolve(dirname(pathname), target))
        if (isAbsolute(inRoot) || inRoot === '..' || inRoot.startsWith(`..${sep}`)) fail('resource-link')
        entries.push({ path: nameInRoot, type: 'symlink', target })
      } else if (stat.isDirectory()) {
        entries.push({ path: nameInRoot, type: 'directory' })
        await visit(pathname, nameInRoot)
      } else if (stat.isFile()) {
        entries.push({ path: nameInRoot, type: 'file', size: stat.size, sha256: await digestFile(pathname), executable: process.platform !== 'win32' && (stat.mode & 0o111) !== 0 })
      } else {
        fail('resource-type')
      }
    }
  }
  await visit(root)
  return entries
}

function browserFrameworkLinks(target) {
  if (target.platform !== 'darwin') return []
  const framework = `chromium/${target.browserArchive}/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework`
  return [
    ['Google Chrome for Testing Framework', 'Versions/Current/Google Chrome for Testing Framework'],
    ['Helpers', 'Versions/Current/Helpers'],
    ['Libraries', 'Versions/Current/Libraries'],
    ['Resources', 'Versions/Current/Resources'],
    ['Versions/Current', CHROMIUM_VERSION],
  ].map(([path, linkTarget]) => ({ path: `${framework}/${path}`, type: 'symlink', target: linkTarget }))
}

function runtimeContentDigest(entries) {
  // generation 属于本次打包身份；官方资源内容摘要独立于代次和宿主权限表示。
  const canonical = entries.filter((entry) => entry.path !== 'manifest.json').map((entry) => {
    const content = { ...entry }
    delete content.executable
    return content
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** 核对完整资源字节；存在目录或 README 不代表运行时已就绪。 */
export async function verifyBrowserRuntime(root, { targetTriple, generation } = {}) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const target = targetTriple ? checkedTarget(targetTriple) : Object.values(TARGETS).find((entry) => entry.platform === manifest.platform && entry.arch === manifest.arch)
  if (!target || manifest.schema_version !== 1 || !manifest.generation ||
      (generation !== undefined && manifest.generation !== generation) ||
      manifest.platform !== target.platform || manifest.arch !== target.arch ||
      manifest.minimum_os_version !== (target.platform === 'darwin' ? '14.0' : '') ||
      manifest.node?.version !== NODE_VERSION || manifest.node.path !== (target.platform === 'windows' ? 'node/node.exe' : 'node/bin/node') ||
      manifest.mcp?.package !== '@playwright/mcp' || manifest.mcp.version !== MCP_VERSION || manifest.mcp.entry !== 'node_modules/@playwright/mcp/cli.js' ||
      manifest.playwright?.version !== PLAYWRIGHT_VERSION || manifest.playwright.browser_revision !== CHROMIUM_REVISION ||
      manifest.playwright.chromium_executable !== `chromium/${target.browserExecutable}`) fail('manifest-identity')
  const expected = JSON.parse(await readFile(join(root, INVENTORY_NAME), 'utf8'))
  const actual = await runtimeInventory(root)
  if (expected.schema_version !== 1 || JSON.stringify(expected.entries) !== JSON.stringify(actual)) fail('resource-identity')
  if (runtimeContentDigest(actual) !== target.runtimeContentSHA256) fail('official-resource-identity')
  if (JSON.stringify(actual.filter((entry) => entry.type === 'symlink')) !== JSON.stringify(browserFrameworkLinks(target))) fail('browser-link-identity')
  for (const path of [manifest.node.path, manifest.mcp.entry, manifest.playwright.chromium_executable]) {
    if (!actual.some((entry) => entry.path === path && entry.type === 'file' && entry.size > 0)) fail('resource-entrypoint')
  }
  if (target.platform !== 'windows' && process.platform !== 'win32') {
    for (const path of [manifest.node.path, manifest.playwright.chromium_executable]) {
      if (!actual.find((entry) => entry.path === path)?.executable) fail('resource-not-executable')
    }
  }
  return manifest
}

/** 返回已核完整资源清单中的官方 Framework 链接，不扩大到其它包目录。 */
export async function verifiedBrowserRuntimeLinks(root) {
  const manifest = await verifyBrowserRuntime(root)
  const target = Object.values(TARGETS).find((entry) => entry.platform === manifest.platform && entry.arch === manifest.arch)
  const canonicalRoot = await realpath(root)
  const links = new Map()
  for (const entry of browserFrameworkLinks(target)) {
    const pathname = resolve(root, entry.path)
    const destination = await realpath(pathname)
    const inRoot = relative(canonicalRoot, destination)
    if (isAbsolute(inRoot) || inRoot === '..' || inRoot.startsWith(`..${sep}`)) fail('resource-link')
    links.set(pathname, { target: entry.target, destination })
  }
  return links
}

/** 仅固定官方归档与 npm 锁文件共同绑定的资源可使用公开内容例外。 */
export async function verifiedBrowserRuntimeResources(root) {
  const manifest = await verifyBrowserRuntime(root)
  const target = Object.values(TARGETS).find((entry) => entry.platform === manifest.platform && entry.arch === manifest.arch)
  const { entries } = JSON.parse(await readFile(join(root, INVENTORY_NAME), 'utf8'))
  if (!target.runtimeContentSHA256 || runtimeContentDigest(entries) !== target.runtimeContentSHA256) fail('official-resource-identity')
  return new Map(entries.filter((entry) => entry.path !== 'manifest.json').map((entry) => [resolve(root, entry.path), entry]))
}

/** 比较源资源与包内资源，保留浏览器合法链接的身份。 */
export async function verifyPackagedBrowserRuntime(source, packaged) {
  const [sourceManifest, packagedManifest] = await Promise.all([verifyBrowserRuntime(source), verifyBrowserRuntime(packaged)])
  const [sourceInventory, packagedInventory] = await Promise.all([
    readFile(join(source, INVENTORY_NAME)), readFile(join(packaged, INVENTORY_NAME)),
  ])
  if (JSON.stringify(sourceManifest) !== JSON.stringify(packagedManifest) || !sourceInventory.equals(packagedInventory)) fail('packaged-resource-identity')
}

/** 按独立依赖锁组装目标平台运行包，不调用系统 npm/npx 或用户浏览器缓存。 */
export async function stageBrowserRuntime({ targetTriple, outputRoot, cacheRoot, generation, packageRoot = PACKAGE_ROOT }) {
  const target = checkedTarget(targetTriple)
  const { packageBytes, lockBytes, lock } = await readRuntimeLock(packageRoot)
  const minimumOSVersion = target.platform === 'darwin' ? '14.0' : ''
  const runtimeGeneration = generation ?? createHash('sha256').update(lockBytes).update(targetTriple).update(NODE_VERSION).update(target.browserSHA256).update(minimumOSVersion).digest('hex').slice(0, 32)
  const parent = dirname(resolve(outputRoot))
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(join(parent, '.browser-runtime-'))
  const downloads = join(resolve(cacheRoot), 'downloads')
  try {
    const nodeExtension = target.platform === 'windows' ? 'zip' : 'tar.gz'
    const nodeName = `node-v${NODE_VERSION}-${target.nodePlatform}`
    const nodeArchive = await cachedArchive({
      url: `https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.${nodeExtension}`,
      cacheRoot: downloads, name: `${nodeName}.${nodeExtension}`, digest: target.nodeSHA256,
    })
    const nodeExtract = join(stage, '.node-extract')
    await extractArchive(nodeArchive, nodeExtract)
    const nodePath = target.platform === 'windows' ? 'node/node.exe' : 'node/bin/node'
    await mkdir(dirname(join(stage, nodePath)), { recursive: true })
    await copyFile(join(nodeExtract, nodeName, target.platform === 'windows' ? 'node.exe' : 'bin/node'), join(stage, nodePath))
    await copyFile(join(nodeExtract, nodeName, 'LICENSE'), join(stage, 'node', 'LICENSE'))
    if (target.platform !== 'windows') await chmod(join(stage, nodePath), 0o755)
    await rm(nodeExtract, { recursive: true })

    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue
      const archive = await cachedArchive({
        url: entry.resolved, cacheRoot: downloads,
        name: `npm-${path.slice('node_modules/'.length).replaceAll('/', '-')}-${entry.version}.tgz`,
        algorithm: 'sha512', encoding: 'base64', digest: entry.integrity.slice('sha512-'.length),
      })
      await extractArchive(archive, join(stage, path), { strip: true })
    }
    const browserSpec = JSON.parse(await readFile(join(stage, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')).browsers.find((entry) => entry.name === 'chromium')
    if (browserSpec?.revision !== CHROMIUM_REVISION || browserSpec.browserVersion !== CHROMIUM_VERSION) fail('browser-version')
    const browserArchive = await cachedArchive({
      url: `https://cdn.playwright.dev/builds/cft/${CHROMIUM_VERSION}/${target.browserPlatform}/${target.browserArchive}.zip`,
      cacheRoot: downloads, name: `${CHROMIUM_VERSION}-${target.browserArchive}.zip`, digest: target.browserSHA256,
    })
    await extractArchive(browserArchive, join(stage, 'chromium'))
    await writeFile(join(stage, 'package.json'), packageBytes)
    await writeFile(join(stage, 'package-lock.json'), lockBytes)
    const manifest = {
      schema_version: 1, platform: target.platform, arch: target.arch, generation: runtimeGeneration,
      minimum_os_version: minimumOSVersion,
      node: { version: NODE_VERSION, path: nodePath },
      mcp: { package: '@playwright/mcp', version: MCP_VERSION, entry: 'node_modules/@playwright/mcp/cli.js' },
      playwright: { version: PLAYWRIGHT_VERSION, browser_revision: CHROMIUM_REVISION, chromium_executable: `chromium/${target.browserExecutable}` },
    }
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(stage, INVENTORY_NAME), `${JSON.stringify({ schema_version: 1, entries: await runtimeInventory(stage) }, null, 2)}\n`)
    await verifyBrowserRuntime(stage, { targetTriple, generation: runtimeGeneration })
    await mkdir(outputRoot, { recursive: true })
    // 仅替换本模块生成的资源；README、ignore 和其它源码保持原样。
    await rm(join(outputRoot, 'manifest.json'), { force: true })
    for (const name of GENERATED_NAMES.filter((entry) => entry !== 'manifest.json')) {
      await rm(join(outputRoot, name), { recursive: true, force: true })
      await rename(join(stage, name), join(outputRoot, name))
    }
    await rename(join(stage, 'manifest.json'), join(outputRoot, 'manifest.json'))
    return await verifyBrowserRuntime(outputRoot, { targetTriple, generation: runtimeGeneration })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

function hostTarget() {
  const goarch = process.arch === 'x64' ? 'amd64' : process.arch
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  return Object.keys(TARGETS).find((key) => TARGETS[key].platform === platform && TARGETS[key].arch === goarch)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const separator = arg.indexOf('=')
    if (!arg.startsWith('--') || separator < 3) fail('arguments')
    return [arg.slice(2, separator), arg.slice(separator + 1)]
  }))
  const allowed = new Set(['target', 'output', 'cache', 'generation'])
  if (Object.keys(options).some((key) => !allowed.has(key))) fail('arguments')
  stageBrowserRuntime({
    targetTriple: options.target ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTarget(),
    outputRoot: resolve(options.output ?? join(DESKTOP_ROOT, 'src-tauri', 'browser-runtime')),
    cacheRoot: resolve(options.cache ?? join(homedir(), '.cache', 'hexclaw-package', 'browser-runtime')),
    generation: options.generation,
  }).then((manifest) => {
    process.stdout.write(`Browser runtime ready: ${manifest.platform}/${manifest.arch} generation=${manifest.generation}\n`)
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
