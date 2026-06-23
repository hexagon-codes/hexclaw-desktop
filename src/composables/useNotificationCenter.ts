import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { hexclawWS } from '@/api/websocket'
import { useNotificationsStore } from '@/stores/notifications'
import { useAppStore } from '@/stores/app'
import { sendOsNotification } from '@/utils/os-notification'
import type { NotificationKind, NotificationLevel } from '@/types/ui'

/** 后端 desktop.Service 的 source 标识 → 前端通知 kind（图标语义）。 */
function desktopKind(source: string): NotificationKind {
  switch (source) {
    case 'cron': return 'automation'
    case 'im': return 'channel'
    default: return 'system'
  }
}

/** source → 点击深链目标（无合适页面则不深链）。 */
function desktopRoute(source: string): string | undefined {
  switch (source) {
    case 'cron': return '/automation'
    case 'im': return '/chat'
    default: return undefined
  }
}

/** 后端 type 字符串收敛到合法 level，异常值兜底 info。 */
function normalizeLevel(level: string): NotificationLevel {
  return level === 'success' || level === 'warning' || level === 'error' ? level : 'info'
}

/**
 * 通知中心 source 适配层（bridge）。
 *
 * 把已有的全局事件源翻译成 store 通知。设计上只接「跨视图 / 需行动」的高信号事件，
 * 刻意不订阅会被当前视图原地处理的噪音（如聊天流逐字 chunk、行内报错），
 * 避免退化成 Docker 那种「没人看的铃铛」。
 *
 * 接入源（均为全局可得、低噪音）：
 *   1. 工具审批请求 —— Agent 阻塞等待，跨会话必须告知，失焦时叠加系统弹窗
 *   2. 后端自动记忆保存
 *   3. WebSocket 重连成功
 *   4. 引擎状态降级 / 恢复（消抖 starting 抖动，且仅在真降级后才报恢复）
 *
 * 任务完成由 TasksView 在手动触发终态时直接 push（定时自动完成需后端推送，列 P1）。
 *
 * 在 App 根组件挂载一次：start() 注册监听，stop() 清理。
 */
export function useNotificationCenter() {
  const { t } = useI18n()
  const notifications = useNotificationsStore()
  const appStore = useAppStore()

  const cleanups: Array<() => void> = []
  let started = false
  /** 仅在曾经「降级」后才允许报「恢复」，避免开机首连产生假恢复通知 */
  let engineWasDown = false

  function appHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden
  }

  function start() {
    if (started) return
    started = true

    // 1) 工具审批请求
    cleanups.push(
      hexclawWS.onApprovalRequest((req) => {
        const title = t('notifications.events.approvalTitle')
        const body = t('notifications.events.approvalBody', { tool: req.toolName || '?' })
        notifications.push({
          kind: 'approval',
          level: 'warning',
          title,
          body,
          route: '/chat',
          dedupeKey: `approval:${req.requestId}`,
        })
        if (appHidden()) void sendOsNotification(title, body)
      }),
    )

    // 2) 后端自动记忆保存
    cleanups.push(
      hexclawWS.onMemorySaved((content) => {
        notifications.push({
          kind: 'memory',
          level: 'info',
          title: t('notifications.events.memoryTitle'),
          body: content ? content.slice(0, 120) : undefined,
          route: '/knowledge/memory',
        })
      }),
    )

    // 3) WebSocket 重连成功
    cleanups.push(
      hexclawWS.onReconnect(() => {
        notifications.push({
          kind: 'system',
          level: 'success',
          title: t('notifications.events.reconnectedTitle'),
          dedupeKey: 'ws:reconnected',
        })
      }),
    )

    // 3.5) 后端 desktop.Service 推送（cron 任务完成/失败、IM 入站回执、heal 结果…）。
    // 文案由后端组装（含用户数据如任务名），前端只按 source 映射图标与深链。
    // 不在此再发 OS 通知 —— 后端 desktop.Service 自带 sendSystemNotification，避免重复。
    cleanups.push(
      hexclawWS.onDesktopNotification((n) => {
        notifications.push({
          kind: desktopKind(n.source),
          level: normalizeLevel(n.level),
          title: n.title || t('notifications.title'),
          body: n.body || undefined,
          route: desktopRoute(n.source),
          dedupeKey: n.id ? `desktop:${n.id}` : undefined,
        })
      }),
    )

    // 4) 引擎状态降级 / 恢复
    const stopEngineWatch = watch(
      () => appStore.sidecarStatus,
      (next, prev) => {
        if (next === prev) return
        if (next === 'stopped' && prev !== 'starting') {
          const title = t('notifications.events.engineStoppedTitle')
          const body = t('notifications.events.engineStoppedBody')
          engineWasDown = true
          notifications.push({
            kind: 'engine',
            level: 'warning',
            title,
            body,
            route: '/settings',
            dedupeKey: 'engine:status',
          })
          if (appHidden()) void sendOsNotification(title, body)
        } else if (next === 'running' && engineWasDown) {
          engineWasDown = false
          notifications.push({
            kind: 'engine',
            level: 'success',
            title: t('notifications.events.engineRecoveredTitle'),
            dedupeKey: 'engine:status',
          })
        }
      },
    )
    cleanups.push(stopEngineWatch)
  }

  function stop() {
    started = false
    engineWasDown = false
    while (cleanups.length) cleanups.pop()?.()
  }

  return { start, stop }
}
