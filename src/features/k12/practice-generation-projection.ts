import type { MistakePracticeGenerationState } from '@/api/k12'

export interface MistakePracticeProjection {
  kind: 'action' | 'pending' | 'joined' | 'hidden' | 'unavailable'
  label: string
  action?: 'join' | 'retry'
}

export function projectMistakePracticeGeneration(
  state: MistakePracticeGenerationState | undefined,
): MistakePracticeProjection {
  switch (state) {
    case 'pending':
      return { kind: 'pending', label: '已加入 · 正在出题…' }
    case 'joined':
      return { kind: 'joined', label: '✓ 已加入练习集' }
    case 'failed':
      return { kind: 'action', action: 'retry', label: '出题失败 · 重试' }
    case 're_add':
      return { kind: 'action', action: 'join', label: '再次加入练习集' }
    case 'hidden':
      return { kind: 'hidden', label: '' }
    case 'unknown':
      return { kind: 'unavailable', label: '' }
    case 'available':
    default:
      return { kind: 'action', action: 'join', label: '加入练习集' }
  }
}
