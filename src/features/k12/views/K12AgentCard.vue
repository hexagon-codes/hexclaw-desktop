<script setup lang="ts">
/**
 * 智能体页·辅导助手卡扩展（features/k12）· 原型同步①层。
 * 由 scenarioRegistry.registerAgentCardExtension 注册，AgentsView 只对场景实例渲染本组件、
 * 不认识 K12。展示 错题/待复习 计数（走 /api/k12/mistakes + /review-queue）+ 快捷入口（深链带 query）。
 */
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { k12ListMistakes, k12ReviewQueue } from '@/api/k12'
import K12ProfileForm from './K12ProfileForm.vue'

const props = defineProps<{
  agent: {
    name: string
    display_name?: string
    metadata?: Record<string, string>
    skills?: string[]
  }
}>()
const emit = defineEmits<{ (e: 'updated'): void }>()

const { t } = useI18n()
const router = useRouter()

const mistakeCount = ref<number | null>(null)
const dueCount = ref<number | null>(null)
const editing = ref(false)

// 进入动作变体只由稳定 metadata 投影决定；缺失或未知值保持原型的主按钮默认值。
const enterButtonClass = computed(() => ({
  'k12ac__btn': true,
  'hc-btn': true,
  'hc-btn-primary': props.agent.metadata?.card_enter_variant !== 'default',
}))

async function loadCounts() {
  try {
    const [all, due] = await Promise.all([
      k12ListMistakes(props.agent.name),
      k12ReviewQueue(props.agent.name),
    ])
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
    <div
      class="k12ac__chips hc-agent-card__facts"
      :aria-hidden="!(mistakeCount || dueCount)"
    >
      <span v-if="mistakeCount" class="k12ac__tag">{{
        t('k12.agentCard.mistakeCount', { n: mistakeCount })
      }}</span>
      <span v-if="dueCount" class="k12ac__tag k12ac__tag--warn">{{
        t('k12.agentCard.reviewDue', { n: dueCount })
      }}</span>
    </div>
    <div class="k12ac__actions hc-agent-card__footer">
      <button :class="enterButtonClass" @click="enter()">
        {{ t('k12.agentCard.enterTutor') }}
      </button>
      <button class="k12ac__btn hc-btn" @click="enter({ scenarioTab: 'records' })">
        {{ t('k12.agentCard.records') }}
      </button>
      <!-- 20260709：辅导要点快捷入口移除——辅导要点已内联进识题流，不再有独立入口/深链。 -->
      <button class="k12ac__btn hc-btn hc-btn-ghost" @click="editing = true">
        {{ t('k12.profile.edit') }}
      </button>
    </div>

    <!-- 编辑档案（改档：改年级 → 讲题边界即时跟随；过渡走 updateAgent，待后端 /profile） -->
    <K12ProfileForm
      v-if="editing"
      :agent="agent"
      @created="onEdited"
      @removed="emit('updated')"
      @close="editing = false"
    />
  </div>
</template>

<style scoped>
/* 原型回灌（hexclaw-docs/prototype/app.html）：K12 卡按钮/徽章与普通卡（翻译官等）完全同度量，
   不再用自造的小一号私有样式。徽章=原型 .tag(:192)，按钮=原型 .btn/.btn-primary/.btn-ghost(:151-160)
   = 桌面通用 .hc-btn 度量（8px 14px / 13px / radius-md / 0.5px border）。 */
.k12ac {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
}
.k12ac__chips {
  display: flex;
  min-block-size: 24px;
  gap: 7px;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
}
.k12ac__tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}
.k12ac__tag--warn {
  color: var(--hc-error);
}
.k12ac__actions {
  display: flex;
  margin-top: auto;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
</style>
