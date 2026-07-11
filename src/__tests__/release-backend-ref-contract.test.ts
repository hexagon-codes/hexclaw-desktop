import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRoot = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

describe('release · desktop/backend 版本锁步', () => {
  it('v0.5.0 桌面默认构建 v0.5.0 backend sidecar', () => {
    expect(readRoot('Makefile')).toMatch(/^HEXCLAW_REF \?= refs\/tags\/v0\.5\.0$/m)
  })

  it('release 校验脚本会校验 HEXCLAW_REF，防止桌面版本升级而 sidecar 倒退', () => {
    const source = readRoot('scripts/ci/verify-release.mjs')
    expect(source).toContain("readFile(new URL('../../Makefile', import.meta.url)")
    expect(source).toContain('HEXCLAW_REF')
    expect(source).toContain('refs/tags/v${version}')
  })
})
