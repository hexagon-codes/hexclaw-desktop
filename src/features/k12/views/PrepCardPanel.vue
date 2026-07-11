<script setup lang="ts">
/**
 * 「这份作业的辅导要点」内联卡（features/k12）· 20260709 最优雅形态（原「家长备课卡」侧栏去侧栏化）。
 *
 * 设计翻转：家长辅导是临场的——先看到作业才知怎么教，事前"备课"是逆链路的教师心智。故取消独立侧栏 +
 * nudge + 头部按钮，改为**识题确认后由 RecognizeGuardPanel 内联渲染**，用识题识别出的**真实知识点**
 * 绑定当前作业（不再是科目级泛化）。只读聚合 + 来源标注：source_label 由后端直出
 * （📖 依据课本 / 🗂 本地记录 / ✅ 已程序验算 / 🧠 学情信号 / 🤖 AI 归纳·供参考）——无验算保护段落用来源
 * 徽章替代信任兜底（AP-5）。事件驱动生成（识题给出知识点即生成，非每日 cron）。
 */
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { useToast } from '@/composables/useToast'
import { useK12Store } from '../store'
import { printPrepCard, prepCardToText } from '../export'

const props = defineProps<{
  /** 隔离键 = agents.name（与 recognize/grade 同键） */
  agentId: string
  grade: string
  /** 识题识别出的真实知识点（绑定当前作业）；非空即生成 */
  knowledgePoints: string[]
}>()

const { t } = useI18n()
const toast = useToast()
const store = useK12Store()

// 识题给出知识点即生成辅导要点（绑定当前作业）；知识点变化重拉。
watch(
  () => props.knowledgePoints,
  (kps) => {
    if (props.agentId && kps && kps.length) store.loadPrepCard(props.agentId, props.grade, kps)
  },
  { immediate: true, deep: true },
)

/** AI 归纳段落用告警色徽章（未校验），其余用 accent（本地记录/课本/验算） */
function isWeakSource(label: string): boolean {
  return label.includes('AI')
}

const prepMeta = () => ({ title: t('k12.prep.title'), gradeLabel: props.grade })

// 打印辅导要点（真打印，隐藏 iframe → 打印对话框；无内容时提示先生成）
function doPrint() {
  if (!store.prepCard) {
    toast.info(t('k12.prep.empty'))
    return
  }
  printPrepCard(store.prepCard, prepMeta())
}

// 发到手机：后端无出网推送端点，故用真实客户端动作——复制文本到剪贴板，家长粘贴发到手机 IM。
async function doSendPhone() {
  if (!store.prepCard) {
    toast.info(t('k12.prep.empty'))
    return
  }
  try {
    await navigator.clipboard.writeText(prepCardToText(store.prepCard, prepMeta()))
    toast.success(t('k12.prep.copied'))
  } catch {
    toast.error(t('k12.prep.copyFailed'))
  }
}
</script>

<template>
  <section class="tutor-guide" data-testid="tutor-guide" aria-label="这份作业的辅导要点">
    <div class="tutor-guide__head">
      <b>📋 {{ t('k12.prep.title') }}</b>
      <div class="tutor-guide__actions">
        <button class="icbtn" :title="t('k12.prep.sendPhone')" data-testid="prep-send" @click="doSendPhone">📱</button>
        <button class="icbtn" :title="t('k12.prep.print')" data-testid="prep-print" @click="doPrint">🖨</button>
      </div>
    </div>

    <div class="tutor-guide__body">
      <p v-if="store.loading" class="tutor-guide__hint">{{ t('k12.prep.generating') }}</p>

      <template v-else-if="store.prepCard">
        <div v-for="(s, i) in store.prepCard.sections" :key="i" class="tutor-section">
          <h5 class="tutor-section__title">
            {{ s.title }}
            <span
              v-if="s.source_label"
              class="tutor-badge"
              :class="{ 'tutor-badge--weak': isWeakSource(s.source_label) }"
              >{{ s.source_label }}</span
            >
          </h5>
          <MarkdownRenderer :content="s.content" />
        </div>
        <p class="tutor-guide__legend">{{ t('k12.prep.legend') }}</p>
      </template>

      <p v-else class="tutor-guide__hint">{{ t('k12.prep.empty') }}</p>
    </div>
  </section>
</template>

<style scoped>
/* 内联卡（长在识题结果下方，不是侧栏）：绑定框 + accent 头 */
.tutor-guide {
  border: 1px solid var(--hc-border-hl);
  border-radius: var(--hc-radius-lg);
  background: var(--hc-bg-card);
  overflow: hidden;
  margin-top: 6px;
}
.tutor-guide__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--hc-divider);
  background: var(--hc-accent-subtle);
  font-size: 13px;
}
.tutor-guide__head b {
  flex: 1;
  font-weight: 700;
}
.tutor-guide__actions {
  display: flex;
  gap: 4px;
  align-items: center;
}
.icbtn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--hc-radius-sm);
  border: 0.5px solid var(--hc-border);
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  font-size: 14px;
}
.icbtn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.tutor-guide__body {
  padding: 13px 15px;
}
.tutor-guide__hint {
  color: var(--hc-text-muted);
  font-size: 12.5px;
  margin: 0;
}
.tutor-section + .tutor-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 0.5px solid var(--hc-divider);
}
.tutor-section__title {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--hc-accent);
  font-weight: 600;
}
.tutor-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 5px;
  vertical-align: middle;
  margin-left: 7px;
  background: color-mix(in srgb, var(--hc-accent) 13%, transparent);
  color: var(--hc-accent);
}
.tutor-badge--weak {
  background: color-mix(in srgb, var(--hc-warning) 15%, transparent);
  color: var(--hc-warning);
  border: 1px dashed color-mix(in srgb, var(--hc-warning) 40%, transparent);
}
.tutor-guide__legend {
  margin: 14px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--hc-text-muted);
}
</style>
