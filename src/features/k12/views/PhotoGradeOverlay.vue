<script setup lang="ts">
/**
 * 原图批改叠加层（K12 原图批改 Phase 1，对标作业帮/小猿）。
 *
 * 范式：**检测坐标（识题回收 bbox）+ 程序确定性叠加**——绝不用 AI 生成批改图（不可控、会篡改原图）。
 * 原图为底，按每题归一化 bbox × 实际渲染尺寸，在学生作答区域绝对定位画 ✓（对·绿）/✗（错·红）。
 *
 * 🔴 硬性诚实门（设计文档 §6）：bbox 错位比不标更糟。本组件只在 bbox 存在且**合理**
 * （0~1 内、w/h>0、不越界）时渲染标记；缺失/非法 bbox 的题降级为纯文字批改（列在下方），
 * 绝不叠加错位红叉。归一化坐标天然适配任意渲染尺寸（用百分比定位，无需知道像素分辨率）。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import type { BBox } from '@/api/k12'

/** 一道题的叠加标记：批改结论 + 可选订正/错因，按题 id 对齐其 bbox。 */
interface OverlayMark {
  /** 批改是否正确（true→绿 ✓，false→红 ✗）。 */
  correct: boolean
  /** 学生作答区域归一化边界框；缺失/非法 → 降级纯文字批改（不叠加）。 */
  bbox?: BBox | null
  /** 题干（降级文字批改时展示，供家长对位）。 */
  question?: string
  /** 正确答案（订正，错题时展示）。 */
  correctAnswer?: string
  /** 错因。 */
  errorCause?: string
}

const props = defineProps<{ image: string; marks: OverlayMark[] }>()

const { t } = useI18n()

// 叠加层可开关：看原图 / 看批改（设计文档 §5 交互）。
const showOverlay = ref(true)

/**
 * bbox 合理性校验（错位防护）——与后端 normalizeBBox 同口径：
 * 四值皆有限数、x/y∈[0,1]、w/h 严格 >0、右下角不越界（含极小浮点误差容忍）。
 * 任何一项不满足即判非法 → 该题不叠加（降级文字批改）。
 */
const EDGE_EPS = 0.005
function isValidBBox(b?: BBox | null): b is BBox {
  if (!b) return false
  const vals = [b.x, b.y, b.w, b.h]
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return false
  if (b.w <= 0 || b.h <= 0) return false
  if (b.x < 0 || b.y < 0 || b.x > 1 || b.y > 1) return false
  if (b.x + b.w > 1 + EDGE_EPS || b.y + b.h > 1 + EDGE_EPS) return false
  return true
}

interface IndexedMark extends OverlayMark {
  _i: number
  _valid: boolean
}
const indexed = computed<IndexedMark[]>(() =>
  props.marks.map((m, i) => ({ ...m, _i: i, _valid: isValidBBox(m.bbox) })),
)
// 只有合法 bbox 才叠加；其余降级为下方文字批改（绝不错位）。
const positioned = computed(() => indexed.value.filter((m) => m._valid))
const degraded = computed(() => indexed.value.filter((m) => !m._valid))

/** 归一化 bbox → 百分比定位样式（适配任意渲染尺寸，无需像素分辨率）。 */
function boxStyle(b: BBox) {
  return {
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.w * 100}%`,
    height: `${b.h * 100}%`,
  }
}
</script>

<template>
  <div class="pg-overlay" data-testid="photo-grade-overlay">
    <div class="pg-overlay__head">
      <span class="pg-overlay__title">🖍 {{ t('k12.overlay.title') }}</span>
      <button
        class="pg-overlay__toggle"
        data-testid="overlay-toggle"
        @click="showOverlay = !showOverlay"
      >
        {{ showOverlay ? t('k12.overlay.showOriginal') : t('k12.overlay.showGraded') }}
      </button>
    </div>

    <!-- 原图为底 + 绝对定位叠加层（确定性绘制，非 AI 生成） -->
    <div class="pg-overlay__canvas">
      <img :src="image" class="pg-overlay__img" :alt="t('k12.overlay.imageAlt')" data-testid="overlay-image" />
      <template v-if="showOverlay">
        <div
          v-for="m in positioned"
          :key="m._i"
          class="pg-overlay__mark"
          :class="m.correct ? 'pg-overlay__mark--correct' : 'pg-overlay__mark--wrong'"
          :style="boxStyle(m.bbox as BBox)"
          :data-testid="`overlay-mark-${m._i}`"
        >
          <span class="pg-overlay__sym" :data-testid="`overlay-sym-${m._i}`">{{ m.correct ? '✓' : '✗' }}</span>
          <!-- 错题订正贴框旁（Phase 1 轻量批注，仍是确定性文字，不改原图）。 -->
          <span
            v-if="!m.correct && m.correctAnswer"
            class="pg-overlay__fix"
            :data-testid="`overlay-fix-${m._i}`"
          >{{ m.correctAnswer }}</span>
        </div>
      </template>
    </div>

    <!-- 降级：bbox 缺失/非法的题 → 纯文字批改（绝不叠加错位红叉，设计文档 §6 诚实门）。 -->
    <div v-if="degraded.length" class="pg-overlay__degraded" data-testid="overlay-degraded">
      <div class="pg-overlay__degraded-title">{{ t('k12.overlay.degradedTitle') }}</div>
      <div
        v-for="m in degraded"
        :key="m._i"
        class="pg-overlay__degraded-item"
        :data-testid="`overlay-degraded-${m._i}`"
      >
        <span class="pg-overlay__degraded-verdict" :class="m.correct ? 'is-correct' : 'is-wrong'">
          {{ m.correct ? '✓ ' + t('k12.overlay.correct') : '✗ ' + t('k12.overlay.wrong') }}
        </span>
        <!-- 降级文字批改的题干/正确答案/错因为模型生成，数学题含 LaTeX → 行内 md 渲染，保紧凑行内排布。 -->
        <span v-if="m.question" class="pg-overlay__degraded-q">
          <MarkdownRenderer class="pg-overlay__md-inline" :content="m.question" />
        </span>
        <span v-if="!m.correct && m.correctAnswer" class="pg-overlay__degraded-fix">
          {{ t('k12.overlay.correctAnswer') }}：<MarkdownRenderer class="pg-overlay__md-inline" :content="m.correctAnswer" />
        </span>
        <span v-if="!m.correct && m.errorCause" class="pg-overlay__degraded-cause">
          {{ t('k12.overlay.errorCause') }}：<MarkdownRenderer class="pg-overlay__md-inline" :content="m.errorCause" />
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg-overlay { display: flex; flex-direction: column; gap: 8px; }
.pg-overlay__head { display: flex; align-items: center; gap: 8px; }
.pg-overlay__title { font-size: 12.5px; font-weight: 700; color: var(--hc-text-primary); flex: 1; }
.pg-overlay__toggle {
  font-size: 11.5px; padding: 4px 10px; border: 0.5px solid var(--hc-border); border-radius: var(--hc-radius-md);
  background: var(--hc-bg-input); color: var(--hc-text-primary); cursor: pointer; white-space: nowrap;
}
.pg-overlay__canvas {
  position: relative; display: inline-block; max-width: 100%; align-self: flex-start;
  border-radius: var(--hc-radius-md); overflow: hidden; border: 0.5px solid var(--hc-border);
}
.pg-overlay__img { display: block; max-width: 100%; height: auto; }
/* 绝对定位标记：按归一化 bbox 的百分比落到原图对应位置。 */
.pg-overlay__mark {
  position: absolute; box-sizing: border-box; border-radius: 4px;
  display: flex; align-items: flex-start; gap: 3px; pointer-events: none;
}
.pg-overlay__mark--correct { border: 2px solid var(--hc-success, #2ea86b); background: rgba(46, 168, 107, 0.12); }
.pg-overlay__mark--wrong { border: 2px solid var(--hc-danger, #e05a5a); background: rgba(224, 90, 90, 0.12); }
.pg-overlay__sym {
  font-size: 14px; font-weight: 800; line-height: 1; padding: 1px 3px; border-radius: 3px;
  color: #fff;
}
.pg-overlay__mark--correct .pg-overlay__sym { background: var(--hc-success, #2ea86b); }
.pg-overlay__mark--wrong .pg-overlay__sym { background: var(--hc-danger, #e05a5a); }
.pg-overlay__fix {
  font-size: 11px; font-weight: 700; padding: 1px 4px; border-radius: 3px;
  background: var(--hc-danger, #e05a5a); color: #fff; white-space: nowrap;
}
.pg-overlay__degraded {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px;
  border-inline-start: 3px solid var(--hc-warn, #e0a03a); background: var(--hc-bg-elevated);
  border-start-end-radius: var(--hc-radius-md); border-end-end-radius: var(--hc-radius-md);
}
.pg-overlay__degraded-title { font-size: 11.5px; color: var(--hc-text-secondary); line-height: 1.5; }
.pg-overlay__degraded-item { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--hc-text-secondary); }
.pg-overlay__degraded-verdict { font-weight: 700; }
.pg-overlay__degraded-verdict.is-correct { color: var(--hc-success, #2ea86b); }
.pg-overlay__degraded-verdict.is-wrong { color: var(--hc-danger, #e05a5a); }
.pg-overlay__degraded-q { color: var(--hc-text-primary); }
/* 行内 md:让短批改文本（含 LaTeX）在 flex-wrap 行内排布中不换行成块，保持紧凑。 */
.pg-overlay__md-inline { display: inline; }
.pg-overlay__md-inline :deep(p) { display: inline; margin: 0; }
</style>
