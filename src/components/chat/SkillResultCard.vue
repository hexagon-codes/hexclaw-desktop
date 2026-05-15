<!--
  SkillResultCard — Skill 执行结果卡片。

  当 assistant 消息的 metadata.skillId 存在时，
  用此组件替代普通消息气泡，以卡片形式展示技能输出。

  结构：header（技能名 + 状态 + 耗时）+ body（Markdown 渲染结果）
-->
<script setup lang="ts">
import { useRouter } from 'vue-router'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = defineProps<{
  skillId: string
  skillName: string
  status?: string
  elapsed?: number
  content: string
}>()

const router = useRouter()

function navigateToWorkspace() {
  router.push({ path: '/workspace', query: { taskId: props.skillId } })
}
</script>

<template>
  <div class="hc-skill-card" @click="navigateToWorkspace">
    <div class="hc-skill-card__header">
      <span class="hc-skill-card__icon">⚙</span>
      <span class="hc-skill-card__name">{{ skillName }}</span>
      <span v-if="status" class="hc-skill-card__status">{{ status }}</span>
      <span v-if="elapsed" class="hc-skill-card__elapsed">{{ (elapsed / 1000).toFixed(1) }}s</span>
    </div>
    <div class="hc-skill-card__body">
      <MarkdownRenderer :content="content" />
    </div>
  </div>
</template>

<style scoped>
.hc-skill-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 6px 0;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
  animation: hc-sc-enter 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.hc-skill-card:hover {
  box-shadow: var(--hc-shadow-md);
  border-color: var(--hc-accent);
}
@keyframes hc-sc-enter {
  from { opacity: 0; transform: scale(0.96) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

/* ── Header ── */
.hc-skill-card__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 0.5px solid var(--hc-border);
  background: var(--hc-bg-elevated);
}
.hc-skill-card__icon {
  font-size: 13px;
  opacity: 0.6;
}
.hc-skill-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--hc-text-primary);
  letter-spacing: -0.01em;
}
.hc-skill-card__status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
  font-weight: 500;
}
.hc-skill-card__elapsed {
  font-size: 11px;
  color: var(--hc-text-muted);
  margin-left: auto;
}

/* ── Body ── */
.hc-skill-card__body {
  padding: 14px 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--hc-text-primary);
}
</style>
