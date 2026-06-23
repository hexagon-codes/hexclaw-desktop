import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import type {
  DefineSetupStoreOptions,
  _ExtractActionsFromSetupStore,
  _ExtractGettersFromSetupStore,
  _ExtractStateFromSetupStore,
} from 'pinia'
import type { HcNotification, NotificationInput } from '@/types/ui'

/** 环形缓冲上限：超出后丢弃最旧的，避免 localStorage 无限增长 */
const MAX_ITEMS = 100

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // crypto 不可用 → 退化到时间戳 + 计数
  }
  return `n_${Date.now().toString(36)}_${(genId.counter++).toString(36)}`
}
genId.counter = 0

/**
 * 通知中心 store —— 纯 sink，单一数据源。
 *
 * 设计原则：
 *   - 不持有任何 WS / Tauri / i18n 依赖，只接收已解析好的通知（source 层负责翻译）。
 *   - dedupeKey 合并：同类重复事件（如引擎反复抖动）刷新同一行而非堆叠刷屏。
 *   - 持久化 read 状态：跨重启仍保留「我上次漏看的」未读，对齐「我不在时发生了什么」语义。
 */
const setup = () => {
  const items = ref<HcNotification[]>([])

  const unreadCount = computed(() =>
    items.value.reduce((n, it) => n + (it.read ? 0 : 1), 0),
  )
  const hasUnread = computed(() => unreadCount.value > 0)

  /**
   * 是否有「需要处理」的未读 —— 审批 / 警告 / 错误。
   * 用于角标分级配色：有紧急未读才标红（真正的「需你处理」），
   * 否则纯 info 未读用中性强调色，避免把铃铛长期染成红色警报。
   */
  const hasUrgentUnread = computed(() =>
    items.value.some(
      (it) => !it.read && (it.level === 'warning' || it.level === 'error' || it.kind === 'approval'),
    ),
  )

  /** 追加一条通知；命中 dedupeKey 时刷新已有行（置顶 + 未读 + 覆盖内容）。 */
  function push(input: NotificationInput): HcNotification {
    if (input.dedupeKey) {
      const existing = items.value.find((it) => it.dedupeKey === input.dedupeKey)
      if (existing) {
        const merged: HcNotification = {
          ...existing,
          ...input,
          id: existing.id,
          timestamp: Date.now(),
          read: false,
        }
        const next = items.value.filter((it) => it !== existing)
        next.unshift(merged)
        items.value = next
        return merged
      }
    }

    const created: HcNotification = {
      ...input,
      id: genId(),
      timestamp: Date.now(),
      read: false,
    }
    const next = [created, ...items.value]
    if (next.length > MAX_ITEMS) next.length = MAX_ITEMS
    items.value = next
    return created
  }

  function markRead(id: string) {
    const it = items.value.find((x) => x.id === id)
    if (it && !it.read) it.read = true
  }

  function markAllRead() {
    if (!hasUnread.value) return
    items.value = items.value.map((it) => (it.read ? it : { ...it, read: true }))
  }

  function remove(id: string) {
    items.value = items.value.filter((x) => x.id !== id)
  }

  function clearAll() {
    items.value = []
  }

  return {
    items,
    unreadCount,
    hasUnread,
    hasUrgentUnread,
    push,
    markRead,
    markAllRead,
    remove,
    clearAll,
  }
}

type NotificationsStoreSetup = ReturnType<typeof setup>
type NotificationsStoreOptions = DefineSetupStoreOptions<
  'notifications',
  _ExtractStateFromSetupStore<NotificationsStoreSetup>,
  _ExtractGettersFromSetupStore<NotificationsStoreSetup>,
  _ExtractActionsFromSetupStore<NotificationsStoreSetup>
>

export const useNotificationsStore = defineStore('notifications', setup, {
  persist: {
    pick: ['items'],
    version: 1,
  },
} as NotificationsStoreOptions)
