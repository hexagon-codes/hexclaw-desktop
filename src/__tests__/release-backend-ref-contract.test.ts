import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRoot = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')
const readPackageVersion = () => {
  const manifest = JSON.parse(readRoot('package.json')) as { version: string }
  return manifest.version
}

describe('release · desktop 版本与固定 backend 来源', () => {
  it('桌面默认构建使用固定的 backend 版本 tag', () => {
    const backendRef = readRoot('Makefile').match(/^HEXCLAW_REF\s*\?=\s*(\S+)\s*$/m)?.[1]
    expect(backendRef).toMatch(
      /^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    )
  })

  it('release 校验接受当前桌面版本及其独立固定 backend 来源', () => {
    const tag = `v${readPackageVersion()}`
    const result = spawnSync(process.execPath, [resolve('scripts/ci/verify-release.mjs'), tag], {
      encoding: 'utf8',
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Release metadata verified for ${tag}.`)
  })
})
