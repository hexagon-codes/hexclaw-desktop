/**
 * BUG-20260718 · 组C-5 · documents.documentPreviewUrl 硬编码 localhost:16060
 *
 * §15 红灯：动态 sidecar 端口 / 远端 API base 下预览直链失效或串实例。
 * 修复：改用运行时 env.apiBase（本身即绝对 localhost 地址，端口随 sidecar 变化）。
 *
 * 关联门：PLATAPI-128、PLATROUTE-101、DEVICE-003
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/config/env', () => ({ env: { apiBase: 'http://localhost:23456' } }))
vi.mock('@/api/client', () => ({ apiPost: vi.fn() }))

import { documentPreviewUrl } from '@/api/documents'

describe('BUG-20260718 documentPreviewUrl 跟随运行时端口', () => {
  it('[bug] URL 端口跟随 env.apiBase（非硬编码 16060）', () => {
    expect(documentPreviewUrl('tok123')).toBe('http://localhost:23456/api/v1/documents/preview/tok123')
  })

  it('download=true 追加 ?dl=1', () => {
    expect(documentPreviewUrl('tok', true)).toBe('http://localhost:23456/api/v1/documents/preview/tok?dl=1')
  })
})
