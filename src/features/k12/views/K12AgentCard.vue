<script setup lang="ts">
/**
 * 智能体页·辅导助手卡扩展（features/k12）· 原型同步①层。
 * 由 scenarioRegistry.registerAgentCardExtension 注册，AgentsView 只对场景实例渲染本组件、
 * 不认识 K12。展示 错题/待复习 计数（走 /api/k12/mistakes + /review-queue）+ 快捷入口（深链带 query）。
 */
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { k12ListMistakes, k12ReviewQueue } from '@/api/k12'
import K12ProfileForm from './K12ProfileForm.vue'

const props = defineProps<{
  agent: { name: string; display_name?: string; metadata?: Record<string, string>; skills?: string[] }
}>()
const emit = defineEmits<{ (e: 'updated'): void }>()

const { t } = useI18n()
const router = useRouter()

const mistakeCount = ref<number | null>(null)
const dueCount = ref<number | null>(null)
const editing = ref(false)

async function loadCounts() {
  try {
    const [all, due] = await Promise.all([k12ListMistakes(props.agent.name), k12ReviewQueue(props.agent.name)])
    mistakeCount.value = all.items.length
    dueCount.value = due.items.length
  } catch {
    // 计数失败静默（引擎未就绪/无数据），不阻塞卡片
  }
}
onMounted(loadCounts)

function onEdited() {
  editing.value = false
  void loadCounts()
  emit('updated') // 通知 AgentsView 刷新列表（显示名可能随年级变化）
}

// 深链：会话即入口 + query 提示 K12 增强切到对应子视图/侧栏（enhancement 读 route.query）
function enter(query?: Record<string, string>) {
  router.push({ path: '/chat', query: { role: props.agent.name, ...query } })
}
</script>

<template>
  <div class="k12ac">
    <div class="k12ac__chips">
      <span v-if="mistakeCount !== null" class="k12ac__tag">{{ t('k12.agentCard.mistakeCount', { n: mistakeCount }) }}</span>
      <span v-if="dueCount" class="k12ac__tag k12ac__tag--warn">{{ t('k12.agentCard.reviewDue', { n: dueCount }) }}</span>
    </div>
    <div class="k12ac__actions">
      <button class="k12ac__btn k12ac__btn--primary" @click="enter()">🎓 {{ t('k12.agentCard.enterTutor') }}</button>
      <button class="k12ac__btn" @click="enter({ scenarioTab: 'records' })">{{ t('k12.agentCard.records') }}</button>
      <!-- 20260709：备课卡快捷入口移除——辅导要点已内联进识题流，不再有独立入口/深链。 -->
      <button class="k12ac__btn" @click="editing = true">{{ t('k12.profile.edit') }}</button>
    </div>

    <!-- 编辑档案（改档：改年级 → 讲题边界即时跟随；过渡走 updateAgent，待后端 /profile） -->
    <K12ProfileForm v-if="editing" :agent="agent" @created="onEdited" @close="editing = false" />
  </div>
</template>

<style scoped>
.k12ac { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.k12ac__chips { display: flex; gap: 6px; flex-wrap: wrap; }
.k12ac__tag {
  font-size: 11px; padding: 2px 8px; border-radius: 6px;
  background: var(--hc-accent-subtle); color: var(--hc-accent); font-weight: 600;
}
.k12ac__tag--warn { background: color-mix(in srgb, var(--hc-error) 12%, transparent); color: var(--hc-error); }
.k12ac__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.k12ac__btn {
  font-size: 12.5px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
/* 通用 hover 排除 primary,否则浅色 hover 背景盖掉蓝色渐变、白字留在浅底上→隐形（BUG-20260708） */
.k12ac__btn:not(.k12ac__btn--primary):hover { background: var(--hc-bg-hover); }
.k12ac__btn--primary { background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent; }
/* primary 专属 hover：渐变微亮 + 保持白字（对齐其它主按钮的悬停手感） */
.k12ac__btn--primary:hover { background: linear-gradient(180deg, #6fbdf0 0%, #57a9e6 100%); }
</style>
