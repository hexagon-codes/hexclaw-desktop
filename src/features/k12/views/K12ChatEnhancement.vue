<script setup lang="ts">
/**
 * K12 会话增强（features/k12）· M3-1 会话即入口 · 架构 §7.4 chat 三扩展槽 + 产物槽。
 *
 * 由 scenarioRegistry.registerChatEnhancement 注册，chat shell(ChatView) 只用 <component :is>
 * 渲染本组件、不 import 本模块——ChatView 保持零 K12 词（回归锁）。
 *
 * 提供：①头部 tab（辅导/错题本 就地切换，不分叉会话）②识题后内联「这份作业的辅导要点」③记录视图。
 * 通过 update:recordsActive 告知外壳何时隐藏原生消息区（记录视图接管）。
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { k12GetViewDescriptor } from '@/api/k12'
import type { InstanceViewDescriptor } from '@/contracts'
import K12RecordsView from './K12RecordsView.vue'
import K12InsightPanel from './K12InsightPanel.vue'
import K12BackupModal from './K12BackupModal.vue'
import RecognizeGuardPanel from './RecognizeGuardPanel.vue'
import crabLogo from '@/assets/logo-crab.png'
import type { K12RecordsNavigation, K12RecordsTarget } from '../records-navigation'
import type {
  ScenarioComposerAction,
  ScenarioComposerChip,
  ScenarioComposerCommand,
  ScenarioComposerImagePayload,
  ScenarioTextModelRoute,
} from '@/shell/scenario/registry'
import { scenarioMessageAnchorId } from '@/shell/scenario/registry'
import { listImageTaskBindings } from '../image-task-binding'

const props = defineProps<{
  agentId: string
  agentName: string
  /** 通用会话 ID：仅用于 source_session 与同一 ImageTaskDispatch 的最小刷新恢复。 */
  sessionId?: string
  /** 通用 metadata（ChatView 透传）；年级由本组件解析后端 profile 键 k12.grade_term */
  metadata?: Record<string, string>
  descriptor: InstanceViewDescriptor
  /** shell 在当前交互时展示的文本模型路由；K12 只透传给会产生异步文本任务的子视图。 */
  modelRoute?: ScenarioTextModelRoute
  /** composer 改道进来的图片 dataURL（BUG-20260709 拍照发题不解题）：
   *  外壳把 ChatInput 拦下的粘贴/上传图片经此传入 → 自动打开识题护栏并识题；
   *  消费后 emit update:composerImage('') 复位，避免重复触发。通用 prop，零 shell 领域词。 */
  composerImage?: ScenarioComposerImagePayload | string
  /** 通用 shell 转发的结构化 composer action；领域 action id 只由本 feature 解释。 */
  composerAction?: ScenarioComposerAction
  /** 当前消息窗口的 canonical ID 集合；不存在锚点的任务不投影到会话尾部。 */
  messageIds?: string[]
}>()

// 年级 = agent metadata 的 k12.grade_term（后端 profile 契约）；K12 领域键只在 features/k12 解析
const grade = computed(() => props.metadata?.['k12.grade_term'] ?? '')
const textbook = computed(() => props.metadata?.['k12.textbook_edition'] ?? '')
const subjectTextbooks = computed(() => ({
  math: props.metadata?.['k12.textbook_edition.math'] || textbook.value,
  chinese: props.metadata?.['k12.textbook_edition.chinese'] || '',
  english: props.metadata?.['k12.textbook_edition.english'] || '',
  science: props.metadata?.['k12.textbook_edition.science'] || '',
  information_technology: props.metadata?.['k12.textbook_edition.information_technology'] || '',
  art: props.metadata?.['k12.textbook_edition.art'] || '',
}))
// 头部显示名：优先据 metadata 的孩子称呼派生「小明的辅导助手」（bug 修复：display_name 在辅导路径
// 可能为空、agentName 回退成内部 ID，头部就显示 ID）；无 child_name 时兜底 agentName。
const childName = computed(() => props.metadata?.['k12.child_name'] ?? '')
const headerName = computed(() =>
  childName.value ? t('k12.tutor.headerName', { child: childName.value }) : props.agentName,
)

const emit = defineEmits<{
  (e: 'update:recordsActive', v: boolean): void
  /** composer 预设 chips 上交 shell（数据流，替代旧 Teleport-锚点方案·BUG-20260709）：
   *  shell 透传给 ChatInput 在对话框盒内渲染，杜绝 defer/锚点顺序时序类反复回归。 */
  (e: 'update:composerChips', v: ScenarioComposerChip[]): void
  /** composer 图片消费完复位（BUG-20260709 拍照发题不解题） */
  (e: 'update:composerImage', v: string): void
  /** 会话内联槽是否有活动内容：shell 据此收起空会话占位并把新内容滚入可视区。 */
  (e: 'update:inlineActive', v: boolean): void
  (e: 'contentUpdated'): void
  /** 请求 shell 操作通用输入框；K12 文案不进入 ChatInput/ChatView。 */
  (e: 'composerCommand', command: ScenarioComposerCommand): void
  /** 失败任务显式重提：只上交原始图片事实；shell 负责新消息身份与当前路由冻结。 */
  (e: 'scenarioImageAttempt', payload: ScenarioComposerImagePayload): void
  (
    e: 'update:sessionExecution',
    payload: {
      sessionId: string
      executionId: string
      state: string
      automaticBudgetSeconds?: number
      automaticStartedAt?: number
      automaticDeadlineAt?: number
      operationDeadlineAt?: number
    },
  ): void
}>()

const { t } = useI18n()
const route = useRoute()

// IA 定稿（PRD §1.5，2026-07-18 迁移）：顶栏三段 辅导｜学习档案｜学情（学情=一等 Tab）。
const tab = ref<'chat' | 'records' | 'insights'>('chat')
const recordsNavigation = ref<K12RecordsNavigation>({ target: 'week', subject: '', status: 'all' })
function goRecords(destination: K12RecordsNavigation | K12RecordsTarget, subject = '') {
  recordsNavigation.value =
    typeof destination === 'string'
      ? { target: destination, subject, status: 'all' }
      : { ...destination }
  tab.value = 'records'
}
// descriptor.headerTabs 的 kind → 本地 tab 值（report=学情）。
function tabOfKind(kind: string): 'chat' | 'records' | 'insights' {
  if (kind === 'records') return 'records'
  if (kind === 'report') return 'insights'
  return 'chat'
}
function tabFromRoute(): 'chat' | 'records' | 'insights' {
  if (route.query.scenarioTab === 'records') return 'records'
  if (route.query.scenarioTab === 'insights') return 'insights'
  return 'chat'
}
function panelIdOfKind(kind: string): string {
  const target = tabOfKind(kind)
  return `k12-enh-view-${target}`
}
const backupOpen = ref(false)
interface TaskShellProjection {
  sourceMessageId: string
  restoreDispatchId?: string
  payload?: ScenarioComposerImagePayload
}
const taskShells = ref<TaskShellProjection[]>([])
const visibleTaskShells = computed(() => {
  if (!props.messageIds) return taskShells.value
  const visible = new Set(props.messageIds)
  return taskShells.value.filter((task) => visible.has(task.sourceMessageId))
})
function closeRecognize(task: TaskShellProjection) {
  taskShells.value = taskShells.value.filter(
    (candidate) =>
      candidate.sourceMessageId !== task.sourceMessageId ||
      candidate.restoreDispatchId !== task.restoreDispatchId,
  )
}
function retryRecognizeAsNewAttempt(task: TaskShellProjection) {
  if (!task.payload?.requestId?.trim()) return
  emit('scenarioImageAttempt', task.payload)
}

// 头部零硬编码动作按钮（20260709）：辅导要点已内联进识题流（识题确认后自动出「这份作业的辅导要点」），
// 头部只留身份 + [辅导|错题本] tab；识题=composer 拍照入口、渐进提示=辅导默认行为，均非头部动作。
// composer 预设 chips：从后端 view-descriptor 下发（AP-1：不在前端硬编码场景 chip）
const composerChips = ref<ScenarioComposerChip[]>([])

const SUBJECT_CAPABILITIES_ACTION = 'subject-capabilities'
type SubjectDemo = 'science' | 'informationTechnology' | 'art'
type CapabilityDialog =
  | { kind: 'subjects' }
  | { kind: 'subject-demo'; subject: Exclude<SubjectDemo, 'art'> }

const capabilityDialog = ref<CapabilityDialog | null>(null)
const capabilityDialogRef = ref<HTMLElement>()
let capabilityReturnFocus: HTMLElement | null = null

const subjectCapabilities = computed(() => [
  {
    key: 'math',
    label: t('k12.capabilities.subjects.math.label'),
    object: t('k12.capabilities.subjects.math.object'),
    assessment: t('k12.capabilities.subjects.math.assessment'),
  },
  {
    key: 'chinese',
    label: t('k12.capabilities.subjects.chinese.label'),
    object: t('k12.capabilities.subjects.chinese.object'),
    assessment: t('k12.capabilities.subjects.chinese.assessment'),
  },
  {
    key: 'english',
    label: t('k12.capabilities.subjects.english.label'),
    object: t('k12.capabilities.subjects.english.object'),
    assessment: t('k12.capabilities.subjects.english.assessment'),
  },
  {
    key: 'science',
    label: t('k12.capabilities.subjects.science.label'),
    object: t('k12.capabilities.subjects.science.object'),
    assessment: t('k12.capabilities.subjects.science.assessment'),
    demo: 'science' as const,
  },
  {
    key: 'informationTechnology',
    label: t('k12.capabilities.subjects.informationTechnology.label'),
    object: t('k12.capabilities.subjects.informationTechnology.object'),
    assessment: t('k12.capabilities.subjects.informationTechnology.assessment'),
    demo: 'informationTechnology' as const,
  },
  {
    key: 'art',
    label: t('k12.capabilities.subjects.art.label'),
    object: t('k12.capabilities.subjects.art.object'),
    assessment: t('k12.capabilities.subjects.art.assessment'),
    demo: 'art' as const,
  },
])

const capabilityTitle = computed(() => {
  if (capabilityDialog.value?.kind === 'subjects') return t('k12.capabilities.subjectTitle')
  const subject = capabilityDialog.value?.subject
  return subject
    ? t('k12.capabilities.demo.title', { subject: t(`k12.capabilities.subjects.${subject}.label`) })
    : ''
})

const capabilityPrimary = computed(() => {
  if (capabilityDialog.value?.kind === 'subjects') return t('k12.capabilities.subjectPrimary')
  return t('k12.capabilities.demo.primary')
})

function openCapabilityDialog(dialog: CapabilityDialog) {
  if (!capabilityDialog.value && document.activeElement instanceof HTMLElement) {
    capabilityReturnFocus = document.activeElement
  }
  capabilityDialog.value = dialog
  void nextTick(() => capabilityDialogRef.value?.focus())
}

function closeCapabilityDialog(restoreFocus = true) {
  const target = capabilityReturnFocus
  capabilityDialog.value = null
  capabilityReturnFocus = null
  if (restoreFocus && target?.isConnected) void nextTick(() => target.focus())
}

function openSubjectDemo(subject: SubjectDemo) {
  if (subject === 'art') {
    closeCapabilityDialog(false)
    goRecords('works')
    return
  }
  openCapabilityDialog({ kind: 'subject-demo', subject })
}

function runCapabilityPrimary() {
  const dialog = capabilityDialog.value
  if (!dialog) return
  if (dialog.kind === 'subjects') {
    closeCapabilityDialog(false)
    emit('composerCommand', { type: 'focus' })
    return
  }
  const subject = dialog.subject === 'science' ? '科学' : '信息科技'
  closeCapabilityDialog(false)
  goRecords('mistakes', subject)
}

function trapCapabilityFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !capabilityDialogRef.value) return
  const focusable = [
    ...capabilityDialogRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]),[href],input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ]
  if (!focusable.length) {
    event.preventDefault()
    capabilityDialogRef.value.focus()
    return
  }
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

// 深链（智能体卡快捷入口）：?scenarioTab=records|insights → 直接进学习档案/学情
onMounted(async () => {
  tab.value = tabFromRoute()
  try {
    const d = await k12GetViewDescriptor('tutor')
    composerChips.value = (d.composer_chips ?? []).map((label, index) => ({
      id: `k12-composer-chip-${index}`,
      label,
      ...(index === 0 ? { actionId: SUBJECT_CAPABILITIES_ACTION } : {}),
    }))
  } catch {
    // 描述符拉取失败静默（引擎未就绪），composer chips 缺省不显
  }
})

// 学习档案与学情都接管消息区（外壳据 recordsActive 隐藏原生消息/输入）。
watch(tab, (v) => emit('update:recordsActive', v !== 'chat'), { immediate: true })
watch(
  [visibleTaskShells, tab],
  ([tasks, currentTab]) => {
    emit('update:inlineActive', tasks.length > 0 && currentTab === 'chat')
  },
  { immediate: true },
)
// chips 数据流上交（辅导 tab 才显示；records tab 输入区本就隐藏，上交空数组保持状态干净）
watch(
  [composerChips, tab],
  () => {
    emit('update:composerChips', tab.value === 'chat' ? composerChips.value : [])
  },
  { immediate: true },
)
watch(
  () => props.composerAction,
  (action) => {
    if (action?.id === SUBJECT_CAPABILITIES_ACTION) openCapabilityDialog({ kind: 'subjects' })
  },
  { immediate: true },
)
// 切换实例（多孩）→ 清掉上一个孩子的所有局部 UI 状态；子视图 key 负责同步重建。
watch(
  () => props.agentId,
  () => {
    tab.value = tabFromRoute()
    recordsNavigation.value = { target: 'week', subject: '', status: 'all' }
    taskShells.value = []
    backupOpen.value = false
    closeCapabilityDialog(false)
    emit('update:composerImage', '')
  },
)
// 刷新/重启后只在同一 session+agent 存在最小 Job 绑定时恢复原会话位置；
// 不从图片、题目或显示名猜测，也不把另一孩子的 Job 投影进来。
watch(
  [() => props.sessionId, () => props.agentId],
  ([sessionId, agentId]) => {
    const recoverable = listImageTaskBindings(sessionId, agentId)
    if (recoverable.length) {
      tab.value = 'chat'
    }
    taskShells.value = recoverable.map((binding) => ({
      sourceMessageId: binding.sourceMessageId!,
      restoreDispatchId: binding.dispatchId,
    }))
  },
  { immediate: true },
)
watch(
  () => route.query.scenarioTab,
  () => {
    tab.value = tabFromRoute()
  },
)

// composer 改道图片 → 自动打开识题护栏并识题（BUG-20260709 拍照发题不解题：
// 原型契约「输入框上传/粘贴作业照片即自动 OCR 回显护栏」）。图片交给护栏后立刻上报复位。
watch(
  () => props.composerImage,
  (img) => {
    if (!img) return
    // shell 注入的图片 attempt 具有会话所有权；同一 Agent 的其他会话也无权消费。
    // 没有持久消息身份就不存在合法锚点；旧 string 边界严格不再创建游离 TaskShell。
    if (
      typeof img === 'string' ||
      !img.requestId?.trim() ||
      (img.sourceSessionId && img.sourceSessionId !== props.sessionId)
    ) {
      emit('update:composerImage', '')
      return
    }
    const dataUrl = img.dataUrl
    if (!dataUrl) return
    tab.value = 'chat'
    const sourceMessageId = img.requestId.trim()
    if (!taskShells.value.some((task) => task.sourceMessageId === sourceMessageId)) {
      taskShells.value = [...taskShells.value, { sourceMessageId, payload: img }]
    }
    emit('update:composerImage', '')
  },
  { immediate: true },
)
</script>

<template>
  <!-- ① 头部槽：身份（单行截断防长名竖排断行·D2）+ 子视图 tab。
       当前 descriptor.actions 为空，头部没有场景动作；识题只走 composer 拍照入口，辅导要点只在
       RecognizeGuardPanel 持久确认后内联展示，不存在 shell 侧栏或锚点。 -->
  <div class="k12enh-tabs">
    <div class="k12enh-id">
      <span class="k12enh-av">🎓</span>
      <span class="k12enh-name" :title="headerName">{{ headerName }}</span>
      <span v-if="grade" class="k12enh-grade">{{ grade }}</span>
    </div>
    <div class="k12enh-seg" role="tablist" aria-label="辅导助手功能">
      <button
        v-for="ht in descriptor.headerTabs"
        :id="`k12-enh-tab-${ht.id}`"
        :key="ht.id"
        :class="{ on: tab === tabOfKind(ht.kind) }"
        role="tab"
        :aria-selected="tab === tabOfKind(ht.kind)"
        :aria-controls="panelIdOfKind(ht.kind)"
        :tabindex="tab === tabOfKind(ht.kind) ? 0 : -1"
        @click="tab = tabOfKind(ht.kind)"
      >
        {{ t(ht.labelKey) }}
      </button>
    </div>
  </div>

  <div
    id="k12-enh-view-chat"
    v-show="tab === 'chat'"
    class="k12enh-chat-panel"
    role="tabpanel"
    aria-labelledby="k12-enh-tab-chat"
  >
    <!-- 拍照识题回显护栏面板（辅导 tab）：**唯一入口=composer 粘贴/上传图片自动改道**
       （原型 app.html:1316「零手动按钮」，BUG-20260711-E 删除了手动相机 toggle——禁止加回）。
       识题走独立 OCR 管道不依赖聊天模型 vision；面板头部 ✕ 收起。
       tab 用 v-show 保活（BUG-20260712-S）：v-if 会在切错题本时销毁面板 → 切回重挂载
       重新识题（丢已识结果+重复慢调用）+ 在途 tutoring-tips fetch 被 abort 且错误漏到错题本页。 -->
    <Teleport
      v-for="task in visibleTaskShells"
      :key="`${task.sourceMessageId}:${task.restoreDispatchId || 'new'}`"
      defer
      :to="`#${scenarioMessageAnchorId(task.sourceMessageId)}`"
    >
      <div
        v-show="tab === 'chat'"
        class="k12enh-tutor"
        data-testid="k12-photo-assistant-message"
        :data-source-message-id="task.sourceMessageId"
        :data-dispatch-id="task.restoreDispatchId || undefined"
      >
        <div class="k12enh-tutor__avatar">
          <img :src="crabLogo" alt="" />
          <span />
        </div>
        <div class="k12enh-tutor__body">
          <div class="k12enh-tutor__name">{{ headerName }}</div>
          <div class="k12enh-tutor__bubble">
            <!-- agent-id=内部名（隔离键）——审计单-High-2：曾传 display name 写错孩子作用域 -->
            <RecognizeGuardPanel
              :key="`${agentId}:${sessionId || ''}:${task.sourceMessageId}:${task.restoreDispatchId || 'new'}`"
              :agent-id="agentId"
              :agent-display-name="headerName"
              :session-id="sessionId"
              :grade="grade"
              :textbook="textbook"
              :textbooks="subjectTextbooks"
              :initial-image="task.payload?.dataUrl || ''"
              :request-id="task.sourceMessageId"
              :source-message-id="task.sourceMessageId"
              :restore-dispatch-id="task.restoreDispatchId"
              :model-route="task.payload?.route"
              :display-provider="task.payload?.route?.provider || modelRoute?.provider"
              :display-model="task.payload?.route?.model || modelRoute?.model"
              :message-intent="task.payload?.contextText?.trim() || ''"
              @close="closeRecognize(task)"
              @retry="retryRecognizeAsNewAttempt(task)"
              @content-updated="emit('contentUpdated')"
              @update:execution-state="emit('update:sessionExecution', $event)"
            />
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 辅导要点只在 RecognizeGuardPanel 识题持久确认后内联展示。 -->

  </div>

  <!-- composer 预设 chips（后端 descriptor 下发，对齐原型 .composer-chips）：
       BUG-20260709 起不再 Teleport 到 composer 上方锚点（浮动行不在对话框内 + defer/锚点时序反复回归），
       改为 update:composerChips 数据流上交 shell → ChatInput 在对话框盒内渲染（见 emits + watch）。 -->

  <!-- ⚠️ 识题**没有**手动按钮（BUG-20260711-E 删除，原型 app.html:1316「零手动按钮」拍板）：
       识题唯一入口 = composer 粘贴/上传作业照片自动改道（scenarioImageIntercept → composerImage
       watch → 护栏自动 run）。给未来维护者（含 AI）：不要因为看到护栏面板就往输入行加回
       相机/识题 toggle——那是已定案删除的漂移，回归锁在 bug-20260711-composer-drift-lock.test.ts。 -->

  <!-- 学习档案视图（五对象：本周复习/全部错题/练习集/积累/作品）：接管消息区 -->
  <div
    id="k12-enh-view-records"
    v-show="tab === 'records'"
    class="k12enh-records"
    role="tabpanel"
    aria-labelledby="k12-enh-tab-records"
  >
    <K12RecordsView
      :key="agentId"
      :agent-id="agentId"
      :agent-name="agentName"
      :grade="grade"
      :textbook="textbook"
      :model-route="modelRoute"
      :active="tab === 'records'"
      :target="recordsNavigation.target"
      :subject="recordsNavigation.subject"
      :status="recordsNavigation.status"
      :navigation="recordsNavigation"
      @go-tutor="tab = 'chat'"
      @go-insights="tab = 'insights'"
      @open-backup="backupOpen = true"
    />
  </div>

  <!-- 学情视图（IA 定稿：顶栏一等 Tab，PRD §3.11）：接管消息区。
       navigate=学情路由器出口（瓷片/薄弱条/挫败 CTA）→ 直达对应学习档案对象。 -->
  <div
    id="k12-enh-view-insights"
    v-show="tab === 'insights'"
    class="k12enh-records"
    role="tabpanel"
    aria-labelledby="k12-enh-tab-insights"
  >
    <K12InsightPanel
      :key="agentId"
      :agent-id="agentId"
      :grade="grade || undefined"
      @navigate="goRecords"
    />
  </div>

  <!-- 备份 / 恢复弹窗（M4-1） -->
  <K12BackupModal
    v-if="backupOpen"
    :agent-id="agentId"
    :agent-name="agentName"
    :target-child-name="childName || agentName"
    @close="backupOpen = false"
  />

  <!-- app.html openK12SubjectCapabilities/openK12GeneralCapabilities 的场景内实现。
       shell 只传 actionId/执行 composer command；全部 K12 内容与状态留在 feature 包。 -->
  <Teleport v-if="capabilityDialog" to="body">
    <div class="k12cap-overlay" @click.self="closeCapabilityDialog()">
      <div
        ref="capabilityDialogRef"
        class="k12cap-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="k12-capability-title"
        tabindex="-1"
        data-testid="k12-capability-dialog"
        @keydown.esc.stop.prevent="closeCapabilityDialog()"
        @keydown.tab="trapCapabilityFocus"
      >
        <div class="k12cap-modal__head">
          <b id="k12-capability-title">{{ capabilityTitle }}</b>
          <button
            type="button"
            class="k12cap-modal__close"
            :aria-label="t('k12.capabilities.close')"
            data-testid="k12-capability-close"
            @click="closeCapabilityDialog()"
          >
            ✕
          </button>
        </div>

        <div class="k12cap-modal__body">
          <template v-if="capabilityDialog.kind === 'subjects'">
            <div class="k12cap-notice">
              <b>{{ t('k12.capabilities.subjectNoticeLead') }}</b
              ><br />
              {{ t('k12.capabilities.subjectNoticeDetail') }}
            </div>
            <div class="k12cap-list k12cap-list--subjects">
              <div
                v-for="subject in subjectCapabilities"
                :key="subject.key"
                class="k12cap-row"
                data-testid="k12-subject-capability"
              >
                <b>{{ subject.label }}</b>
                <span>{{ subject.object }} · {{ subject.assessment }}</span>
                <button
                  v-if="subject.demo"
                  type="button"
                  class="k12cap-btn k12cap-btn--ghost"
                  data-testid="k12-subject-demo"
                  @click="openSubjectDemo(subject.demo)"
                >
                  {{ t('k12.capabilities.viewDemo') }}
                </button>
              </div>
            </div>
            <p class="k12cap-note">{{ t('k12.capabilities.subjectVerificationNote') }}</p>
          </template>

          <template v-else-if="capabilityDialog.kind === 'subject-demo'">
            <div class="k12cap-notice">
              <b>{{ t(`k12.capabilities.demo.${capabilityDialog.subject}.noticeLabel`) }}</b
              >{{ t(`k12.capabilities.demo.${capabilityDialog.subject}.notice`) }}
            </div>
            <div class="k12cap-list">
              <div v-for="row in ['evidence', 'basis', 'practice']" :key="row" class="k12cap-row">
                <b>{{ t(`k12.capabilities.demo.rows.${row}`) }}</b>
                <span>{{ t(`k12.capabilities.demo.${capabilityDialog.subject}.${row}`) }}</span>
              </div>
            </div>
          </template>

        </div>

        <div class="k12cap-modal__foot">
          <button type="button" class="k12cap-btn" @click="closeCapabilityDialog()">
            {{ t('k12.capabilities.close') }}
          </button>
          <button
            type="button"
            class="k12cap-btn k12cap-btn--primary"
            data-testid="k12-capability-primary"
            @click="runCapabilityPrimary"
          >
            {{ capabilityPrimary }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 当前不存在辅导要点 shell 侧栏或锚点。 -->
</template>

<style scoped>
.k12enh-tabs {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 11px 16px;
  border-bottom: 0.5px solid var(--hc-border);
  flex-shrink: 0;
}
/* 身份块：单行截断防长名竖排断行（D2·BUG-20260708）。flex:1 min-width:0 让名字 ellipsis、把 tab/动作挤到右侧 */
.k12enh-id {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.k12enh-av {
  font-size: 16px;
  flex-shrink: 0;
}
.k12enh-name {
  font-size: 13.5px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.k12enh-grade {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 7px;
  flex-shrink: 0;
  white-space: nowrap;
  background: rgba(50, 213, 131, 0.14);
  color: var(--hc-success);
}
.k12enh-seg {
  display: inline-flex;
  min-width: 0;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--hc-bg-input);
  border: 1px solid var(--hc-border);
  border-radius: 11px;
  padding: 3px;
  gap: 2px;
}
.k12enh-seg button {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--hc-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
}
.k12enh-seg button:hover:not(.on) {
  color: var(--hc-text-secondary);
}
.k12enh-seg button.on {
  background: var(--hc-bg-elevated);
  color: var(--hc-accent);
  box-shadow:
    var(--hc-shadow-sm),
    inset 0 0 0 0.5px var(--hc-border);
  font-weight: 600;
}
.k12enh-chat-panel {
  display: contents;
}
/* 手动识题按钮样式已随入口删除退役（BUG-20260711-E：识题唯一入口=图片自动改道）。 */
/* composer 预设 chips 样式已随 Teleport 方案退役（BUG-20260709）：
   胶囊渲染归 ChatInput（.hc-composer__skill-chip，对齐原型 .composer-chip），本组件只上交数据。 */
/* 渐进提示辅导面板（辅导 tab 内嵌，可开合） */
.k12enh-tutor {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 0 8px;
}
.k12enh-tutor__avatar {
  position: relative;
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
}
.k12enh-tutor__avatar img {
  display: block;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}
.k12enh-tutor__avatar span {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--hc-bg-main);
  border-radius: 50%;
  background: var(--hc-success);
}
.k12enh-tutor__body {
  min-width: 0;
  max-width: min(92%, 980px);
}
.k12enh-tutor__name {
  margin: 0 0 4px 2px;
  color: var(--hc-text-secondary);
  font-size: 12px;
  font-weight: 500;
}
.k12enh-tutor__bubble {
  border-radius: 4px 14px 14px 14px;
  background: var(--hc-bg-card);
  color: var(--hc-text-primary);
}

/* 能力弹窗 1:1 复用 app.html 的 overlay/modal/resource-list 几何与视觉令牌。 */
.k12cap-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 11vh;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
  animation: k12cap-fade 0.2s var(--hc-ease-out);
}
.k12cap-modal {
  width: 478px;
  max-width: 92vw;
  overflow: hidden;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
  color: var(--hc-text-primary);
  animation: k12cap-pop 0.32s var(--hc-ease-out);
  outline: none;
}
.k12cap-modal__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
}
.k12cap-modal__head b {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.k12cap-modal__close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}
.k12cap-modal__close:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12cap-modal__body {
  max-height: 62vh;
  padding: 18px;
  overflow: auto;
}
.k12cap-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}
.k12cap-notice {
  margin-bottom: 10px;
  padding: 11px 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}
.k12cap-notice b {
  color: var(--hc-text-primary);
}
.k12cap-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.k12cap-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.k12cap-row > b {
  min-width: 0;
  color: var(--hc-text-primary);
}
.k12cap-row > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12cap-list--subjects .k12cap-row > b {
  flex: 0 0 68px;
  text-align: center;
}
.k12cap-note {
  margin: 8px 0 0;
  color: var(--hc-text-muted);
  font-size: 10.5px;
}
.k12cap-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.15s var(--hc-ease-out),
    box-shadow 0.2s var(--hc-ease-out),
    transform 0.12s var(--hc-ease-out),
    border-color 0.15s var(--hc-ease-out);
}
.k12cap-btn:hover {
  background: var(--hc-bg-hover);
}
.k12cap-btn:active {
  transform: scale(0.97);
}
.k12cap-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.k12cap-btn--ghost {
  flex: none;
  padding: 6px 8px;
  border-color: transparent;
  background: transparent;
  color: var(--hc-text-secondary);
  box-shadow: none;
}
.k12cap-btn--ghost:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
  transform: none;
}
.k12cap-btn--primary {
  border-color: transparent;
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  box-shadow: 0 6px 18px rgba(95, 179, 234, 0.28);
}
.k12cap-btn--primary:hover {
  background: linear-gradient(180deg, #67b8ec 0%, #4f9fe1 100%);
  box-shadow: 0 10px 26px rgba(95, 179, 234, 0.34);
  transform: translateY(-1px);
}
@keyframes k12cap-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes k12cap-pop {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 记录视图接管消息区（外壳隐藏原生消息区后，本层 flex:1 填满） */
.k12enh-records {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 辅导要点只在 RecognizeGuardPanel 内联；本组件没有对应 shell 侧栏定位样式。 */
</style>
