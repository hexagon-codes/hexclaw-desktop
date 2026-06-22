<script setup lang="ts">
/**
 * SkillMarkdownPreview —— SKILL.md 的统一查看组件（view / create 共用）。
 *
 * 解决 P0 缺陷：直接把含 frontmatter 的 SKILL.md 喂给 markdown-it 会把 `---` 渲染成
 * `<hr>`、YAML 行渲染成标题。这里先用 parseFrontmatter 剥离，frontmatter 走结构化
 * chips，正文才走 MarkdownRenderer。
 *
 * 交互打磨：
 *   - 工具条：复制原文（带「已复制」反馈）+「预览 / 源码」切换。
 *   - 源码态代码化展示，便于核对 frontmatter。
 *   - collapsible：长文用「自然高度 + 渐隐遮罩 + 展开全文/收起」，避免详情页出现
 *     嵌套滚动陷阱（max-height 内滚 ⊂ 展开卡 ⊂ 页面滚）。
 *   - 空态占位 + frontmatter 校验（缺 name 报错、缺 description 软提示）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, FileCode2, Zap, Tag as TagIcon, AlertTriangle, Copy, Check, ChevronDown, ChevronUp } from 'lucide-vue-next'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { parseFrontmatter, fmString, fmArray } from '@/utils/frontmatter'
import { setClipboard } from '@/api/desktop'

const props = withDefaults(
  defineProps<{
    /** 原始 SKILL.md 文本（含 frontmatter）。 */
    content: string
    /** 是否展示 frontmatter 结构化卡片（创建向导需要校验，详情页已有同字段则关闭）。 */
    showFrontmatter?: boolean
    /** 是否允许「预览/源码」切换（详情页查看需要，创建向导的编辑 Tab 已是源码故关闭）。 */
    allowRawToggle?: boolean
    /** 是否显示复制按钮。 */
    showCopy?: boolean
    /** 长文是否折叠（自然高度 + 渐隐 + 展开全文）；详情页开启以避免嵌套滚动。 */
    collapsible?: boolean
    /** 初始视图。 */
    defaultView?: 'preview' | 'raw'
  }>(),
  {
    showFrontmatter: false,
    allowRawToggle: true,
    showCopy: true,
    collapsible: false,
    defaultView: 'preview',
  },
)

const { t } = useI18n()

const view = ref<'preview' | 'raw'>(props.defaultView)
const parsed = computed(() => parseFrontmatter(props.content || ''))
const isEmpty = computed(() => !(props.content || '').trim())

const fmName = computed(() => fmString(parsed.value.data.name))
const fmIcon = computed(() => fmString(parsed.value.data.icon))
const fmVersion = computed(() => fmString(parsed.value.data.version))
const fmDescription = computed(() => fmString(parsed.value.data.description))
const fmTriggers = computed(() => fmArray(parsed.value.data.triggers))
const fmTags = computed(() => fmArray(parsed.value.data.tags))

/** emoji 图标直接展示，lucide 名/其他不在 chip 里强渲染（避免误显字符串）。 */
const emojiIcon = computed(() => {
  const raw = fmIcon.value.trim()
  try {
    return /\p{Extended_Pictographic}/u.test(raw) ? raw : ''
  } catch {
    return raw.length <= 4 && /[^ -~]/.test(raw) ? raw : ''
  }
})

/** 校验：开启 frontmatter 卡片时，缺 name 视为草稿不合法（创建向导用以拦截脏生成）。 */
const invalid = computed(() => props.showFrontmatter && !fmName.value.trim())
/** 软提示：有 name 但缺 description（SKILL.md 检索/展示都依赖它）。 */
const missingDescription = computed(
  () => props.showFrontmatter && !invalid.value && !fmDescription.value.trim(),
)

// ─── 复制原文 ───
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null
async function handleCopy() {
  try {
    await setClipboard(props.content || '')
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    /* 剪贴板失败不阻断阅读 */
  }
}

const showToolbar = computed(() => !isEmpty.value && (props.allowRawToggle || props.showCopy))

// ─── 长文折叠（避免嵌套滚动陷阱） ───
const COLLAPSED_PX = 360
const bodyRef = ref<HTMLElement | null>(null)
const expanded = ref(false)
const overflowing = ref(false)
let ro: ResizeObserver | null = null

function measure() {
  const el = bodyRef.value
  if (!el) return
  overflowing.value = el.scrollHeight > COLLAPSED_PX + 16
}

const collapsed = computed(() => props.collapsible && !expanded.value)
const showFade = computed(() => collapsed.value && overflowing.value)

onMounted(() => {
  if (!props.collapsible) return
  nextTick(measure)
  // shiki 异步高亮会改变高度，用 ResizeObserver 跟随重测（jsdom 无此 API 时跳过）。
  if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
    ro = new ResizeObserver(() => measure())
    ro.observe(bodyRef.value)
  }
})
onUnmounted(() => {
  ro?.disconnect()
  if (copyTimer) clearTimeout(copyTimer)
})
watch(
  () => props.content,
  () => {
    expanded.value = false
    if (props.collapsible) nextTick(measure)
  },
)
watch(view, () => {
  if (props.collapsible) nextTick(measure)
})
</script>

<template>
  <div>
    <!-- 工具条：复制 + 源码/预览切换 -->
    <div v-if="showToolbar" class="flex items-center justify-end gap-2 mb-2">
      <button
        v-if="showCopy"
        type="button"
        class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border transition-colors"
        :style="{
          borderColor: 'var(--hc-border)',
          color: copied ? 'var(--hc-accent)' : 'var(--hc-text-muted)',
        }"
        @click="handleCopy"
      >
        <component :is="copied ? Check : Copy" :size="12" />
        {{ copied ? t('skills.preview.copied', '已复制') : t('skills.preview.copy', '复制') }}
      </button>

      <div
        v-if="allowRawToggle"
        class="inline-flex items-center rounded-lg border p-0.5 text-xs"
        :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-main)' }"
      >
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors"
          :style="
            view === 'preview'
              ? { background: 'var(--hc-bg-elevated)', color: 'var(--hc-text-primary)' }
              : { color: 'var(--hc-text-muted)' }
          "
          @click="view = 'preview'"
        >
          <Eye :size="12" />
          {{ t('skills.preview.rendered', '预览') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors"
          :style="
            view === 'raw'
              ? { background: 'var(--hc-bg-elevated)', color: 'var(--hc-text-primary)' }
              : { color: 'var(--hc-text-muted)' }
          "
          @click="view = 'raw'"
        >
          <FileCode2 :size="12" />
          {{ t('skills.preview.source', '源码') }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <p v-if="isEmpty" class="text-xs italic" :style="{ color: 'var(--hc-text-muted)' }">
      {{ t('skills.preview.empty', '（暂无内容）') }}
    </p>

    <!-- 内容区（可折叠） -->
    <template v-else>
      <div
        ref="bodyRef"
        class="relative"
        :style="collapsed ? { maxHeight: COLLAPSED_PX + 'px', overflow: 'hidden' } : {}"
      >
        <!-- 预览态 -->
        <template v-if="view === 'preview'">
          <!-- frontmatter 结构化卡片（仅创建向导开启） -->
          <div
            v-if="showFrontmatter"
            class="mb-3 rounded-lg border p-3"
            :style="{ borderColor: 'var(--hc-border)', background: 'var(--hc-bg-main)' }"
          >
            <div v-if="invalid" class="flex items-center gap-1.5 text-xs" :style="{ color: 'var(--hc-warning)' }">
              <AlertTriangle :size="13" />
              {{ t('skills.preview.invalidFrontmatter', '未检测到 name 字段，请检查 frontmatter 格式') }}
            </div>
            <template v-else>
              <div class="flex items-center gap-2">
                <span v-if="emojiIcon" class="text-base leading-none">{{ emojiIcon }}</span>
                <span class="text-sm font-semibold" :style="{ color: 'var(--hc-text-primary)' }">{{ fmName }}</span>
                <span
                  v-if="fmVersion"
                  class="text-[10px] px-1.5 py-0.5 rounded"
                  :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
                >v{{ fmVersion }}</span>
              </div>
              <p v-if="fmDescription" class="mt-1 text-xs" :style="{ color: 'var(--hc-text-secondary)' }">
                {{ fmDescription }}
              </p>
              <p
                v-if="missingDescription"
                class="mt-1 flex items-center gap-1 text-[11px]"
                :style="{ color: 'var(--hc-text-muted)' }"
              >
                <AlertTriangle :size="11" />
                {{ t('skills.preview.missingDescription', '建议补充 description 字段') }}
              </p>
              <div v-if="fmTriggers.length" class="mt-2 flex flex-wrap items-center gap-1.5">
                <Zap :size="11" :style="{ color: 'var(--hc-text-muted)' }" />
                <span
                  v-for="trg in fmTriggers"
                  :key="trg"
                  class="text-[11px] px-1.5 py-0.5 rounded-md"
                  :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-accent)' }"
                >/{{ trg }}</span>
              </div>
              <div v-if="fmTags.length" class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <TagIcon :size="11" :style="{ color: 'var(--hc-text-muted)' }" />
                <span
                  v-for="tg in fmTags"
                  :key="tg"
                  class="text-[11px] px-1.5 py-0.5 rounded-md"
                  :style="{ background: 'var(--hc-bg-hover)', color: 'var(--hc-text-muted)' }"
                >{{ tg }}</span>
              </div>
            </template>
          </div>

          <!-- 正文（已剥离 frontmatter） -->
          <MarkdownRenderer :content="parsed.body" />
        </template>

        <!-- 源码态：代码化展示完整原文（含 frontmatter） -->
        <pre
          v-else
          class="whitespace-pre-wrap break-words text-xs font-mono m-0 rounded-lg p-3"
          :style="{ background: 'var(--hc-bg-main)', color: 'var(--hc-text-secondary)' }"
        >{{ content }}</pre>

        <!-- 渐隐遮罩（折叠且超长时） -->
        <div
          v-if="showFade"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-12"
          :style="{ background: 'linear-gradient(to bottom, transparent, var(--hc-bg-main))' }"
        />
      </div>

      <!-- 展开全文 / 收起 -->
      <button
        v-if="collapsible && overflowing"
        type="button"
        class="mt-2 inline-flex items-center gap-1 text-xs transition-colors"
        :style="{ color: 'var(--hc-accent)' }"
        @click="expanded = !expanded"
      >
        <component :is="expanded ? ChevronUp : ChevronDown" :size="13" />
        {{ expanded ? t('skills.preview.collapse', '收起') : t('skills.preview.expand', '展开全文') }}
      </button>
    </template>
  </div>
</template>
