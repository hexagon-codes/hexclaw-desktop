<script setup lang="ts">
/**
 * CronJobConfirmCard — D3.3 可编辑确认卡 + D4.1 Persistent Widget。
 *
 * 入口契约：
 *   - chat 流里 assistant message metadata.conversation_actions[i].kind === 'create_task'
 *   - 本组件渲染该 action，提供 form 编辑 + tier badge + cron 预览 + 配额预警
 *
 * 设计要点：
 *   - emit('execute', editedPayload)  → 父组件去调 /api/v1/cronjob action=create
 *   - emit('dismiss')                 → 关闭卡片
 *   - emit('reparse', text)           → 父组件调 /api/v1/cron/parse 拿新 draft
 *   - 不直接调网络（解耦：保持纯展示组件）
 *
 * 配额来源：
 *   - props.quotaUsed / quotaLimit 由 TasksView 或父级注入
 *   - 留空时不显示预警
 */
import { computed, ref, watch } from 'vue'
import type { CreateTaskAction } from '@/utils/chat-automation'

const props = defineProps<{
  action: CreateTaskAction
  /** 来源层级 metadata.source_tier ('0' slash / '1' fast-path / '2' LLM / '3' guidance) */
  sourceTier?: string
  /** 配额信息（D1.3）；undefined 时不显示 */
  quotaUsed?: number
  quotaLimit?: number
}>()

const emit = defineEmits<{
  (e: 'execute', payload: CreateTaskAction['payload'] & { deliver?: string[] }): void
  (e: 'dismiss'): void
  (e: 'reparse', text: string): void
}>()

// 本地表单状态（不直接修改 props.action.payload）
const editing = ref(false)
const localName = ref(props.action.payload.name)
const localSchedule = ref(props.action.payload.schedule)
const localPrompt = ref(props.action.payload.prompt)
const localDeliver = ref<string[]>(['chat'])

// 同步 props 变更（父级 reparse 后回填新 draft）
watch(
  () => props.action.payload,
  (p) => {
    localName.value = p.name
    localSchedule.value = p.schedule
    localPrompt.value = p.prompt
  },
  { deep: true },
)

// Tier badge 文案
const tierBadge = computed(() => {
  switch (props.sourceTier) {
    case '0': return { label: '⌘ Slash', tone: 'tier-slash' }
    case '1': return { label: '⚡ 已识别', tone: 'tier-fast' }
    case '2': return { label: '🤖 AI 协助', tone: 'tier-llm' }
    case '3': return { label: '💬 待补全', tone: 'tier-guidance' }
    default:  return { label: '✦ 任务', tone: 'tier-default' }
  }
})

// cron 表达式 ↔ 中文描述 的简单预览映射（K12 家长一眼看懂）
const schedulePreview = computed(() => {
  const s = localSchedule.value.trim()
  if (!s) return ''
  // 已是中文描述的不重复翻译
  if (/[每日点分时]/.test(s)) return s
  // 常见 @ macro
  if (s === '@daily') return '每天 0:00'
  if (s === '@hourly') return '每小时整点'
  if (s === '@weekly') return '每周一 0:00'
  if (s === '@monthly') return '每月 1 号 0:00'
  // @every Nm/h/d
  const ev = /^@every\s+(\d+)(s|m|h|d)$/i.exec(s)
  if (ev && ev[1] && ev[2]) {
    const unit: Record<string, string> = { s: '秒', m: '分钟', h: '小时', d: '天' }
    return `每 ${ev[1]} ${unit[ev[2].toLowerCase()] || ''}`
  }
  // 五段 cron
  const five = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(s)
  if (five) {
    const m = five[1] ?? ''
    const h = five[2] ?? ''
    const dom = five[3] ?? ''
    const mon = five[4] ?? ''
    const dow = five[5] ?? ''
    if (dom === '*' && mon === '*' && dow === '*') {
      return `每天 ${pad(h)}:${pad(m)}`
    }
    if (dom === '*' && mon === '*' && dow !== '*') {
      const dayMap = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      const idx = Number(dow)
      if (!isNaN(idx) && idx >= 0 && idx <= 6) {
        return `每${dayMap[idx]} ${pad(h)}:${pad(m)}`
      }
    }
    return s // 复杂表达式直接显示原文
  }
  return s
})

function pad(s: string): string {
  if (/^\d$/.test(s)) return `0${s}`
  return s
}

// 配额预警（D1.3）
const quotaWarn = computed(() => {
  if (props.quotaUsed === undefined || props.quotaLimit === undefined) return null
  const remaining = props.quotaLimit - props.quotaUsed
  if (remaining <= 0) return { tone: 'block', text: `配额已满（${props.quotaUsed}/${props.quotaLimit}），请先删除旧任务` }
  if (remaining <= 3) return { tone: 'warn', text: `剩余 ${remaining} 个名额（${props.quotaUsed}/${props.quotaLimit}）` }
  return { tone: 'ok', text: `已用 ${props.quotaUsed}/${props.quotaLimit}` }
})

const canSubmit = computed(() => {
  return (
    localName.value.trim().length > 0 &&
    localSchedule.value.trim().length > 0 &&
    localPrompt.value.trim().length > 0 &&
    (quotaWarn.value?.tone !== 'block')
  )
})

function onSubmit() {
  if (!canSubmit.value) return
  emit('execute', {
    name: localName.value.trim(),
    schedule: localSchedule.value.trim(),
    prompt: localPrompt.value.trim(),
    deliver: localDeliver.value.slice(),
  })
}

function onReparse() {
  // 用 prompt 作为 reparse 文本（拼上 schedule 提示）
  const combined = `${localSchedule.value} ${localPrompt.value}`.trim()
  emit('reparse', combined)
}

function toggleDeliver(channel: string) {
  const idx = localDeliver.value.indexOf(channel)
  if (idx >= 0) {
    localDeliver.value.splice(idx, 1)
  } else {
    localDeliver.value.push(channel)
  }
}
</script>

<template>
  <div class="cron-card" :class="`cron-card--${tierBadge.tone}`">
    <header class="cron-card__head">
      <span class="cron-card__badge">{{ tierBadge.label }}</span>
      <span class="cron-card__title">创建定时任务</span>
      <button class="cron-card__edit-toggle" @click="editing = !editing">
        {{ editing ? '收起' : '修改' }}
      </button>
    </header>

    <!-- 紧凑只读视图 -->
    <div v-if="!editing" class="cron-card__view">
      <div class="cron-card__row">
        <span class="cron-card__label">名称</span>
        <span class="cron-card__value">{{ localName }}</span>
      </div>
      <div class="cron-card__row">
        <span class="cron-card__label">时间</span>
        <span class="cron-card__value">{{ schedulePreview || localSchedule }}</span>
        <span v-if="schedulePreview && schedulePreview !== localSchedule" class="cron-card__cron-raw">
          ({{ localSchedule }})
        </span>
      </div>
      <div class="cron-card__row">
        <span class="cron-card__label">做什么</span>
        <span class="cron-card__value cron-card__value--multi">{{ localPrompt }}</span>
      </div>
    </div>

    <!-- 可编辑表单 -->
    <div v-else class="cron-card__form">
      <label class="cron-card__field">
        <span class="cron-card__label">任务名称</span>
        <input
          v-model="localName"
          class="cron-card__input"
          maxlength="32"
          placeholder="如：每日新闻"
        />
      </label>
      <label class="cron-card__field">
        <span class="cron-card__label">执行时间</span>
        <input
          v-model="localSchedule"
          class="cron-card__input"
          placeholder="如：每天 8 点 / 0 8 * * * / @daily"
        />
        <span v-if="schedulePreview" class="cron-card__hint">预览：{{ schedulePreview }}</span>
      </label>
      <label class="cron-card__field">
        <span class="cron-card__label">做什么</span>
        <textarea
          v-model="localPrompt"
          class="cron-card__textarea"
          rows="2"
          placeholder="用自然语言描述任务内容"
        />
      </label>
      <div class="cron-card__field">
        <span class="cron-card__label">通知到</span>
        <div class="cron-card__deliver">
          <button
            v-for="ch in ['chat', 'push', 'feishu', 'discord', 'wechat']"
            :key="ch"
            class="cron-card__chip"
            :class="{ 'cron-card__chip--on': localDeliver.includes(ch) }"
            type="button"
            @click="toggleDeliver(ch)"
          >
            {{ ch }}
          </button>
        </div>
      </div>
    </div>

    <!-- 配额预警 -->
    <div
      v-if="quotaWarn"
      class="cron-card__quota"
      :class="`cron-card__quota--${quotaWarn.tone}`"
    >
      {{ quotaWarn.text }}
    </div>

    <!-- 操作按钮 -->
    <footer class="cron-card__actions">
      <button
        v-if="editing"
        class="cron-card__btn cron-card__btn--ghost"
        type="button"
        @click="onReparse"
      >
        AI 帮我改
      </button>
      <button
        class="cron-card__btn cron-card__btn--primary"
        type="button"
        :disabled="!canSubmit"
        @click="onSubmit"
      >
        确认创建
      </button>
      <button
        class="cron-card__btn"
        type="button"
        @click="$emit('dismiss')"
      >
        取消
      </button>
    </footer>
  </div>
</template>

<style scoped>
.cron-card {
  border: 1px solid var(--hc-border, #e5e7eb);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--hc-card-bg, #fff);
  margin: 8px 0;
}
.cron-card--tier-slash { border-left: 3px solid #6366f1; }
.cron-card--tier-fast { border-left: 3px solid #10b981; }
.cron-card--tier-llm { border-left: 3px solid #3b82f6; }
.cron-card--tier-guidance { border-left: 3px solid #f59e0b; }
.cron-card__head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
}
.cron-card__badge {
  font-size: 12px; padding: 2px 8px; border-radius: 999px;
  background: var(--hc-badge-bg, #f3f4f6); color: var(--hc-badge-fg, #374151);
}
.cron-card__title { font-weight: 600; flex: 1; }
.cron-card__edit-toggle {
  font-size: 12px; color: var(--hc-link, #3b82f6);
  background: transparent; border: none; cursor: pointer;
}
.cron-card__row {
  display: flex; align-items: flex-start; gap: 8px; margin: 4px 0;
  font-size: 13px;
}
.cron-card__label {
  color: var(--hc-muted, #6b7280); min-width: 64px;
}
.cron-card__value { flex: 1; }
.cron-card__value--multi { white-space: pre-wrap; }
.cron-card__cron-raw { color: var(--hc-muted, #9ca3af); font-size: 12px; font-family: monospace; }
.cron-card__field {
  display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;
  font-size: 13px;
}
.cron-card__input, .cron-card__textarea {
  border: 1px solid var(--hc-input-border, #d1d5db);
  border-radius: 8px; padding: 6px 8px;
  font-size: 13px; width: 100%;
}
.cron-card__textarea { resize: vertical; min-height: 48px; }
.cron-card__hint { font-size: 11px; color: var(--hc-muted, #6b7280); }
.cron-card__deliver { display: flex; flex-wrap: wrap; gap: 6px; }
.cron-card__chip {
  padding: 3px 10px; border-radius: 999px; font-size: 12px;
  background: var(--hc-chip-bg, #f3f4f6); border: 1px solid transparent;
  cursor: pointer;
}
.cron-card__chip--on { background: var(--hc-chip-on-bg, #dbeafe); border-color: #3b82f6; }
.cron-card__quota {
  font-size: 12px; padding: 4px 8px; border-radius: 6px; margin: 6px 0;
}
.cron-card__quota--ok { background: #f0fdf4; color: #166534; }
.cron-card__quota--warn { background: #fffbeb; color: #92400e; }
.cron-card__quota--block { background: #fef2f2; color: #991b1b; }
.cron-card__actions {
  display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end;
}
.cron-card__btn {
  padding: 5px 12px; border-radius: 8px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--hc-btn-border, #d1d5db); background: transparent;
}
.cron-card__btn--primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.cron-card__btn--primary:disabled { opacity: 0.5; cursor: not-allowed; }
.cron-card__btn--ghost { color: #3b82f6; border-color: #3b82f6; }
</style>
