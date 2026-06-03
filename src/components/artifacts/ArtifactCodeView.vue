<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Check, Download, ChevronDown } from 'lucide-vue-next'
import DOMPurify from 'dompurify'
import type { Artifact } from '@/types'
import { setClipboard } from '@/api/desktop'
import { useToast } from '@/composables'

const { t } = useI18n()
const toast = useToast()

const props = defineProps<{
  artifact: Artifact
}>()

const codeHtml = ref('')
const copied = ref(false)

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

async function highlight() {
  try {
    const { codeToHtml } = await import('shiki')
    const raw = await codeToHtml(props.artifact.content, {
      lang: props.artifact.language || 'text',
      theme: 'github-dark',
    })
    codeHtml.value = sanitize(raw)
  } catch {
    // fallback: 纯文本
    codeHtml.value = sanitize(`<pre><code>${escapeHtml(props.artifact.content)}</code></pre>`)
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function copyCode() {
  try {
    await setClipboard(props.artifact.content)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    // clipboard access can be unavailable in tests or restricted runtimes
  }
}

// 把语言名映射到典型扩展名；未命中时直接用 lang 本身（如 "go"、"json" 自带可用扩展）
const LANG_EXT: Record<string, string> = {
  markdown: 'md',
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  rust: 'rs',
  kotlin: 'kt',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  yaml: 'yml',
  plaintext: 'txt',
  text: 'txt',
}

// 文件系统不安全字符：/ \ : * ? " < > | + 控制字符（覆盖 macOS / Linux / Windows）
const FS_UNSAFE = /[\/\\:*?"<>|\x00-\x1f]/g

/** 清洗文件名 base：危险字符替换、空白折叠、头尾修剪、80 字符截断。 */
function sanitizeBase(s: string): string {
  return s
    .replace(FS_UNSAFE, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
}

/** 从 markdown 内容推断标题：优先 H1/H2/H3，再退到首个非空行前 40 字。 */
function inferTitleFromContent(content: string): string {
  const heading = content.match(/^\s*#{1,3}\s+(.+?)\s*$/m)
  if (heading?.[1]) return heading[1].trim()
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t && t.length > 1) return t.slice(0, 40)
  }
  return ''
}

/** 兜底时间戳后缀（HHmm，无重名概率）。 */
function timeSuffix(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 推断文件名 base（含 -HHmm 时间戳后缀）。优先级：
 *   1. artifact.title（清洗后）
 *   2. content 首个 # 标题或首行前 40 字
 *   3. untitled
 *
 * 末尾恒加 `-{HHmm}` 4 位时间戳，让多次下载自动消歧（同一分钟仍可能撞，
 * 用 macOS Save 对话框默认行为兜底）。
 */
function deriveBaseName(): string {
  const stem = computeStem()
  return `${stem}-${timeSuffix()}`
}

/** 不带时间戳的纯 stem，便于单元测试与重命名场景。 */
function computeStem(): string {
  const title = (props.artifact.title || '').trim()
  if (title) {
    const stripped = title.replace(/\.[a-zA-Z0-9]{1,8}$/, '')
    const cleaned = sanitizeBase(stripped)
    if (cleaned) return cleaned
  }
  const inferred = inferTitleFromContent(props.artifact.content || '')
  if (inferred) {
    const cleaned = sanitizeBase(inferred)
    if (cleaned) return cleaned
  }
  return 'untitled'
}

function deriveFilename(): string {
  const title = (props.artifact.title || '').trim()
  // 标题已带合理扩展名：保留扩展，stem 清洗 + 时间戳
  const titleExt = title.match(/\.([a-zA-Z0-9]{1,8})$/)
  if (titleExt) {
    const stem = sanitizeBase(title.slice(0, title.length - titleExt[0].length)) || 'untitled'
    return `${stem}-${timeSuffix()}.${titleExt[1]}`
  }
  const lang = (props.artifact.language || '').toLowerCase()
  const ext = LANG_EXT[lang] || lang || 'txt'
  return `${deriveBaseName()}.${ext}`
}

/**
 * UTF-8 安全的 base64 编码 — TextEncoder 把字符串按 UTF-8 编码成字节，
 * 再分块拼成 binary string 后 btoa。
 *
 * - 直接 btoa 处理含多字节字符（中文/维语）的字符串会抛 InvalidCharacterError
 * - 老套路 btoa(unescape(encodeURIComponent(s))) 里 unescape 已废弃
 * - 一次性 String.fromCharCode(...bytes) 长串会栈溢出，所以分块
 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

/**
 * 默认下载（保留 markdown 行为）：把 artifact 内容原样保存为 .md。
 * Tauri WKWebView 下 <a download> 不可靠，走原生 Save 对话框 + Rust 写盘。
 */
async function downloadCode() {
  const filename = deriveFilename()
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { invoke } = await import('@tauri-apps/api/core')

    const chosen = await save({ defaultPath: filename })
    if (!chosen) return

    const base64 = utf8ToBase64(props.artifact.content)
    await invoke<number>('save_bytes_to_path', { base64Data: base64, path: chosen })
    toast.success?.(t('common.savedTo', { path: chosen }))
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    toast.error?.(t('common.downloadFailed', { reason }))
  }
}

// 8 种导出格式（与 sidecar render.Format 枚举对齐）
type ExportFormat = 'md' | 'html' | 'docx' | 'pdf' | 'epub' | 'odt' | 'rtf' | 'txt'

const EXPORT_FORMATS: { format: ExportFormat; ext: string }[] = [
  { format: 'md', ext: 'md' },
  { format: 'html', ext: 'html' },
  { format: 'docx', ext: 'docx' },
  { format: 'pdf', ext: 'pdf' },
  { format: 'epub', ext: 'epub' },
  { format: 'odt', ext: 'odt' },
  { format: 'rtf', ext: 'rtf' },
  { format: 'txt', ext: 'txt' },
]

const exportMenuOpen = ref(false)
const exportingFormat = ref<ExportFormat | null>(null)

function deriveExportFilename(ext: string): string {
  return `${deriveBaseName()}.${ext}`
}

const exportMenuItems = computed(() =>
  EXPORT_FORMATS.map(({ format, ext }) => ({
    format,
    ext,
    label: `Export as .${ext}`,
  })),
)

/**
 * 导出为指定格式。md 走前端直写（无需后端），其它格式走 sidecar 渲染。
 */
async function exportAs(format: ExportFormat, ext: string) {
  if (exportingFormat.value !== null) return // 防重复点击
  exportMenuOpen.value = false

  // md 格式走前端直写（与默认下载一致，避免不必要的后端往返）
  if (format === 'md') {
    await downloadCode()
    return
  }

  exportingFormat.value = format
  const filename = deriveExportFilename(ext)
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { invoke } = await import('@tauri-apps/api/core')

    const chosen = await save({ defaultPath: filename })
    if (!chosen) {
      exportingFormat.value = null
      return
    }

    await invoke<number>('render_artifact_to_path', {
      content: props.artifact.content,
      format,
      targetPath: chosen,
      title: props.artifact.title || '',
    })
    toast.success?.(t('common.savedTo', { path: chosen }))
  } catch (e) {
    handleRenderError(e)
  } finally {
    exportingFormat.value = null
  }
}

/**
 * 错误处理：sidecar 返回的结构化 RenderError 走 i18n 分支文案，
 * 其它错误走通用 downloadFailed。
 */
function handleRenderError(e: unknown) {
  const raw = e instanceof Error ? e.message : String(e)
  // 尝试解析 RenderError JSON（Rust 侧 Err(serde_json::to_string(...))）
  try {
    const err = JSON.parse(raw) as { code?: string; format?: string; engine?: string; detail?: string }
    if (err && typeof err.code === 'string') {
      const key = `chat.renderError.${err.code}`
      const msg = t(key, { engine: err.engine || '', detail: err.detail || '' })
      // 如果 i18n 未定义此 key，t() 返回 key 本身——降级到 detail
      const display = msg === key ? (err.detail || err.code) : msg
      toast.error?.(display)
      return
    }
  } catch {
    // 非 JSON，落到通用分支
  }
  toast.error?.(t('common.downloadFailed', { reason: raw }))
}

function toggleExportMenu() {
  exportMenuOpen.value = !exportMenuOpen.value
}

function closeExportMenu() {
  exportMenuOpen.value = false
}

// 点击菜单外部时关闭（Vue 3 没内置 v-click-outside，手动监听 document）
const splitRef = ref<HTMLElement | null>(null)
function onDocClick(e: MouseEvent) {
  if (!exportMenuOpen.value) return
  const target = e.target as Node
  if (splitRef.value && !splitRef.value.contains(target)) {
    closeExportMenu()
  }
}

onMounted(() => {
  highlight()
  document.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
})
watch(() => props.artifact.content, highlight)
</script>

<template>
  <div class="hc-code-view">
    <div class="hc-code-view__header">
      <span class="hc-code-view__lang">{{ artifact.language || 'text' }}</span>
      <span class="hc-code-view__title">{{ artifact.title }}</span>
      <div class="hc-code-view__split" ref="splitRef">
        <button
          class="hc-code-view__action"
          :title="t('common.download')"
          :aria-label="t('common.download')"
          :disabled="exportingFormat !== null"
          @click="downloadCode"
        >
          <Download :size="13" />
        </button>
        <button
          class="hc-code-view__action hc-code-view__action--chevron"
          :title="t('chat.exportAs')"
          :aria-label="t('chat.exportAs')"
          :disabled="exportingFormat !== null"
          @click="toggleExportMenu"
        >
          <ChevronDown :size="13" />
        </button>
        <div v-if="exportMenuOpen" class="hc-code-view__menu" role="menu">
          <button
            v-for="item in exportMenuItems"
            :key="item.format"
            class="hc-code-view__menu-item"
            role="menuitem"
            :disabled="exportingFormat !== null"
            @click="exportAs(item.format, item.ext)"
          >
            <span class="hc-code-view__menu-label">{{ item.label }}</span>
            <span v-if="exportingFormat === item.format" class="hc-code-view__menu-spinner">⏳</span>
          </button>
        </div>
      </div>
      <button
        class="hc-code-view__action"
        :title="t('common.copy')"
        :aria-label="t('common.copy')"
        @click="copyCode"
      >
        <Check v-if="copied" :size="13" />
        <Copy v-else :size="13" />
      </button>
    </div>
    <div class="hc-code-view__body" v-html="codeHtml" />
  </div>
</template>

<style scoped>
.hc-code-view {
  border-radius: var(--hc-radius-md);
  overflow: hidden;
  border: 1px solid var(--hc-border);
}

.hc-code-view__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--hc-bg-active);
  border-bottom: 1px solid var(--hc-border);
  font-size: 11px;
}

.hc-code-view__lang {
  font-weight: 600;
  color: var(--hc-accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.hc-code-view__title {
  flex: 1;
  color: var(--hc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-code-view__action {
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  border-radius: 3px;
  transition: color 0.15s, background 0.15s;
}

.hc-code-view__action:hover:not(:disabled) {
  color: var(--hc-text-primary);
  background: var(--hc-bg-hover);
}

.hc-code-view__action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-code-view__split {
  position: relative;
  display: flex;
  align-items: center;
}

.hc-code-view__action--chevron {
  padding: 3px 1px;
}

.hc-code-view__menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--hc-bg-card);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-sm);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  min-width: 180px;
  padding: 4px;
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.hc-code-view__menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--hc-text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: 3px;
  transition: background 0.15s;
}

.hc-code-view__menu-item:hover:not(:disabled) {
  background: var(--hc-bg-hover);
}

.hc-code-view__menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hc-code-view__menu-spinner {
  font-size: 11px;
  margin-left: 8px;
}

.hc-code-view__body {
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.6;
}

.hc-code-view__body :deep(pre) {
  margin: 0;
  padding: 12px;
}

.hc-code-view__body :deep(code) {
  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
}
</style>
