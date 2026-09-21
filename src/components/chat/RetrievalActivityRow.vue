<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RetrievalActivity } from '@/types/chat'
import { knowledgeHitTitle } from '@/utils/retrieval-hits'
import KnowledgeSourceDialog from '@/components/knowledge/KnowledgeSourceDialog.vue'
const props = defineProps<{ activity: RetrievalActivity; historical?: boolean }>()
const { t } = useI18n()
const hits = computed(() => props.activity.knowledge_hits ?? props.activity.memory_hits ?? [])
const residentHits = computed(() => props.activity.resident_hits ?? [])
const source = ref<Record<string, unknown> | null>(null)
const hasDetails = computed(() => hits.value.length > 0)
const groups = computed(() => [
  ...(hits.value.length
    ? [{ name: residentHits.value.length ? 'Recalled' : '', hits: hits.value }]
    : []),
])
const countLabel = computed(() => {
  if (props.activity.status === 'failed') return 'Retrieval failed'
  if (residentHits.value.length)
    return `${residentHits.value.length} resident${hits.value.length ? ` · ${hits.value.length} recalled` : ''}`
  return hits.value.length
    ? `${hits.value.length} ${hits.value.length === 1 ? 'record' : 'records'}`
    : 'No matching records'
})
function canOpenSource(hit: Record<string, unknown>) {
  return (
    typeof hit.doc_id === 'string' &&
    hit.doc_id !== '' &&
    typeof hit.doc_title === 'string' &&
    /\.pdf$/i.test(hit.doc_title)
  )
}
function openSource(hit: Record<string, unknown>, event: MouseEvent) {
  // WebKit 的指针点击不一定聚焦按钮，打开前固定关闭后的真实返回目标。
  if (event.currentTarget instanceof HTMLElement)
    event.currentTarget.focus({ preventScroll: true })
  source.value = hit
}
function displayContent(hit: Record<string, unknown>) {
  // PDF 提取空白只在摘录投影归一化，不改变原文、来源定位或持久回执。
  return typeof hit.content === 'string'
    ? hit.content.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
    : ''
}
const title = computed(() =>
  props.activity.kind === 'knowledge'
    ? '知识库检索'
    : props.activity.source === 'history'
      ? '历史会话召回'
      : '记忆召回',
)
function sourceURL(hit: Record<string, unknown>) {
  if (typeof hit.source !== 'string') return undefined
  try {
    const url = new URL(hit.source)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
</script>
<template>
  <details
    class="hc-process-tool"
    :class="{ 'hc-process-tool--empty': !hasDetails }"
    :data-status="activity.status === 'failed' ? 'error' : 'success'"
  >
    <summary @click="!hasDetails && $event.preventDefault()">
      <span class="hc-process__marker" aria-hidden="true"
        ><span v-if="activity.status === 'failed'">!</span
        ><svg v-else viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 2.5 2.5L16 9" /></svg
      ></span>
      <span class="hc-process-tool__name">{{ title }}</span>
      <span class="hc-process-tool__meta">{{ countLabel }}</span>
      <span v-if="historical" class="hc-process-tool__meta">Summary</span>
    </summary>
    <div v-if="hasDetails" class="hc-process-tool__detail">
      <template v-for="group in groups" :key="group.name">
        <div v-if="group.name" class="hc-process-tool__meta">{{ group.name }}</div>
        <div
          v-for="(hit, index) in group.hits"
          :key="String(hit.id ?? index)"
          class="hc-process__retrieval-hit"
        >
          <div v-if="activity.kind === 'knowledge'" class="hc-process__retrieval-title">
            <button
              v-if="canOpenSource(hit)"
              type="button"
              class="hc-process__source-link"
              @click="openSource(hit, $event)"
            >
              {{ knowledgeHitTitle(hit, t)
              }}<span v-if="hit.page_start">
                · {{ hit.page_start
                }}<template v-if="hit.page_end !== hit.page_start"
                  >–{{ hit.page_end }}</template
                ></span
              >
            </button>
            <template v-else>{{ knowledgeHitTitle(hit, t) }}</template>
          </div>
          <a v-if="sourceURL(hit)" :href="sourceURL(hit)" target="_blank" rel="noreferrer">{{
            hit.source
          }}</a>
          <div v-else-if="hit.source && !canOpenSource(hit)" class="hc-process-tool__meta">
            {{ hit.source }}
          </div>
          <p
            v-if="activity.kind === 'knowledge' && displayContent(hit)"
            class="hc-process__excerpt"
          >{{ displayContent(hit) }}</p>
          <p v-else-if="typeof hit.content === 'string'">{{ hit.content }}</p>
        </div>
      </template>
    </div>
  </details>
  <KnowledgeSourceDialog
    v-if="source"
    :document-id="String(source.doc_id)"
    :title="String(source.doc_title)"
    :source-digest="typeof source.source_digest === 'string' ? source.source_digest : undefined"
    :initial-page="
      typeof source.page_start === 'number' && source.page_start > 0 ? source.page_start : 1
    "
    @close="source = null"
  />
</template>
<style scoped>
.hc-process__source-link {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.hc-process__source-link:hover {
  text-decoration: underline;
}
.hc-process-tool--empty > summary {
  cursor: default;
}
</style>
