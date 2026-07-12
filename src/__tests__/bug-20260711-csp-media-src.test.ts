/**
 * BUG-20260711-D（复现→修复→锁定）：生成的视频在会话内不可播（禁播图标），下载后可播。
 *
 * 真机取证链（20260711）：
 *  - 会话消息 attachment src = http://localhost:16060/api/v1/files/generated/…mp4；
 *  - 后端 http.ServeContent：HEAD 200 + Accept-Ranges: bytes，Range: bytes=0-1 → 206，
 *    魔数 ftyp isom/avc1 合法——服务端完好；
 *  - tauri.conf.json CSP：media-src 'self' data: blob: https: ——**缺 http://localhost:16060**，
 *    <video> 被 CSP 拦截；img-src 放行了该 origin 所以图片/封面正常，connect-src 放行所以能下载。
 *
 * 回归锁契约：后端本地 origin 在 img-src 出现，就必须同时在 media-src 出现（视频/音频与图片
 * 同源同权），防止后续调 CSP 时再次漏掉媒体分支。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_ORIGIN = 'http://localhost:16060'

function cspDirectives(): Record<string, string[]> {
  const conf = JSON.parse(
    readFileSync(resolve(__dirname, '../../src-tauri/tauri.conf.json'), 'utf-8'),
  ) as { app?: { security?: { csp?: string } } }
  const csp = conf.app?.security?.csp ?? ''
  const out: Record<string, string[]> = {}
  for (const seg of csp.split(';')) {
    const parts = seg.trim().split(/\s+/)
    if (parts.length > 1) out[parts[0]!] = parts.slice(1)
  }
  return out
}

describe('BUG-20260711-D：CSP media-src 必须放行后端本地 origin（会话内视频/音频可播）', () => {
  it('★media-src 含 http://localhost:16060（生成视频 <video src> 即该 origin）', () => {
    const d = cspDirectives()
    expect(d['media-src'], 'CSP 必须声明 media-src').toBeTruthy()
    expect(d['media-src']).toContain(BACKEND_ORIGIN)
  })

  it('对称锁：img-src 放行的后端 origin，media-src 必须同权放行（图片能显示视频就必须能播）', () => {
    const d = cspDirectives()
    const imgBackendOrigins = (d['img-src'] ?? []).filter((s) => s.startsWith('http://localhost'))
    for (const origin of imgBackendOrigins) {
      expect(d['media-src'], `media-src 缺 ${origin}（img-src 已放行）`).toContain(origin)
    }
  })
})
