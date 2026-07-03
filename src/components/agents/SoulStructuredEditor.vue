<script setup lang="ts">
/**
 * SOUL 结构化编辑器（原型 C 方案落地，BUG-20260703 批次）。
 *
 * 形态：从人设文本框「共享元素 FLIP 放大」而来的专注编辑面板——不关闭底层创建/编辑弹窗
 * （上下文零丢失），完成时把 7 个自由段合成 markdown 回填（emit apply），取消原样收回。
 * 内核：7 自由段（开关 + 示例一键填充）+ 空白/极简/完整三预设 + 实时体检打分
 *      + 最终注入预览（渲染/原文双视图）+ 自动注入段只读说明（Skill 用真数据）。
 * 合成产物写回 system_prompt（纯文本），零新后端契约。
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import {
  SOUL_SEGMENTS,
  SOUL_PRESETS,
  presetState,
  seedFromText,
  assembleSoul,
  soulHealth,
  type SoulState,
} from '@/utils/soul-editor'

const { t } = useI18n()

const props = defineProps<{
  /** 现有人设文本（作为 identity 种子） */
  modelValue: string
  agentName?: string
  /** FLIP 源矩形（人设文本框）；缺省则居中淡入 */
  sourceRect?: DOMRect | null
  /** 该智能体已挂载的 Skill（自动注入段真数据展示） */
  skills?: string[]
}>()

const emit = defineEmits<{ apply: [text: string]; close: [] }>()

const state = reactive<SoulState>(seedFromText(props.modelValue))
const activePreset = ref<'blank' | 'lite' | 'full'>('full')
const previewTab = ref<'rendered' | 'raw'>('rendered')

const panelEl = ref<HTMLElement | null>(null)
const entered = ref(false)
const leaving = ref(false)

const assembled = computed(() => assembleSoul(state))
const health = computed(() => soulHealth(state))
const healthColor = computed(() =>
  health.value.score >= 80 ? 'var(--hc-success)' : health.value.score >= 50 ? 'var(--hc-warning)' : 'var(--hc-error)',
)

/** 自动注入段（只读）：Skill 用真数据，其余装配期拼接说明。 */
const autoSections = computed(() => [
  { key: 'skills', label: t('agents.soulEd.autoSkills', '技能 Skills'), chips: props.skills ?? [] },
  { key: 'knowledge', label: t('agents.soulEd.autoKnowledge', '知识 Knowledge'), chips: [] },
  { key: 'memory', label: t('agents.soulEd.autoMemory', '长期记忆 Memory'), chips: [] },
])

function applyPreset(key: 'blank' | 'lite' | 'full') {
  activePreset.value = key
  const next = presetState(key)
  for (const seg of SOUL_SEGMENTS) state[seg.key] = next[seg.key]!
}

function toggleSeg(key: string) {
  const st = state[key]!
  st.on = !st.on
  if (st.on && !st.val.trim()) st.val = SOUL_SEGMENTS.find((s) => s.key === key)?.eg ?? ''
}

function fillExample(key: string) {
  const seg = SOUL_SEGMENTS.find((s) => s.key === key)
  if (!seg) return
  state[key] = { on: true, val: seg.eg }
}

/** FLIP：从源矩形（人设框）变换态释放到自然态；关闭时反向收回。 */
function flipTransform(): string {
  const src = props.sourceRect
  const panel = panelEl.value
  if (!src || !panel) return 'scale(.96)'
  const dst = panel.getBoundingClientRect()
  const sx = src.width / dst.width
  const sy = src.height / dst.height
  const tx = src.left + src.width / 2 - (dst.left + dst.width / 2)
  const ty = src.top + src.height / 2 - (dst.top + dst.height / 2)
  return `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`
}

onMounted(() => {
  const panel = panelEl.value
  if (panel) {
    panel.style.transform = flipTransform()
    requestAnimationFrame(() => {
      entered.value = true
      panel.style.transform = 'none'
    })
  } else {
    entered.value = true
  }
})

function close(apply: boolean) {
  if (leaving.value) return
  leaving.value = true
  if (apply) {
    const text = assembled.value
    if (text) emit('apply', text)
  }
  const panel = panelEl.value
  if (panel) {
    panel.style.transform = flipTransform()
    panel.style.opacity = '0'
  }
  entered.value = false
  window.setTimeout(() => emit('close'), 300)
}
</script>

<template>
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center transition-opacity duration-300"
    :class="entered ? 'opacity-100' : 'opacity-0'"
    :style="{ background: 'rgba(0,0,0,.42)' }"
    data-testid="soul-editor-overlay"
    @click.self="close(false)"
  >
    <div
      ref="panelEl"
      class="rounded-2xl border flex flex-col overflow-hidden"
      :style="{
        width: 'min(1000px, 94vw)',
        height: 'min(640px, 88vh)',
        background: 'var(--hc-bg-elevated)',
        borderColor: 'var(--hc-border)',
        boxShadow: 'var(--hc-shadow-float)',
        transition: 'transform .32s var(--hc-ease-out), opacity .32s var(--hc-ease-out)',
        willChange: 'transform, opacity',
      }"
    >
      <!-- 头：标题 + 预设 + 关闭 -->
      <div class="flex items-center gap-3 px-5 py-3.5 border-b flex-shrink-0" :style="{ borderColor: 'var(--hc-border)' }">
        <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
          {{ t('agents.soulEd.title', '结构化人设编辑器') }}<span v-if="agentName" class="font-normal" :style="{ color: 'var(--hc-text-muted)' }"> · {{ agentName }}</span>
        </h2>
        <div class="flex items-center gap-1 ml-2">
          <button
            v-for="(preset, key) in SOUL_PRESETS"
            :key="key"
            type="button"
            class="px-2.5 py-1 rounded-md text-[12px]"
            :data-testid="`soul-preset-${key}`"
            :style="{
              cursor: 'pointer',
              background: activePreset === key ? 'var(--hc-accent-subtle)' : 'transparent',
              color: activePreset === key ? 'var(--hc-accent)' : 'var(--hc-text-secondary)',
              border: 'none',
            }"
            @click="applyPreset(key as 'blank' | 'lite' | 'full')"
          >{{ preset.label }}</button>
        </div>
        <button class="p-1 rounded-md hover:bg-white/5 ml-auto" :style="{ color: 'var(--hc-text-muted)' }" @click="close(false)">
          <X :size="17" />
        </button>
      </div>

      <!-- 体：左段列表 / 右体检+预览 -->
      <div class="flex-1 grid min-h-0" style="grid-template-columns: 1.2fr .9fr">
        <!-- 滚动列子项一律 flex-shrink-0：段卡带 overflow-hidden 会把 flex 最小高度归零，
             缺它时内容超高整列被压扁裁剪而不是滚动（原型 .sec 为 flex:none） -->
        <div class="overflow-y-auto p-4 flex flex-col gap-2.5 border-r" data-testid="soul-seg-column" :style="{ borderColor: 'var(--hc-border)' }">
          <div class="flex-shrink-0 text-[11.5px] rounded-lg px-3 py-2" :style="{ background: 'var(--hc-accent-subtle)', color: 'var(--hc-text-secondary)' }">
            {{ t('agents.soulEd.tip', '分段写清「身份 / 目标 / 约束…」，模型更稳；技能等能力段由挂载对象装配期自动注入，无需手写。') }}
          </div>

          <div
            v-for="seg in SOUL_SEGMENTS"
            :key="seg.key"
            class="flex-shrink-0 rounded-xl border overflow-hidden"
            :style="{ borderColor: state[seg.key]!.on ? 'var(--hc-border-hl, var(--hc-border))' : 'var(--hc-border)', background: 'var(--hc-bg-card)' }"
          >
            <div class="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                role="switch"
                :aria-checked="state[seg.key]!.on"
                :data-testid="`soul-seg-toggle-${seg.key}`"
                class="relative w-[30px] h-[18px] rounded-full border flex-shrink-0"
                :style="{
                  cursor: 'pointer',
                  background: state[seg.key]!.on ? 'var(--hc-accent)' : 'var(--hc-bg-input)',
                  borderColor: state[seg.key]!.on ? 'var(--hc-accent)' : 'var(--hc-border)',
                }"
                @click="toggleSeg(seg.key)"
              >
                <span
                  class="absolute top-[2px] w-[12px] h-[12px] rounded-full bg-white transition-all"
                  :style="{ left: state[seg.key]!.on ? '14px' : '2px' }"
                />
              </button>
              <span class="text-[13px] font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ seg.zh }}</span>
              <span class="text-[11px]" :style="{ color: 'var(--hc-text-muted)' }">{{ seg.en }}</span>
            </div>
            <div v-if="state[seg.key]!.on" class="px-3 pb-2.5 flex flex-col gap-1.5">
              <textarea
                v-model="state[seg.key]!.val"
                rows="2"
                class="rounded-lg border px-2.5 py-1.5 text-[12.5px] outline-none resize-y"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                :placeholder="seg.ph"
                :data-testid="`soul-seg-input-${seg.key}`"
              ></textarea>
              <div class="text-[11px]" :style="{ color: 'var(--hc-text-muted)' }">
                {{ t('agents.soulEd.example', '示例') }}：{{ seg.eg }}
                <button
                  type="button"
                  class="ml-1 font-medium"
                  :style="{ color: 'var(--hc-accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }"
                  :data-testid="`soul-seg-fill-${seg.key}`"
                  @click="fillExample(seg.key)"
                >{{ t('agents.soulEd.useExample', '用示例') }}</button>
              </div>
            </div>
          </div>

          <!-- 自动注入段（只读） -->
          <div class="flex-shrink-0 text-[10.5px] font-bold tracking-wider mt-1" :style="{ color: 'var(--hc-text-muted)' }">
            {{ t('agents.soulEd.autoTitle', '能力与资源 · 自动注入（只读）') }}
          </div>
          <div
            v-for="sec in autoSections"
            :key="sec.key"
            class="flex-shrink-0 rounded-xl border border-dashed px-3 py-2 flex flex-col gap-1.5"
            :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-input)' }"
          >
            <div class="flex items-center gap-2 text-[12px]" :style="{ color: 'var(--hc-text-secondary)' }">
              <span class="font-medium" :style="{ color: 'var(--hc-text-primary)' }">{{ sec.label }}</span>
              <span class="text-[10.5px] ml-auto" :style="{ color: 'var(--hc-text-muted)' }">
                {{ t('agents.soulEd.autoNote', '装配期实时拼接 · 无需手写') }}
              </span>
            </div>
            <div v-if="sec.chips.length" class="flex flex-wrap gap-1">
              <span
                v-for="c in sec.chips"
                :key="c"
                class="px-1.5 py-0.5 rounded text-[11px] border"
                :style="{ borderColor: 'var(--hc-border)', color: 'var(--hc-text-secondary)' }"
              >{{ c }}</span>
            </div>
          </div>
        </div>

        <div class="flex flex-col min-h-0" :style="{ background: 'var(--hc-bg-card)' }">
          <!-- 体检 -->
          <div class="px-4 pt-4">
            <div class="flex items-center gap-3">
              <div
                class="w-[52px] h-[52px] rounded-full grid place-items-center flex-shrink-0"
                :style="{ background: `conic-gradient(${healthColor} ${health.score}%, var(--hc-bg-input) 0)` }"
              >
                <span
                  class="w-[40px] h-[40px] rounded-full grid place-items-center text-[15px] font-bold"
                  :style="{ background: 'var(--hc-bg-elevated)', color: 'var(--hc-text-primary)' }"
                  data-testid="soul-health-score"
                >{{ health.score }}</span>
              </div>
              <div class="min-w-0">
                <div class="text-[12.5px] font-semibold" :style="{ color: 'var(--hc-text-primary)' }">
                  {{ t('agents.soulEd.healthTitle', 'Prompt 体检') }} · {{ health.score >= 80 ? t('agents.soulEd.healthGood', '优秀') : health.score >= 50 ? t('agents.soulEd.healthOk', '可用，可再补') : t('agents.soulEd.healthWeak', '偏弱，建议补全') }}
                </div>
                <div class="text-[11px] flex flex-col" :style="{ color: 'var(--hc-text-muted)' }">
                  <span v-for="tip in health.tips.slice(0, 3)" :key="tip.text">{{ tip.text }}</span>
                </div>
              </div>
            </div>
          </div>
          <!-- 预览 -->
          <div class="flex-1 flex flex-col min-h-0 m-4 mt-3 rounded-xl border overflow-hidden" :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-main)' }">
            <div class="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0" :style="{ borderColor: 'var(--hc-border)' }">
              <span class="text-[12px] font-semibold" :style="{ color: 'var(--hc-text-secondary)' }">{{ t('agents.soulEd.previewTitle', '最终注入预览') }}</span>
              <div class="ml-auto flex gap-1">
                <button
                  type="button"
                  class="px-2 py-0.5 rounded text-[11.5px]"
                  :style="{ cursor: 'pointer', border: 'none', background: previewTab === 'rendered' ? 'var(--hc-accent-subtle)' : 'transparent', color: previewTab === 'rendered' ? 'var(--hc-accent)' : 'var(--hc-text-muted)' }"
                  @click="previewTab = 'rendered'"
                >{{ t('agents.soulEd.previewRendered', '渲染') }}</button>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded text-[11.5px]"
                  data-testid="soul-preview-raw-tab"
                  :style="{ cursor: 'pointer', border: 'none', background: previewTab === 'raw' ? 'var(--hc-accent-subtle)' : 'transparent', color: previewTab === 'raw' ? 'var(--hc-accent)' : 'var(--hc-text-muted)' }"
                  @click="previewTab = 'raw'"
                >{{ t('agents.soulEd.previewRaw', '原文') }}</button>
              </div>
            </div>
            <div class="flex-1 overflow-y-auto p-3 text-[12.5px]" data-testid="soul-preview-body">
              <pre v-if="previewTab === 'raw'" class="m-0 whitespace-pre-wrap" :style="{ color: 'var(--hc-text-secondary)', fontFamily: 'inherit' }">{{ assembled }}</pre>
              <MarkdownRenderer v-else :content="assembled" />
            </div>
          </div>
        </div>
      </div>

      <!-- 底 -->
      <div class="flex items-center gap-2 px-5 py-3 border-t flex-shrink-0" :style="{ borderColor: 'var(--hc-border)' }">
        <span class="text-[11px] mr-auto" :style="{ color: 'var(--hc-text-muted)' }">
          {{ t('agents.soulEd.applyNote', '完成后把自由段合成为人设文本回填；自动注入段由装配期拼接，不写死') }}
        </span>
        <button
          class="px-3 py-1.5 rounded-lg text-sm font-medium"
          :style="{ color: 'var(--hc-text-secondary)', background: 'var(--hc-bg-hover)' }"
          @click="close(false)"
        >{{ t('common.cancel') }}</button>
        <button
          class="px-3 py-1.5 rounded-lg text-sm font-medium text-white"
          :style="{ background: 'var(--hc-accent)' }"
          data-testid="soul-apply"
          @click="close(true)"
        >{{ t('agents.soulEd.apply', '完成并回填') }}</button>
      </div>
    </div>
  </div>
</template>
