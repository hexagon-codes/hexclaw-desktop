<script setup lang="ts">
/**
 * 通用记录本视图（schema 驱动 · 架构 §7.3 / M1-6）。
 *
 * 领域无关：只认 RecordSchema + RecordCollectionView，按字段 role（title/chip/meta/status/date）
 * 渲染，状态色调走 schema.states.tone。**侧边栏/组件零硬编码业务集合名**（回归锁 §8.4）。
 * 场景专属动作（如生成打印卷）经 slot 注入；每行通用复习动作经 action 事件外派。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RecordSchema, RecordItem, RecordCollectionView, RecordFieldSpec } from '@/contracts'

const props = defineProps<{
  schema: RecordSchema
  view: RecordCollectionView
}>()

const emit = defineEmits<{
  (e: 'action', payload: { id: 'practiceAgain' | 'markMastered' | 'detail'; record: RecordItem }): void
}>()

const { t } = useI18n()

const fieldsByRole = (role: RecordFieldSpec['role']) => props.schema.fields.filter((f) => f.role === role)
const titleField = computed(() => fieldsByRole('title')[0])
const chipFields = computed(() => fieldsByRole('chip'))
const metaFields = computed(() => fieldsByRole('meta'))
const dateField = computed(() => fieldsByRole('date')[0])

function fieldValue(item: RecordItem, field?: RecordFieldSpec): string {
  if (!field) return ''
  const raw = item.fields[field.key]
  if (raw == null) return ''
  if (field.type === 'tags' && Array.isArray(raw)) return raw.join(' · ')
  if (field.type === 'enum' && field.enumKey) return t(`${field.enumKey}.${String(raw)}`)
  return String(raw)
}

function stateOf(item: RecordItem) {
  return props.schema.states?.find((s) => s.id === item.status)
}

// 状态筛选（通用）：全部 + 各状态
const activeFilter = ref<string>('all')
const filteredItems = computed(() => {
  if (activeFilter.value === 'all') return props.view.items
  return props.view.items.filter((i) => i.status === activeFilter.value)
})

const reviewItems = computed(() => {
  const queue = props.view.reviewQueue
  if (!props.schema.reviewable || !queue?.length) return []
  const byId = new Map(props.view.items.map((i) => [i.recordId, i]))
  return queue.map((id) => byId.get(id)).filter((i): i is RecordItem => !!i)
})
</script>

<template>
  <div class="record-list">
    <!-- 复习队列（reviewable 集合才有；场景专属动作经 slot 注入） -->
    <section v-if="reviewItems.length" class="rl-review">
      <header class="rl-review__head">
        <!-- 20260709 视觉评审：功能位 emoji → 单色描边图标（emoji 保留给身份/语义徽章位） -->
        <b class="rl-review__title"><svg class="rl-ic" viewBox="0 0 24 24"><path d="M4 22V4c0-.6.4-1 1-1h9.5l-.8 3.2c-.1.5.2.8.7.8H20l-2 6h-7" /></svg>{{ t('records.reviewQueueTitle') }} · {{ t('records.reviewQueueCount', { count: reviewItems.length }) }}</b>
        <span class="rl-spacer" />
        <slot name="review-actions" :items="reviewItems" />
      </header>
      <div class="rl-rows">
        <div v-for="item in reviewItems" :key="item.recordId" class="rl-row">
          <b class="rl-title">{{ fieldValue(item, titleField) }}</b>
          <!-- data-chip=chip 文本：领域无关的样式钩子，场景层可按值前缀定色（如 K12 学科色） -->
          <span v-for="f in chipFields" :key="f.key" class="rl-chip" :data-chip="fieldValue(item, f)">{{ fieldValue(item, f) }}</span>
          <span class="rl-meta rl-spacer">{{ metaFields.map((f) => fieldValue(item, f)).filter(Boolean).join(' · ') }}</span>
          <button class="rl-btn" @click="emit('action', { id: 'practiceAgain', record: item })">
            {{ t('records.practiceAgain') }}
          </button>
          <button class="rl-btn" @click="emit('action', { id: 'markMastered', record: item })">
            {{ t('records.markMastered') }}
          </button>
        </div>
      </div>
    </section>

    <!-- 状态筛选 -->
    <div v-if="schema.states?.length" class="rl-filters">
      <button class="rl-tag" :class="{ on: activeFilter === 'all' }" @click="activeFilter = 'all'">
        {{ t('records.all') }}
      </button>
      <button
        v-for="s in schema.states"
        :key="s.id"
        class="rl-tag"
        :class="{ on: activeFilter === s.id }"
        @click="activeFilter = s.id"
      >
        {{ t(s.labelKey) }}
      </button>
    </div>

    <!-- 全部记录 -->
    <p v-if="!filteredItems.length" class="rl-empty">{{ t('records.empty') }}</p>
    <div v-else class="rl-rows">
      <div v-for="item in filteredItems" :key="item.recordId" class="rl-row">
        <span v-if="dateField" class="rl-date">{{ fieldValue(item, dateField) }}</span>
        <b class="rl-title">{{ fieldValue(item, titleField) }}</b>
        <span v-for="f in chipFields" :key="f.key" class="rl-chip" :data-chip="fieldValue(item, f)">{{ fieldValue(item, f) }}</span>
        <span class="rl-meta rl-spacer">{{ metaFields.map((f) => fieldValue(item, f)).filter(Boolean).join(' · ') }}</span>
        <span v-if="stateOf(item)" class="rl-status" :class="`rl-status--${stateOf(item)!.tone ?? 'na'}`">
          {{ t(stateOf(item)!.labelKey) }}
        </span>
        <button class="rl-btn" @click="emit('action', { id: 'practiceAgain', record: item })">
          {{ t('records.practice') }}
        </button>
        <button class="rl-btn" @click="emit('action', { id: 'detail', record: item })">
          {{ t('records.detail') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.record-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rl-spacer {
  flex: 1;
}
.rl-review {
  border-left: 3px solid var(--hc-accent);
  background: var(--hc-bg-card);
  border-radius: var(--hc-radius-md);
  padding: 12px 14px;
}
.rl-review__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  color: var(--hc-text-primary);
}
.rl-review__title { display: inline-flex; align-items: center; gap: 6px; }
.rl-ic { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
.rl-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rl-review .rl-rows {
  margin-top: 10px;
}
.rl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  font-size: 13px;
}
.rl-date {
  font-variant-numeric: tabular-nums;
  color: var(--hc-text-muted);
  font-size: 12px;
  flex-shrink: 0;
}
.rl-title {
  color: var(--hc-text-primary);
}
.rl-chip {
  font-size: 10.5px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  border-radius: 4px;
  padding: 2px 7px;
  font-weight: 650;
  white-space: nowrap;
}
.rl-meta {
  color: var(--hc-text-secondary);
  font-size: 12px;
  min-width: 0;
}
.rl-status {
  font-size: 10.5px;
  border-radius: 999px;
  padding: 2px 9px;
  font-weight: 700;
  white-space: nowrap;
}
.rl-status--todo { color: var(--hc-error); background: color-mix(in srgb, var(--hc-error) 10%, transparent); }
.rl-status--done { color: var(--hc-warning); background: color-mix(in srgb, var(--hc-warning) 12%, transparent); }
.rl-status--got { color: var(--hc-success); background: color-mix(in srgb, var(--hc-success) 10%, transparent); }
.rl-status--na { color: var(--hc-text-muted); background: var(--hc-bg-input); }
.rl-filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.rl-tag {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 7px;
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
  border: none;
  cursor: pointer;
}
.rl-tag.on {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.rl-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}
.rl-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.rl-empty {
  color: var(--hc-text-muted);
  font-size: 13px;
  padding: 20px 4px;
  text-align: center;
}
</style>
