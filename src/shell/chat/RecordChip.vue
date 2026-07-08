<script setup lang="ts">
/**
 * 入库徽章（通用消息装饰 · descriptor message_badges: 'record-chip'）。
 *
 * 领域无关：只认已格式化的数据（集合名 / 字段 chip / 状态名，均由 schema 在上游解析）。
 * 判错入库时后端在消息 metadata.record 标注，shell 据 schema 渲染，零场景领域字面量。
 */
import { useI18n } from 'vue-i18n'

defineProps<{
  /** 集合显示名（来自 schema.labelKey，由上游按场景解析） */
  collectionLabel: string
  /** 已格式化的字段 chip（如「知识点【小数乘法】」），由 schema 在上游拼好 */
  chips: string[]
  /** 状态显示名（来自 schema.states，如「待复习」） */
  statusLabel?: string
}>()

const { t } = useI18n()
</script>

<template>
  <div class="record-chip">
    <span aria-hidden="true">✓</span>
    <span>{{ t('records.savedTo') }}{{ collectionLabel }}</span>
    <template v-for="(c, i) in chips" :key="i">
      <span class="record-chip__dot">·</span>
      <span>{{ c }}</span>
    </template>
    <template v-if="statusLabel">
      <span class="record-chip__dot">·</span>
      <span>{{ t('records.statusColon') }}{{ statusLabel }}</span>
    </template>
  </div>
</template>

<style scoped>
.record-chip {
  align-self: flex-start;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 10%, transparent);
  border-radius: 999px;
  padding: 4px 13px;
  margin: 6px 0 2px;
}
.record-chip__dot {
  opacity: 0.5;
}
</style>
