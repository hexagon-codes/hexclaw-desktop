/**
 * Ollama 下载状态显示 Bug 修复验证
 *
 * 复现场景：下载大模型完成后，校验/写入阶段仍显示"下载中 0KB"，
 * 且 status 显示英文技术术语如 "verifying sha256 digest"。
 *
 * 修复：
 * 1. mapPullStatus 将原始 status 映射为友好中文
 * 2. 校验/写入阶段清空速度详情，进度条设为 100%
 */
import { describe, it, expect } from 'vitest'

// ━━━ 提取被测逻辑为纯函数 ━━━

/** 修复前的 status 处理（直接透传） */
function mapPullStatusBefore(raw: string): string {
  return raw || ''
}

/** 修复后的 status 映射 */
function mapPullStatusAfter(raw: string): string {
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (lower.includes('pulling manifest')) return '获取模型信息...'
  if (lower.includes('downloading')) return '下载中...'
  if (lower.includes('verifying')) return '校验文件完整性...'
  if (lower.includes('writing')) return '写入模型文件...'
  if (lower === 'success') return '完成'
  return raw
}

/** 模拟进度回调的状态更新逻辑 */
interface PullState {
  status: string
  progress: number
  detail: string
}

function applyProgressBefore(state: PullState, p: { status: string; completed?: number; total?: number }): PullState {
  const newState = { ...state }
  newState.status = p.status || ''
  if (p.total && p.total > 0 && p.completed !== undefined) {
    newState.progress = Math.round((p.completed / p.total) * 100)
    newState.detail = `${(p.completed / 1e6).toFixed(1)} MB / ${(p.total / 1e6).toFixed(1)} MB`
  }
  if (p.status === 'success') {
    newState.progress = 100
    newState.detail = '完成'
  }
  return newState
}

function applyProgressAfter(state: PullState, p: { status: string; completed?: number; total?: number }): PullState {
  const newState = { ...state }
  newState.status = mapPullStatusAfter(p.status || '')
  const statusLower = (p.status || '').toLowerCase()
  if (statusLower.includes('verifying') || statusLower.includes('writing')) {
    newState.detail = ''
    newState.progress = 100
  }
  if (p.total && p.total > 0 && p.completed !== undefined) {
    newState.progress = Math.round((p.completed / p.total) * 100)
    newState.detail = `${(p.completed / 1e6).toFixed(1)} MB / ${(p.total / 1e6).toFixed(1)} MB`
  }
  if (p.status === 'success') {
    newState.progress = 100
    newState.detail = '完成'
  }
  return newState
}

// ━━━ 测试 ━━━

describe('修复前 vs 修复后：status 显示', () => {
  const ollamaStatuses = [
    'pulling manifest',
    'downloading sha256:abc123',
    'verifying sha256 digest',
    'writing manifest',
    'success',
  ]

  it('修复前：直接显示英文技术术语', () => {
    const results = ollamaStatuses.map(mapPullStatusBefore)
    expect(results).toEqual([
      'pulling manifest',
      'downloading sha256:abc123',
      'verifying sha256 digest',
      'writing manifest',
      'success',
    ])
  })

  it('修复后：显示友好中文', () => {
    const results = ollamaStatuses.map(mapPullStatusAfter)
    expect(results).toEqual([
      '获取模型信息...',
      '下载中...',
      '校验文件完整性...',
      '写入模型文件...',
      '完成',
    ])
  })
})

describe('修复前 vs 修复后：校验阶段的进度详情', () => {
  // 模拟下载完成后进入校验阶段
  const downloadedState: PullState = {
    status: '下载中...',
    progress: 99,
    detail: '8990.0 MB / 8990.0 MB · 0.0 MB/s',
  }

  it('修复前：校验阶段残留 "0 KB" 速度信息', () => {
    const state = applyProgressBefore(downloadedState, {
      status: 'verifying sha256 digest',
    })
    // BUG: status 变成英文，detail 没有清空（残留上次的下载速度）
    expect(state.status).toBe('verifying sha256 digest')
    expect(state.detail).toBe('8990.0 MB / 8990.0 MB · 0.0 MB/s') // 残留！
    expect(state.progress).toBe(99) // 没更新到 100
  })

  it('修复后：校验阶段清空详情，进度 100%', () => {
    const state = applyProgressAfter(downloadedState, {
      status: 'verifying sha256 digest',
    })
    expect(state.status).toBe('校验文件完整性...')
    expect(state.detail).toBe('') // 已清空
    expect(state.progress).toBe(100) // 更新到 100
  })

  it('修复后：写入阶段同样清空详情', () => {
    const state = applyProgressAfter(downloadedState, {
      status: 'writing manifest',
    })
    expect(state.status).toBe('写入模型文件...')
    expect(state.detail).toBe('')
    expect(state.progress).toBe(100)
  })
})

describe('边界情况', () => {
  it('空 status', () => {
    expect(mapPullStatusAfter('')).toBe('')
  })

  it('未知 status 原样返回', () => {
    expect(mapPullStatusAfter('some unknown phase')).toBe('some unknown phase')
  })

  it('下载阶段正常显示进度', () => {
    const state = applyProgressAfter(
      { status: '', progress: 0, detail: '' },
      { status: 'downloading sha256:abc', completed: 500_000_000, total: 9_000_000_000 },
    )
    expect(state.status).toBe('下载中...')
    expect(state.progress).toBe(6) // 500MB / 9GB ≈ 6%
    expect(state.detail).toContain('500.0 MB')
  })
})
