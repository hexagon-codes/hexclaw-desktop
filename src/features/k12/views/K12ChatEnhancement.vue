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
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { k12GetViewDescriptor } from '@/api/k12'
import type { InstanceViewDescriptor } from '@/contracts'
import K12RecordsView from './K12RecordsView.vue'
import K12BackupModal from './K12BackupModal.vue'
import RecognizeGuardPanel from './RecognizeGuardPanel.vue'

const props = defineProps<{
  agentId: string
  agentName: string
  /** 通用 metadata（ChatView 透传）；年级由本组件解析后端 profile 键 k12.grade_term */
  metadata?: Record<string, string>
  descriptor: InstanceViewDescriptor
  /** composer 改道进来的图片 dataURL（BUG-20260709 拍照发题不解题）：
   *  外壳把 ChatInput 拦下的粘贴/上传图片经此传入 → 自动打开识题护栏并识题；
   *  消费后 emit update:composerImage('') 复位，避免重复触发。通用 prop，零 shell 领域词。 */
  composerImage?: string
}>()

// 年级 = agent metadata 的 k12.grade_term（后端 profile 契约）；K12 领域键只在 features/k12 解析
const grade = computed(() => props.metadata?.['k12.grade_term'] ?? '')
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
  (e: 'update:composerChips', v: string[]): void
  /** composer 图片消费完复位（BUG-20260709 拍照发题不解题） */
  (e: 'update:composerImage', v: string): void
}>()

const { t } = useI18n()
const route = useRoute()

const tab = ref<'chat' | 'records'>('chat')
const recognizeOpen = ref(false)
const backupOpen = ref(false)
const pendingRecognizeImage = ref('')

// 头部零硬编码动作按钮（20260709）：备课卡已内联进识题流（识题确认后自动出「这份作业的辅导要点」），
// 头部只留身份 + [辅导|错题本] tab；识题=composer 拍照入口、渐进提示=辅导默认行为，均非头部动作。
// composer 预设 chips：从后端 view-descriptor 下发（AP-1：不在前端硬编码场景 chip）
const composerChips = ref<string[]>([])

// 深链（智能体卡快捷入口）：?scenarioTab=records → 直接进错题本（备课卡入口已取消，辅导要点内联进识题流）
onMounted(async () => {
  if (route.query.scenarioTab === 'records') tab.value = 'records'
  try {
    const d = await k12GetViewDescriptor('tutor')
    composerChips.value = d.composer_chips ?? []
  } catch {
    // 描述符拉取失败静默（引擎未就绪），composer chips 缺省不显
  }
})

watch(tab, (v) => emit('update:recordsActive', v === 'records'), { immediate: true })
// chips 数据流上交（辅导 tab 才显示；records tab 输入区本就隐藏，上交空数组保持状态干净）
watch([composerChips, tab], () => {
  emit('update:composerChips', tab.value === 'chat' ? composerChips.value : [])
}, { immediate: true })
// 切换实例（多孩）→ 清掉上一个孩子的所有局部 UI 状态；子视图 key 负责同步重建。
watch(() => props.agentId, () => {
  tab.value = 'chat'
  recognizeOpen.value = false
  backupOpen.value = false
  pendingRecognizeImage.value = ''
  emit('update:composerImage', '')
})

// composer 改道图片 → 自动打开识题护栏并识题（BUG-20260709 拍照发题不解题：
// 原型契约「输入框上传/粘贴作业照片即自动 OCR 回显护栏」）。图片交给护栏后立刻上报复位。
watch(() => props.composerImage, (img) => {
  if (!img) return
  tab.value = 'chat'
  recognizeOpen.value = true
  pendingRecognizeImage.value = img
  emit('update:composerImage', '')
}, { immediate: true })
</script>

<template>
  <!-- ① 头部槽：身份（单行截断防长名竖排断行·D2）+ 子视图 tab + 头部动作（**descriptor 声明式**·D1/根治）。
       头部动作只渲染 descriptor.actions 里 placement=header 的（=备课卡），组件内**零硬编码按钮**——
       想加头部控件只能改 descriptor（对着原型评审），杜绝识题/渐进提示这类硬编码旁路复漂移。
       识题=走 composer 拍照入口（独立 OCR 管道，见下方 Teleport）；渐进提示=辅导默认行为（人设+chip），
       二者都不是头部动作，故不在此。 -->
  <div class="k12enh-tabs">
    <div class="k12enh-id">
      <span class="k12enh-av">🎓</span>
      <span class="k12enh-name" :title="headerName">{{ headerName }}</span>
      <span v-if="grade" class="k12enh-grade">{{ grade }}</span>
    </div>
    <div class="k12enh-seg">
      <button
        v-for="ht in descriptor.headerTabs"
        :key="ht.id"
        :class="{ on: tab === (ht.kind === 'records' ? 'records' : 'chat') }"
        @click="tab = ht.kind === 'records' ? 'records' : 'chat'"
      >
        {{ t(ht.labelKey) }}
      </button>
    </div>
  </div>

  <!-- 拍照识题回显护栏面板（辅导 tab）：**唯一入口=composer 粘贴/上传图片自动改道**
       （原型 app.html:1316「零手动按钮」，BUG-20260711-E 删除了手动相机 toggle——禁止加回）。
       识题走独立 OCR 管道不依赖聊天模型 vision；面板头部 ✕ 收起。 -->
  <div v-if="tab === 'chat' && recognizeOpen" class="k12enh-tutor">
    <!-- agent-id=内部名（隔离键）——审计单-High-2：曾传 display name 写错孩子作用域 -->
    <RecognizeGuardPanel
      :key="agentId"
      :agent-id="agentId"
      :grade="grade"
      :initial-image="pendingRecognizeImage"
      @close="recognizeOpen = false; pendingRecognizeImage = ''"
    />
  </div>

  <!-- 20260709：删「先花 3 分钟备课」nudge 条。家长辅导是临场的，主动引导改为拍照识题（下方相机入口），
       备课内容改为识题确认后由 RecognizeGuardPanel 内联出「这份作业的辅导要点」。 -->

  <!-- K12→通用扩展桥（辅导 tab，Teleport 到会话页脚；兑现「通用留存」）。
       defer：本增强组件在 ChatView 里渲染在锚点 div 之前（ChatView ~1815 vs 锚点 2344），
       无 defer 时同步 Teleport 抢在锚点渲染前定位 → "Failed to locate Teleport target"、桥接丢失
       （BUG-20260708）。Vue 3.5 defer 把 target 解析延到父树挂载后，此时锚点已在 DOM。 -->
  <!-- 20260709 视觉评审：删「看看还能做什么›」假链接（可点样式点了只弹 toast=placebo，信任微损）。
       可操作示例并进正文一句话，无链接不撒谎。 -->
  <Teleport v-if="tab === 'chat'" defer to="#hc-chat-scenario-footer">
    <div class="k12enh-bridge">{{ t('k12.bridge.text') }}</div>
  </Teleport>

  <!-- composer 预设 chips（后端 descriptor 下发，对齐原型 .composer-chips）：
       BUG-20260709 起不再 Teleport 到 composer 上方锚点（浮动行不在对话框内 + defer/锚点时序反复回归），
       改为 update:composerChips 数据流上交 shell → ChatInput 在对话框盒内渲染（见 emits + watch）。 -->

  <!-- ⚠️ 识题**没有**手动按钮（BUG-20260711-E 删除，原型 app.html:1316「零手动按钮」拍板）：
       识题唯一入口 = composer 粘贴/上传作业照片自动改道（scenarioImageIntercept → composerImage
       watch → 护栏自动 run）。给未来维护者（含 AI）：不要因为看到护栏面板就往输入行加回
       相机/识题 toggle——那是已定案删除的漂移，回归锁在 bug-20260711-composer-drift-lock.test.ts。 -->

  <!-- 记录视图（错题本 tab）：接管消息区（外壳据 recordsActive 隐藏原生消息/输入） -->
  <div v-show="tab === 'records'" class="k12enh-records">
    <K12RecordsView
      :key="agentId"
      :agent-id="agentId"
      :agent-name="agentName"
      :grade="grade"
      @go-tutor="tab = 'chat'"
      @open-backup="backupOpen = true"
    />
  </div>

  <!-- 备份 / 恢复弹窗（M4-1） -->
  <K12BackupModal v-if="backupOpen" :agent-id="agentId" :agent-name="agentName" @close="backupOpen = false" />

  <!-- 20260709：备课卡专用侧栏已退役。「这份作业的辅导要点」改为 RecognizeGuardPanel 识题结果下方内联
       渲染（PrepCardPanel 已改为内联卡），不再经 shell 侧栏锚点停靠。 -->
</template>

<style scoped>
.k12enh-tabs {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 14px;
  border-bottom: 0.5px solid var(--hc-border);
  flex-shrink: 0;
}
/* 身份块：单行截断防长名竖排断行（D2·BUG-20260708）。flex:1 min-width:0 让名字 ellipsis、把 tab/动作挤到右侧 */
.k12enh-id { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; overflow: hidden; }
.k12enh-av { font-size: 16px; flex-shrink: 0; }
.k12enh-name {
  font-size: 13.5px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.k12enh-grade {
  font-size: 12px; padding: 3px 9px; border-radius: 7px; flex-shrink: 0; white-space: nowrap;
  background: rgba(50, 213, 131, 0.14); color: var(--hc-success);
}
.k12enh-seg {
  display: inline-flex; background: var(--hc-bg-input); border: 1px solid var(--hc-border);
  border-radius: 11px; padding: 3px; gap: 2px;
}
.k12enh-seg button {
  padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 500;
  color: var(--hc-text-muted); background: transparent; border: none; cursor: pointer;
}
.k12enh-seg button.on {
  background: var(--hc-bg-elevated); color: var(--hc-accent); box-shadow: var(--hc-shadow-sm); font-weight: 600;
}
/* 扩展桥（Teleport 到会话页脚） */
.k12enh-bridge {
  text-align: center; margin: 0 16px 12px; font-size: 11.5px; color: var(--hc-text-muted);
}
/* 手动识题按钮样式已随入口删除退役（BUG-20260711-E：识题唯一入口=图片自动改道）。 */
/* composer 预设 chips 样式已随 Teleport 方案退役（BUG-20260709）：
   胶囊渲染归 ChatInput（.hc-composer__skill-chip，对齐原型 .composer-chip），本组件只上交数据。 */
/* 渐进提示辅导面板（辅导 tab 内嵌，可开合） */
.k12enh-tutor {
  margin: 0 16px 8px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-md);
  background: var(--hc-bg-elevated);
  flex-shrink: 0;
}
/* 记录视图接管消息区（外壳隐藏原生消息区后，本层 flex:1 填满） */
.k12enh-records {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 备课卡侧栏现经 Teleport 挂到 `.hc-chat` 行级锚点作停靠面板（见 template），此处无需定位样式。 */
</style>
