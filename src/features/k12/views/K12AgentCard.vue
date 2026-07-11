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
// roleTitle 带显示名快照进会话标题——标题是会话自己的资产，智能体删除后列表仍显示
// 「小明的辅导助手 · 五年级」而非内部 ID（BUG-20260711，对齐 AgentsView/WelcomeView 与原型 .cs-item）。
function enter(query?: Record<string, string>) {
  const roleTitle = props.agent.display_name?.trim() || props.agent.name
  router.push({ path: '/chat', query: { role: props.agent.name, roleTitle, ...query } })
}
</script>

<template>
  <div class="k12ac">
    <!-- 原型回灌（app.html:1300-1301）：徽章行只在有计数时渲染、只显非零，
         避免空徽章行 + 「错题 0」占位（两值皆空则整行不渲染）。 -->
    <div v-if="mistakeCount || dueCount" class="k12ac__chips">
      <span v-if="mistakeCount" class="k12ac__tag">{{ t('k12.agentCard.mistakeCount', { n: mistakeCount }) }}</span>
      <span v-if="dueCount" class="k12ac__tag k12ac__tag--warn">{{ t('k12.agentCard.reviewDue', { n: dueCount }) }}</span>
    </div>
    <div class="k12ac__actions">
      <button class="k12ac__btn k12ac__btn--primary" @click="enter()">🎓 {{ t('k12.agentCard.enterTutor') }}</button>
      <button class="k12ac__btn" @click="enter({ scenarioTab: 'records' })">{{ t('k12.agentCard.records') }}</button>
      <!-- 20260709：备课卡快捷入口移除——辅导要点已内联进识题流，不再有独立入口/深链。 -->
      <button class="k12ac__btn k12ac__btn--ghost" @click="editing = true">{{ t('k12.profile.edit') }}</button>
    </div>

    <!-- 编辑档案（改档：改年级 → 讲题边界即时跟随；过渡走 updateAgent，待后端 /profile） -->
    <K12ProfileForm v-if="editing" :agent="agent" @created="onEdited" @removed="emit('updated')" @close="editing = false" />
  </div>
</template>

<style scoped>
/* 原型回灌（hexclaw-docs/prototype/app.html）：K12 卡按钮/徽章与普通卡（翻译官等）完全同度量，
   不再用自造的小一号私有样式。徽章=原型 .tag(:192)，按钮=原型 .btn/.btn-primary/.btn-ghost(:151-160)
   = 桌面通用 .hc-btn 度量（8px 14px / 13px / radius-md / 0.5px border）。 */
.k12ac { display: flex; flex-direction: column; gap: 8px; }
.k12ac__chips { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
.k12ac__tag {
  font-size: 11px; padding: 1px 7px; border-radius: 6px;
  background: var(--hc-bg-active); color: var(--hc-text-secondary);
}
.k12ac__tag--warn { color: var(--hc-error); }
.k12ac__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.k12ac__btn {
  display: inline-flex; align-items: center; gap: var(--hc-space-2);
  font-size: 13px; font-weight: 500; padding: 8px 14px; white-space: nowrap;
  border-radius: var(--hc-radius-md); cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary);
  transition: background 0.2s;
}
/* 通用 hover 排除 primary,否则浅色 hover 背景盖掉蓝色渐变、白字留在浅底上→隐形（BUG-20260708） */
.k12ac__btn:not(.k12ac__btn--primary):hover { background: var(--hc-bg-hover); }
.k12ac__btn--primary { background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent; }
/* primary 专属 hover：渐变微亮 + 保持白字（对齐其它主按钮的悬停手感） */
.k12ac__btn--primary:hover { background: linear-gradient(180deg, #6fbdf0 0%, #57a9e6 100%); }
/* 原型 .btn-ghost(:160)：编辑档案弱化层级（透明底） */
.k12ac__btn--ghost { background: transparent; border-color: transparent; color: var(--hc-text-secondary); }
.k12ac__btn--ghost:hover { background: var(--hc-bg-hover); }
</style>
