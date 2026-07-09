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
}>()

// 年级 = agent metadata 的 k12.grade_term（后端 profile 契约）；K12 领域键只在 features/k12 解析
const grade = computed(() => props.metadata?.['k12.grade_term'] ?? '')
// 头部显示名：优先据 metadata 的孩子称呼派生「小明的辅导助手」（bug 修复：display_name 在辅导路径
// 可能为空、agentName 回退成内部 ID，头部就显示 ID）；无 child_name 时兜底 agentName。
const childName = computed(() => props.metadata?.['k12.child_name'] ?? '')
const headerName = computed(() =>
  childName.value ? t('k12.tutor.headerName', { child: childName.value }) : props.agentName,
)

const emit = defineEmits<{ (e: 'update:recordsActive', v: boolean): void }>()

const { t } = useI18n()
const route = useRoute()

const tab = ref<'chat' | 'records'>('chat')
const recognizeOpen = ref(false)
const backupOpen = ref(false)

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
// 切换实例（多孩）→ 回到辅导 tab，避免带着上一个孩子的记录视图（M3-9 结构隔离）
watch(() => props.agentId, () => { tab.value = 'chat' })
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

  <!-- 拍照识题回显护栏面板（辅导 tab，由下方 composer 拍照入口开合；识题走独立 OCR 管道不依赖聊天模型 vision） -->
  <div v-if="tab === 'chat' && recognizeOpen" class="k12enh-tutor">
    <!-- agent-id=内部名（隔离键）——审计单-High-2：曾传 display name 写错孩子作用域 -->
    <RecognizeGuardPanel :agent-id="agentId" :grade="grade" />
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

  <!-- composer 上方槽（辅导 tab，Teleport 到 composer 上方锚点；同上 defer）：
       ① 拍照识题入口——识题从头部移到输入框附近（识题=通用输入框上传作业照片的自然动作，走独立 OCR
          管道，不依赖聊天模型 vision，故 qwen3.5:9b 也能用）；
       ② 后端 descriptor 下发的预设 chips。 -->
  <!-- composer 上方槽：仅后端 descriptor 下发的能力 chips（= 该助手默认加载的核心 skill 预览，informational，
       对齐原型 3-chip）。识题入口不在此,已下沉到输入行相机按钮（见下方 Teleport），对齐原型 composer 拍照入口。 -->
  <Teleport v-if="tab === 'chat' && composerChips.length" defer to="#hc-chat-scenario-composer-top">
    <div class="k12enh-chips" data-testid="k12-composer-chips">
      <span v-for="c in composerChips" :key="c" class="k12enh-chip">{{ c }}</span>
    </div>
  </Teleport>

  <!-- 拍照识题入口：Teleport 到输入行动作锚点,与 +/技能/prompt/麦 同排（原型 composer「上传作业照片」相机
       ci-btn）。点击开合识题回显护栏（走独立 OCR 管道，不依赖聊天模型 vision）。 -->
  <Teleport v-if="tab === 'chat'" defer to="#hc-chat-scenario-composer-actions">
    <button
      class="k12enh-recbtn"
      data-testid="k12-recognize-toggle"
      :class="{ 'k12enh-recbtn--on': recognizeOpen }"
      :title="t('k12.recognize.run')"
      @click="recognizeOpen = !recognizeOpen"
    ><svg class="k12enh-ic" viewBox="0 0 24 24"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></svg></button>
  </Teleport>

  <!-- 记录视图（错题本 tab）：接管消息区（外壳据 recordsActive 隐藏原生消息/输入） -->
  <div v-show="tab === 'records'" class="k12enh-records">
    <K12RecordsView
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
/* composer 上方槽：拍照识题入口 + 预设 chips（识题从头部移到输入框附近·D1） */
/* 拍照识题：输入行图标工具按钮（与 ChatInput 的 .hc-composer__tool 同款尺寸/手感，行内一排）。 */
.k12enh-recbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px; font-size: 16px; line-height: 1;
  border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}
.k12enh-recbtn:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12enh-recbtn--on { background: var(--hc-accent-subtle); color: var(--hc-accent); }
/* composer 能力预览（informational）：20260709 视觉评审——去 chip 描边/底色。它们不可点，
   长着按钮样子=affordance 撒谎；改为安静的说明行（· 分隔），不再暗示可交互。 */
.k12enh-chips { display: flex; gap: 4px; flex-wrap: wrap; margin: 0 16px 8px; }
.k12enh-chip { display: inline-flex; align-items: center; font-size: 11.5px; color: var(--hc-text-muted); }
.k12enh-chip + .k12enh-chip::before { content: '·'; margin-right: 4px; color: var(--hc-text-muted); }
/* 输入行相机图标（单色描边，与 ChatInput 工具按钮同规格） */
.k12enh-ic { width: 17px; height: 17px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
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
