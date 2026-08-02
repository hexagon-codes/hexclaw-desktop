/** Toast 通知 */
export interface Toast {
  id: number
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  actionLabel?: string
  onAction?: () => void
}

/**
 * 通知中心：跨视图、异步事件的统一回执。
 * 与瞬时 Toast 互补 —— Toast 是「现在看一眼」，通知是「我不在时发生了什么」的持久台账。
 */
export type NotificationKind =
  | 'task'
  | 'channel'
  | 'automation'
  | 'engine'
  | 'memory'
  | 'approval'
  | 'system'

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface HcNotification {
  id: string
  kind: NotificationKind
  level: NotificationLevel
  /** 已解析后的标题文本（store 不持有 i18n 依赖，文案在 source 层解析） */
  title: string
  body?: string
  /** epoch 毫秒 */
  timestamp: number
  read: boolean
  /** 点击后深链到的路由 path */
  route?: string
  /** 去重/合并键：同 key 的已有项会被「刷新到顶 + 置未读 + 更新内容」，而非堆叠刷屏 */
  dedupeKey?: string
}

/** push 入参：id / timestamp / read 由 store 生成 */
export type NotificationInput = Omit<HcNotification, 'id' | 'timestamp' | 'read'>
