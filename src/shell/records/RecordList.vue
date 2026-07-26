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
  /** 只显示档案列表（隐藏复习行动区）——供「行动页/档案页」拆分 Tab 复用（中性展示开关，无业务语义） */
  hideReview?: boolean
  /** 只显示复习行动区（隐藏档案列表与筛选） */
  hideList?: boolean
  /** 场景层自行提供复合筛选时隐藏内建单维状态筛选。 */
  hideFilters?: boolean
  /** 场景层视觉变体类名；通用记录本不解释其业务语义。 */
  reviewClass?: string
}>()

const emit = defineEmits<{
  (e: 'action', payload: { id: 'markMastered' | 'detail'; record: RecordItem }): void
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

// 项-6a：芯片值末尾的分隔符「·」剥掉——知识点为空时场景层组合出的「数学·」会看着断了尾巴，
// 只显「数学」。领域无关：任何芯片都不该以分隔符收尾。
function chipText(item: RecordItem, field?: RecordFieldSpec): string {
  return fieldValue(item, field).replace(/[·・]\s*$/, '').trimEnd()
}

function stateOf(item: RecordItem) {
  return props.schema.states?.find((s) => s.id === item.status)
}

// UX-1：「他会了」下放到全部档案行（此前只在到期复习队列块，该块常空 → 家长找不到入口）。
// 领域无关判定：仅可复习集合（reviewable，如错题本）渲染；已到「达成」态（tone=got，如已掌握）
// 或「归档」终态（tone=na）的行不再显示——幂等，且这两态点了后端状态机也会拒。
function canMarkMastered(item: RecordItem): boolean {
  if (!props.schema.reviewable) return false
  const tone = stateOf(item)?.tone
  return tone !== 'got' && tone !== 'na'
}

function canPractice(item: RecordItem): boolean {
  if (!props.schema.reviewable) return false
  const tone = stateOf(item)?.tone
  return tone !== 'got' && tone !== 'na'
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
    <section v-if="!hideReview && reviewItems.length" class="rl-review" :class="reviewClass">
      <header class="rl-review__head">
        <!-- 20260709 视觉评审：功能位 emoji → 单色描边图标（emoji 保留给身份/语义徽章位） -->
        <slot name="review-title" :items="reviewItems">
          <b class="rl-review__title"><svg class="rl-ic" viewBox="0 0 24 24"><path d="M4 22V4c0-.6.4-1 1-1h9.5l-.8 3.2c-.1.5.2.8.7.8H20l-2 6h-7" /></svg>{{ t('records.reviewQueueTitle') }} · {{ t('records.reviewQueueCount', { count: reviewItems.length }) }}</b>
        </slot>
        <!-- 标题旁注入缝（原型 c8a194e：跨科分布括号 + 趋势 pill 并入行动卡）——场景层经 slot 提供，shell 零领域词 -->
        <slot name="review-meta" :items="reviewItems" />
        <span class="rl-spacer" />
        <slot name="review-actions" :items="reviewItems" />
      </header>
      <div class="rl-rows">
        <div v-for="item in reviewItems" :key="item.recordId" class="rl-row">
          <b class="rl-title">{{ fieldValue(item, titleField) }}</b>
          <!-- data-chip=chip 文本：领域无关的样式钩子，场景层可按值前缀定色（如 K12 学科色） -->
          <span v-for="f in chipFields" :key="f.key" class="rl-chip" :data-chip="chipText(item, f)">{{ chipText(item, f) }}</span>
          <span class="rl-meta rl-spacer" :title="metaFields.map((f) => fieldValue(item, f)).filter(Boolean).join(' · ')">{{ metaFields.map((f) => fieldValue(item, f)).filter(Boolean).join(' · ') }}</span>
          <slot name="review-practice-action" :item="item" />
          <button class="rl-btn" @click="emit('action', { id: 'markMastered', record: item })">
            {{ t('records.markMastered') }}
          </button>
          <slot name="review-row-actions" :item="item" />
        </div>
      </div>
      <!-- 卡内脚注注入缝（原型 c8a194e：留存钩子独立成行，如「每周五 19:00 自动出下一卷」） -->
      <div v-if="$slots['review-foot']" class="rl-review__foot"><slot name="review-foot" /></div>
    </section>

    <!-- 档案区标题注入缝（原型 c8a194e：「全部错题 (N)」——文案由场景层给，shell 零领域词） -->
    <div v-if="!hideList && $slots['list-title']" class="rl-list-title"><slot name="list-title" :count="view.items.length" /></div>

    <!-- 状态筛选 -->
    <div v-if="!hideList && !hideFilters && schema.states?.length" class="rl-filters">
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
    <p v-if="!hideList && !filteredItems.length" class="rl-empty">{{ t('records.empty') }}</p>
    <div v-else-if="!hideList" class="rl-rows">
      <div v-for="item in filteredItems" :key="item.recordId" class="rl-row">
        <span v-if="dateField" class="rl-date">{{ fieldValue(item, dateField) }}</span>
        <b class="rl-title">{{ fieldValue(item, titleField) }}</b>
        <span v-for="f in chipFields" :key="f.key" class="rl-chip" :data-chip="chipText(item, f)">{{ chipText(item, f) }}</span>
        <span class="rl-meta rl-spacer">{{ metaFields.map((f) => fieldValue(item, f)).filter(Boolean).join(' · ') }}</span>
        <span v-if="stateOf(item)" class="rl-status" :class="`rl-status--${stateOf(item)!.tone ?? 'na'}`">
          {{ t(stateOf(item)!.labelKey) }}
        </span>
        <!-- 「再练」是复习动作：仅可复习集合（schema.reviewable）才渲染——积累本不复习/不再练，
             无条件渲染死按钮会点了无反应（BUG-20260712-#2 治本，schema 门控行内动作）。 -->
        <slot v-if="canPractice(item)" name="list-practice-action" :item="item" />
        <!-- UX-1：全部错题档案行也能「他会了」（未掌握/未归档时才显，幂等）。 -->
        <button v-if="canMarkMastered(item)" class="rl-btn" @click="emit('action', { id: 'markMastered', record: item })">
          {{ t('records.markMastered') }}
        </button>
        <slot name="list-row-actions" :item="item" />
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
.rl-review__foot {
  margin-top: 9px;
  font-size: 11.5px;
  color: var(--hc-text-muted);
}
.rl-list-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--hc-text-primary);
  margin-top: 4px;
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
  /* 错因/元信息格：自带 flex:1 + min-width:0 + 单行省略号（对齐原型 .resource-row .sp）。
     根因锁（Bug-20260713）：本格 flex-basis 为 0，当同行学科芯片 .rl-chip 是 nowrap 长文本
     （如「数学·长方体的体积」）挤满整行时，本格被压成 ~1 字宽；若允许换行，CJK 错因会逐字竖排。
     nowrap + ellipsis = 芯片长短都不逐字竖排，错因始终横排一行、超长截断。 */
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.record-list :slotted(.rl-btn) {
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 11.5px;
  cursor: pointer;
}
.record-list :slotted(.rl-btn:hover) {
  border-color: var(--hc-accent);
  color: var(--hc-accent);
}
.rl-empty {
  color: var(--hc-text-muted);
  font-size: 13px;
  padding: 20px 4px;
  text-align: center;
}
</style>
