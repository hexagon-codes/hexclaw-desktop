<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  Bell,
  ShieldAlert,
  CalendarClock,
  Cpu,
  Brain,
  MessageSquare,
  Wifi,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  CheckCheck,
  Trash2,
  ChevronRight,
  X,
} from 'lucide-vue-next'
import { useNotificationsStore } from '@/stores/notifications'
import { formatRelative } from '@/utils/time'
import type { HcNotification, NotificationKind, NotificationLevel } from '@/types/ui'

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const store = useNotificationsStore()

const items = computed(() => store.items)

/** 按天分组（保持各组内 newest-first 顺序），空组自动剔除。 */
const groups = computed(() => {
  const now = new Date()
  const isToday = (ts: number) => {
    const d = new Date(ts)
    return d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate()
  }
  const today: HcNotification[] = []
  const earlier: HcNotification[] = []
  for (const n of items.value) (isToday(n.timestamp) ? today : earlier).push(n)
  return [
    { key: 'today', label: t('notifications.groupToday'), items: today },
    { key: 'earlier', label: t('notifications.groupEarlier'), items: earlier },
  ].filter((g) => g.items.length > 0)
})

const kindIcon: Record<NotificationKind, typeof Bell> = {
  approval: ShieldAlert,
  task: CalendarClock,
  automation: CalendarClock,
  engine: Cpu,
  memory: Brain,
  channel: MessageSquare,
  system: Wifi,
}

const levelIcon: Record<NotificationLevel, typeof Bell> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

function iconFor(n: HcNotification) {
  return kindIcon[n.kind] ?? levelIcon[n.level] ?? Bell
}

function relTime(ts: number): string {
  return formatRelative(new Date(ts).toISOString(), Date.now())
}

function absTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function onItemClick(n: HcNotification) {
  store.markRead(n.id)
  if (n.route) {
    router.push(n.route).catch(() => {})
    emit('close')
  }
}

function onDismiss(n: HcNotification, e: Event) {
  e.stopPropagation()
  store.remove(n.id)
}

function markAllRead() {
  store.markAllRead()
}

// 清空是破坏性动作 —— 两步确认（首点进入确认态，再点才清空）。
const confirmingClear = ref(false)
function onClearClick() {
  if (!confirmingClear.value) {
    confirmingClear.value = true
    return
  }
  store.clearAll()
  confirmingClear.value = false
}
function cancelClear() {
  confirmingClear.value = false
}
</script>

<template>
  <Teleport to="body">
    <div class="hc-notifpanel__backdrop" @click="emit('close')" />
    <section
      class="hc-notifpanel"
      role="dialog"
      :aria-label="t('notifications.title')"
      data-testid="notif-panel"
    >
      <header class="hc-notifpanel__head">
        <span class="hc-notifpanel__title">{{ t('notifications.title') }}</span>
        <div class="hc-notifpanel__actions">
          <button
            class="hc-notifpanel__act"
            :disabled="!store.hasUnread"
            :title="t('notifications.markAllRead')"
            data-testid="notif-mark-all"
            @click="markAllRead"
          >
            <CheckCheck :size="15" />
          </button>
          <!-- 清空：两步确认 -->
          <button
            v-if="!confirmingClear"
            class="hc-notifpanel__act"
            :disabled="items.length === 0"
            :title="t('notifications.clearAll')"
            data-testid="notif-clear-all"
            @click="onClearClick"
          >
            <Trash2 :size="15" />
          </button>
          <button
            v-else
            class="hc-notifpanel__act hc-notifpanel__act--danger"
            data-testid="notif-clear-confirm"
            @click="onClearClick"
            @mouseleave="cancelClear"
          >
            {{ t('notifications.clearConfirm') }}
          </button>
          <button
            class="hc-notifpanel__act"
            :title="t('common.close')"
            data-testid="notif-close"
            @click="emit('close')"
          >
            <X :size="15" />
          </button>
        </div>
      </header>

      <div v-if="items.length === 0" class="hc-notifpanel__empty" data-testid="notif-empty">
        <Bell :size="40" :stroke-width="1.5" />
        <p>{{ t('notifications.empty') }}</p>
      </div>

      <div v-else class="hc-notifpanel__scroll">
        <template v-for="g in groups" :key="g.key">
          <div class="hc-notifpanel__group" data-testid="notif-group">{{ g.label }}</div>
          <ul class="hc-notifpanel__list">
            <li
              v-for="n in g.items"
              :key="n.id"
              class="hc-notifpanel__item"
              :class="{
                'hc-notifpanel__item--unread': !n.read,
                'hc-notifpanel__item--link': !!n.route,
              }"
              data-testid="notif-item"
              @click="onItemClick(n)"
            >
              <span
                class="hc-notifpanel__iconwrap"
                :class="`hc-notifpanel__iconwrap--${n.level}`"
              >
                <component :is="iconFor(n)" :size="15" />
              </span>
              <div class="hc-notifpanel__body">
                <div class="hc-notifpanel__row">
                  <span class="hc-notifpanel__itemtitle">{{ n.title }}</span>
                  <span class="hc-notifpanel__time" :title="absTime(n.timestamp)">{{ relTime(n.timestamp) }}</span>
                </div>
                <p v-if="n.body" class="hc-notifpanel__text">{{ n.body }}</p>
              </div>
              <!-- 右侧动作槽：可深链项默认显示 ›（点击会跳转的暗示），hover 时换成 ✕ 删除 -->
              <span class="hc-notifpanel__slot">
                <ChevronRight v-if="n.route" :size="14" class="hc-notifpanel__chevron" />
                <button
                  class="hc-notifpanel__dismiss"
                  :aria-label="t('common.delete')"
                  @click="onDismiss(n, $event)"
                >
                  <X :size="13" />
                </button>
              </span>
            </li>
          </ul>
        </template>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.hc-notifpanel__backdrop {
  position: fixed;
  inset: 0;
  z-index: calc(var(--hc-z-toast) - 1);
  background: transparent;
}

.hc-notifpanel {
  position: fixed;
  top: calc(var(--hc-titlebar-height) + var(--hc-space-2));
  right: var(--hc-space-3);
  z-index: var(--hc-z-toast);
  width: 380px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - var(--hc-titlebar-height) - 32px);
  display: flex;
  flex-direction: column;
  border-radius: var(--hc-radius-lg, 12px);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-lg);
  backdrop-filter: saturate(180%) blur(var(--hc-blur));
  -webkit-backdrop-filter: saturate(180%) blur(var(--hc-blur));
  overflow: hidden;
}

.hc-notifpanel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--hc-space-3) var(--hc-space-4);
  border-bottom: 1px solid var(--hc-border-subtle);
  flex-shrink: 0;
}

.hc-notifpanel__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
}

.hc-notifpanel__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.hc-notifpanel__act {
  padding: 4px;
  height: 24px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: background 0.15s, color 0.15s;
}

.hc-notifpanel__act:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}

.hc-notifpanel__act:disabled {
  opacity: 0.4;
  cursor: default;
}

.hc-notifpanel__act--danger {
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 12%, transparent);
}

.hc-notifpanel__act--danger:hover {
  background: color-mix(in srgb, var(--hc-error) 20%, transparent);
  color: var(--hc-error);
}

.hc-notifpanel__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--hc-space-3);
  padding: 56px 24px;
  color: var(--hc-text-muted);
}

.hc-notifpanel__empty p {
  font-size: 13px;
  margin: 0;
}

.hc-notifpanel__scroll {
  overflow-y: auto;
  padding: 4px;
}

.hc-notifpanel__group {
  padding: 8px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-text-muted);
  text-transform: none;
  letter-spacing: 0.02em;
}

.hc-notifpanel__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.hc-notifpanel__item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--hc-space-3);
  padding: 10px;
  border-radius: var(--hc-radius-md);
  transition: background 0.15s;
}

.hc-notifpanel__item--link {
  cursor: pointer;
}

.hc-notifpanel__item--unread {
  background: color-mix(in srgb, var(--hc-accent) 6%, transparent);
}

.hc-notifpanel__item:hover {
  background: var(--hc-bg-hover);
}

.hc-notifpanel__iconwrap {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 默认 info：中性强调 */
  color: var(--hc-accent);
  background: color-mix(in srgb, var(--hc-accent) 14%, transparent);
}

.hc-notifpanel__iconwrap--success {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 14%, transparent);
}

.hc-notifpanel__iconwrap--warning {
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 14%, transparent);
}

.hc-notifpanel__iconwrap--error {
  color: var(--hc-error);
  background: color-mix(in srgb, var(--hc-error) 14%, transparent);
}

.hc-notifpanel__body {
  flex: 1;
  min-width: 0;
}

.hc-notifpanel__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--hc-space-2);
}

.hc-notifpanel__itemtitle {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hc-notifpanel__item--unread .hc-notifpanel__itemtitle {
  font-weight: 600;
}

.hc-notifpanel__time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--hc-text-muted);
}

.hc-notifpanel__text {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--hc-text-secondary);
  word-break: break-word;
}

.hc-notifpanel__slot {
  flex-shrink: 0;
  width: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: center;
}

.hc-notifpanel__chevron {
  color: var(--hc-text-muted);
  opacity: 0.55;
}

.hc-notifpanel__item:hover .hc-notifpanel__chevron {
  display: none;
}

.hc-notifpanel__dismiss {
  display: none;
  padding: 3px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  transition: background 0.15s;
}

.hc-notifpanel__item:hover .hc-notifpanel__dismiss {
  display: flex;
}

.hc-notifpanel__dismiss:hover {
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}
</style>
