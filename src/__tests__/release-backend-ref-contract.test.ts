import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRoot = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')
const readPackageVersion = () => {
  const manifest = JSON.parse(readRoot('package.json')) as { version: string }
  return manifest.version
}

describe('release · desktop/backend 版本锁步', () => {
  it('桌面默认构建与发布版本匹配的 backend sidecar', () => {
    const version = readPackageVersion()
    const backendRef = readRoot('Makefile').match(/^HEXCLAW_REF\s*\?=\s*(\S+)\s*$/m)?.[1]
    expect(backendRef).toBe(`refs/tags/v${version}`)
  })

  it('release 校验脚本会校验 HEXCLAW_REF，防止桌面版本升级而 sidecar 倒退', () => {
    const source = readRoot('scripts/ci/verify-release.mjs')
    expect(source).toContain("readFile(new URL('../../Makefile', import.meta.url)")
    expect(source).toContain('HEXCLAW_REF')
    expect(source).toContain('refs/tags/v${version}')
  })
})
