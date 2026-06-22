<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useI18n } from 'vue-i18n'
import { readLocalFileAsFile } from '@/api/desktop'
import { ArrowUp, Square, Paperclip, Mic, Sparkles, Puzzle, Plus, Upload, BookOpen, Plug, MessageSquare, Loader2 } from 'lucide-vue-next'
import MentionPopup from './MentionPopup.vue'
import TemplatePopup from './TemplatePopup.vue'
import SkillIcon from '@/components/common/SkillIcon.vue'
import { useVoice } from '@/composables/useVoice'
import type { Skill, KnowledgeDoc, ChatSession, ChatContextRef } from '@/types'
import type { ConnectionSummary } from '@/api/im-channels'
import { getDocumentContent } from '@/api/knowledge'
import { listSessionMessages } from '@/api/chat'
import { generateImage, type ImageGenResult } from '@/api/imagegen'
import { submitVideoGeneration, pollUntilDone, videoToSrc, type VideoTaskStatus } from '@/api/videogen'
import { logger } from '@/utils/logger'

/** `@` 召唤选中项（MentionPopup 抛出）。 */
interface MentionSelectItem {
  type: 'agent' | 'knowledge' | 'connection' | 'session'
  id: string
  name: string
  meta?: { provider?: string }
}
/** 本轮上下文 chip（ChatContextRef + 解析中标志 + 代次 uid）。 */
interface ContextChip extends ChatContextRef {
  loading: boolean
  /** 每次 add 唯一；异步解析回填按 uid 匹配，防 remove→re-add 同 id 的陈旧回写竞态。 */
  uid: string
}

/**
 * ComposerMode — 由模型 capability 决定，无任何 UI 按钮（统一对话框，K12 友好）。
 * 用户感知：永远只有一个文本输入框；选了图像/视频模型后 send 自动调对应 API（默认参数）。
 *
 * - chat:           普通文字问答（含附图时即 vision 语义）
 * - image_generate: 当前模型支持图像生成 → send 调 generateImage（默认 1024×1024 / 1 张）
 * - video_generate: 当前模型支持视频生成 → send 调 submitVideoGeneration（默认 1280×720 / 5s / 含音轨）
 */
type ComposerMode = 'chat' | 'image_generate' | 'video_generate'

// 生成默认参数 — 用户不需要感知这些细节
const DEFAULT_IMAGE_SIZE = '1024x1024'
const DEFAULT_IMAGE_COUNT = 1
const DEFAULT_VIDEO_SIZE = '1280x720'
const DEFAULT_VIDEO_DURATION = 5
const DEFAULT_VIDEO_WITH_AUDIO = true

const { t } = useI18n()
const { isListening, transcript, isSupported: voiceSupported, toggleListening } = useVoice()

// 语音识别结果 -> 输入框
watch(transcript, (text) => {
  if (text) {
    inputText.value = text
    nextTick(() => handleInput())
  }
})

const props = defineProps<{
  streaming?: boolean
  disabled?: boolean
  agents?: { name: string; title?: string; goal?: string }[]
  skills?: Skill[]
  /** `@` 召唤的上下文实体来源 */
  knowledgeDocs?: KnowledgeDoc[]
  connections?: ConnectionSummary[]
  sessions?: ChatSession[]
  allowImage?: boolean
  allowVideo?: boolean
  recipientName?: string
  sendHandler?: (
    text: string,
    files: File[],
    options?: { contextRefs?: ChatContextRef[]; skillNames?: string[] },
  ) => boolean | Promise<boolean>
  /** 当前选中的生成模型 ID（仅在 image_generate / video_generate 模式下使用） */
  genModelId?: string
  genModelName?: string
  genProviderKey?: string
  /** 模型是否支持图像生成 / 视频生成（决定相应按钮启用） */
  supportsImageGen?: boolean
  supportsVideoGen?: boolean
}>()

const emit = defineEmits<{
  send: [text: string, files: File[]]
  stop: []
  createTemplate: []
  'generated:image': [result: ImageGenResult, prompt: string]
  'generated:video': [status: VideoTaskStatus, prompt: string]
  'generation:error': [message: string]
  'mode:changed': [mode: ComposerMode]
  /** 扣子式技能子菜单底部入口（由父级 ChatView 处理：打开 AI 创建弹层 / 跳转 Skill 管理） */
  skillAction: [action: 'ai-create' | 'upload-local' | 'add-market']
}>()

/** 本轮「已挂载技能」——选中 skill 后显示可移除 chip，让用户看得见在用什么。
 *  底层仍走 @name 文本 + 后端触发词，不改成结构化插件（守 SKILL.md 可移植性）。 */
const mountedSkills = ref<Skill[]>([])

function removeMountedSkill(name: string) {
  // chip 即唯一表示（不再有 @name 文本需要同步剥离）
  mountedSkills.value = mountedSkills.value.filter((s) => s.name !== name)
}

/** 本轮 `@` 召唤的上下文引用（知识/连接/会话）——只注入 backendText，不污染气泡。 */
const contextChips = ref<ContextChip[]>([])

function contextIcon(type: ChatContextRef['type']) {
  return type === 'knowledge' ? BookOpen : type === 'connection' ? Plug : MessageSquare
}
function contextColor(type: ChatContextRef['type']): string {
  return type === 'knowledge' ? '#34c759' : type === 'connection' ? '#ff9f0a' : '#5e5ce6'
}

function contextFallbackLine(item: MentionSelectItem): string {
  if (item.type === 'knowledge') return `【知识库·${item.name}】`
  if (item.type === 'connection') return `【连接·${item.meta?.provider || ''}·${item.name}】`
  return `【历史会话·${item.name}】`
}

async function resolveContextContent(item: MentionSelectItem): Promise<string> {
  // 注意：此处不再 clamp，统一交由 formatContextBlock 单点截断，避免「先截 body 再截 body+label」双重截断。
  if (item.type === 'knowledge') {
    const doc = (props.knowledgeDocs ?? []).find((d) => d.id === item.id)
    if (!doc) return contextFallbackLine(item)
    const content = await getDocumentContent(doc)
    return content?.trim() ? `【知识库·${doc.title}】\n${content.trim()}` : contextFallbackLine(item)
  }
  if (item.type === 'connection') {
    // 仅作为上下文说明，不暗示模型已有工具访问能力（避免幻觉「我已调用」）。
    const provider = item.meta?.provider || ''
    return `【连接·${provider}·${item.name}】用户引用了该连接（${provider} 平台）作为上下文参考。`
  }
  // session：取近期消息做摘要
  const { messages } = await listSessionMessages(item.id, { limit: 12 })
  const recap = (messages ?? [])
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${(m.content || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .filter((l) => l.length > 3)
    .join('\n')
  return recap ? `【历史会话·${item.name}】\n${recap}` : contextFallbackLine(item)
}

// 进行中的上下文解析 promise（发送前需 await，避免「解析未完成就发送」丢引用）。
const pendingContextFills = new Set<Promise<void>>()
let contextSeq = 0

function addContextRef(item: MentionSelectItem) {
  // 去重：同实体已挂载（含解析中）则忽略
  if (contextChips.value.some((c) => c.type === item.type && c.id === item.id)) return
  const uid = `${item.type}:${item.id}:${++contextSeq}`
  contextChips.value = [
    ...contextChips.value,
    { uid, type: item.type as ChatContextRef['type'], id: item.id, label: item.name, content: '', loading: true },
  ]
  // 按 uid 回填：若该 chip 已被移除（或同 id 重加换了 uid），陈旧 promise 不会误写。
  const applyFill = (content: string) => {
    contextChips.value = contextChips.value.map((c) => (c.uid === uid ? { ...c, content, loading: false } : c))
  }
  const p = resolveContextContent(item)
    .then(applyFill)
    .catch(() => applyFill(contextFallbackLine(item)))
    .finally(() => pendingContextFills.delete(p))
  pendingContextFills.add(p)
}

function removeContextRef(type: string, id: string) {
  contextChips.value = contextChips.value.filter((c) => !(c.type === type && c.id === id))
}

const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const mentionRef = ref<InstanceType<typeof MentionPopup>>()
const templateRef = ref<InstanceType<typeof TemplatePopup>>()
const generating = ref(false)
let videoAbort: AbortController | null = null

const attachedFiles = ref<{ file: File; previewUrl?: string }[]>([])

const showMention = ref(false)
const mentionQuery = ref('')
const mentionPosition = ref({ bottom: 0, left: 0 })
const showTemplate = ref(false)
// 统一命令面板范围：all=斜杠 / 召回(Skill+Prompt) / skills=🔧按钮 / prompts=✨按钮
const paletteScope = ref<'all' | 'skills' | 'prompts'>('all')
const templateQuery = ref('')
const templatePosition = ref({ bottom: 0, left: 0 })
const submitting = ref(false)
// 拖拽上传：用计数器消除拖过子元素时的 dragleave 闪烁；>0 即高亮。
const dragDepth = ref(0)
const isDragging = computed(() => dragDepth.value > 0)

// ── ComposerMode：完全由模型 capability 决定（无独立 mode 按钮，对齐其他通用 Agent）。
// 选了图像/视频模型 → 自动切到对应模式；否则 chat。
const composerMode = computed<ComposerMode>(() => {
  if (props.supportsImageGen) return 'image_generate'
  if (props.supportsVideoGen) return 'video_generate'
  return 'chat'
})
const isGenMode = computed(() => composerMode.value !== 'chat')

// 含图附件 → vision 语义（chat mode 下的派生状态，仅影响 placeholder）
const hasImageAttachment = computed(() => attachedFiles.value.some(a => a.file.type.startsWith('image/')))

watch(composerMode, (mode) => emit('mode:changed', mode), { immediate: true })

const canSend = computed(() => {
  if (props.streaming || props.disabled || submitting.value || generating.value) return false
  if (isGenMode.value) {
    // 生成 mode 必须有 prompt（不允许仅附件）
    return !!inputText.value.trim()
  }
  return !!(inputText.value.trim() || attachedFiles.value.length > 0)
})

const placeholder = computed(() => {
  if (composerMode.value === 'image_generate') {
    return t('chat.composer.placeholder.imageGen', '描述你想生成的图像，例如「写实风格的橘猫站在月球」')
  }
  if (composerMode.value === 'video_generate') {
    return t('chat.composer.placeholder.videoGen', '描述视频内容，例如「橘猫在月球跳跃，电影感」')
  }
  if (hasImageAttachment.value) {
    return t('chat.composer.placeholder.vision', '已附图：可问解题、批改、识字…')
  }
  if (props.recipientName) return t('chat.sendTo', { name: props.recipientName }) + t('chat.composerHint')
  return t('chat.inputPlaceholder') + t('chat.composerHint')
})

const fileAccept = computed(() => {
  const types = [
    '.pdf', '.txt', '.md', '.doc', '.docx', '.xlsx', '.xls', '.csv', '.json',
  ]
  if (props.allowImage !== false) {
    types.push('.png', '.jpg', '.jpeg', '.gif', '.webp')
  }
  if (props.allowVideo) types.push('.mp4', '.mov', '.avi', '.mkv', '.webm')
  return types.join(',')
})

const MAX_HEIGHT = 160

function clearDraft() {
  inputText.value = ''
  attachedFiles.value.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
  attachedFiles.value = []
  mountedSkills.value = []
  contextChips.value = []
  nextTick(() => { if (textareaRef.value) textareaRef.value.style.height = 'auto' })
}

async function handleSend() {
  const text = inputText.value.trim()
  const files = attachedFiles.value.map((a) => a.file)
  if (props.streaming || props.disabled || submitting.value || generating.value) return
  closePopups()

  // 图像生成：直接调 API（默认参数），无 UI 参数面板
  if (composerMode.value === 'image_generate') {
    if (!text || !props.genModelId) return
    generating.value = true
    try {
      const result = await generateImage({
        model: props.genModelId,
        prompt: text,
        size: DEFAULT_IMAGE_SIZE,
        n: DEFAULT_IMAGE_COUNT,
      })
      emit('generated:image', result, text)
      clearDraft()
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('chat.generate.failedDefault', '生成失败')
      logger.error('[ChatInput] image generate failed', e)
      emit('generation:error', msg)
    } finally {
      generating.value = false
    }
    return
  }

  // 视频生成：submit + poll，默认参数
  if (composerMode.value === 'video_generate') {
    if (!text || !props.genModelId) return
    generating.value = true
    videoAbort = new AbortController()
    try {
      const { task_id } = await submitVideoGeneration({
        model: props.genModelId,
        prompt: text,
        size: DEFAULT_VIDEO_SIZE,
        with_audio: DEFAULT_VIDEO_WITH_AUDIO,
        duration: DEFAULT_VIDEO_DURATION,
      })
      const final = await pollUntilDone(task_id, { signal: videoAbort.signal })
      if (final.status === 'success' && videoToSrc(final)) {
        emit('generated:video', final, text)
        clearDraft()
      } else {
        emit('generation:error', final.error || t('chat.generate.failedDefault', '生成失败'))
      }
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') {
        emit('generation:error', t('chat.generate.cancelled', '已取消'))
      } else {
        const msg = e instanceof Error ? e.message : t('chat.generate.failedDefault', '生成失败')
        logger.error('[ChatInput] video generate failed', e)
        emit('generation:error', msg)
      }
    } finally {
      generating.value = false
      videoAbort = null
    }
    return
  }

  // 普通 chat / vision（含附图）
  if (!text && files.length === 0) return
  if (!props.sendHandler) {
    emit('send', text, files)
    clearDraft()
    return
  }
  submitting.value = true
  try {
    // 发送前等待所有上下文解析完成，避免「chip 仍在 loading 就发送」导致空内容被静默丢弃
    if (pendingContextFills.size > 0) {
      await Promise.allSettled([...pendingContextFills])
    }
    const contextRefs: ChatContextRef[] = contextChips.value.map((c) => ({
      type: c.type, id: c.id, label: c.label, content: c.content,
    }))
    const skillNames = mountedSkills.value.map((s) => s.name)
    const accepted = await props.sendHandler(
      text,
      files,
      contextRefs.length || skillNames.length ? { contextRefs, skillNames } : undefined,
    )
    if (accepted) clearDraft()
  } catch {
    // Parent send handler is responsible for surfacing errors.
  } finally {
    submitting.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (showTemplate.value && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
    templateRef.value?.handleKeydown(e); return
  }
  if (showMention.value && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
    mentionRef.value?.handleKeydown(e); return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) { e.preventDefault(); handleSend() }
}

function handleInput() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + 'px'
  detectPopups()
}

function closePopups() { showMention.value = false; showTemplate.value = false }

function detectPopups() {
  const el = textareaRef.value
  if (!el) return
  const text = el.value
  const cursorPos = el.selectionStart
  const beforeCursor = text.slice(0, cursorPos)

  const slashMatch = beforeCursor.match(/(?:^|\n)\/([^\n/]{0,20})$/)
  if (slashMatch) {
    templateQuery.value = slashMatch[1] ?? ''
    paletteScope.value = 'all' // 斜杠召回：Skill + Prompt 一起列
    showTemplate.value = true; showMention.value = false
    const rect = el.getBoundingClientRect()
    templatePosition.value = { bottom: window.innerHeight - rect.top + 8, left: Math.min(rect.left + 14, window.innerWidth - 356) }
    return
  }
  showTemplate.value = false

  const atIdx = beforeCursor.lastIndexOf('@')
  if (atIdx >= 0 && (atIdx === 0 || beforeCursor[atIdx - 1] === ' ' || beforeCursor[atIdx - 1] === '\n')) {
    const query = beforeCursor.slice(atIdx + 1)
    if (!query.includes(' ') && !query.includes('\n') && query.length < 20) {
      mentionQuery.value = query; showMention.value = true
      const rect = el.getBoundingClientRect()
      const bottom = window.innerHeight - rect.top + 8
      let left = rect.left + 40
      if (left + 320 > window.innerWidth) left = window.innerWidth - 328
      if (left < 8) left = 8
      mentionPosition.value = { bottom, left }; return
    }
  }
  showMention.value = false
}

// 若光标前是斜杠召回 token（行首 /xxx）则返回其范围，供选中后剥离；否则 null（按钮召回=光标处插入）。
function slashStripRange(): { start: number; end: number } | null {
  const el = textareaRef.value
  if (!el) return null
  const cursorPos = el.selectionStart
  const before = el.value.slice(0, cursorPos)
  const m = before.match(/(?:^|\n)(\/[^\n/]{0,20})$/)
  if (!m) return null
  return { start: cursorPos - m[1]!.length, end: cursorPos }
}

// 统一命令面板选中：skill → 插 @name；prompt → 插正文（含 $ARGUMENTS snippet 填参）。
// 斜杠召回会剥掉 /query；按钮召回在光标处插入。
function handleTemplateSelect(item: { kind: 'skill' | 'prompt'; content?: string; name?: string }) {
  const el = textareaRef.value
  if (!el) return
  const cursorPos = el.selectionStart
  const text = el.value
  const strip = slashStripRange()
  const start = strip ? strip.start : cursorPos
  const end = strip ? strip.end : cursorPos
  const before = text.slice(0, start)
  showTemplate.value = false

  if (item.kind === 'skill') {
    const name = item.name ?? ''
    if (!name) return
    // 记入「已挂载技能」chip（去重）
    const found = (props.skills ?? []).find((s) => s.name === name)
    if (found && !mountedSkills.value.some((s) => s.name === name)) {
      mountedSkills.value = [...mountedSkills.value, found]
    }
    // 统一为 chip 表示（与 @ 上下文一致）：不再往输入框插 @name 文本——
    // Skill 属 / 命令世界，@ 是召唤语法，混插会污染命名空间且与 chip 重复。
    // 技能激活在发送时注入 backendText（见 useChatSend），输入框保持干净。
    // 这里仅剥掉 slash 召回的 /query（按钮召回时 before+text.slice(end) 即原文不变）。
    inputText.value = before + text.slice(end)
    nextTick(() => {
      el.setSelectionRange(before.length, before.length); handleInput(); focus()
    })
    return
  }

  // prompt
  const content = item.content ?? ''
  inputText.value = before + content + text.slice(end)
  const ARG = '$ARGUMENTS'
  const argIdx = content.indexOf(ARG)
  nextTick(() => {
    handleInput(); focus()
    // command 闭环：选中第一个 $ARGUMENTS 占位，用户直接键入即替换填参（避免字面量被发给模型）。
    if (argIdx >= 0) {
      const s = before.length + argIdx
      el.setSelectionRange(s, s + ARG.length)
    }
  })
}

function handleMentionSelect(item: MentionSelectItem) {
  const el = textareaRef.value
  if (!el) return
  const cursorPos = el.selectionStart
  const text = el.value
  const beforeCursor = text.slice(0, cursorPos)
  const atIdx = beforeCursor.lastIndexOf('@')
  showMention.value = false
  if (atIdx < 0) return

  if (item.type === 'agent') {
    // Agent：插入 @name 文本（路由），行为不变
    inputText.value = text.slice(0, atIdx) + `@${item.name} ` + text.slice(cursorPos)
    nextTick(() => {
      const p = atIdx + item.name.length + 2
      el.setSelectionRange(p, p); el.focus(); handleInput()
    })
    return
  }

  // 知识 / 连接 / 会话：移除 @query token，挂为上下文 chip（内容注入 backendText）
  inputText.value = text.slice(0, atIdx) + text.slice(cursorPos)
  nextTick(() => { el.setSelectionRange(atIdx, atIdx); el.focus(); handleInput() })
  addContextRef(item)
}

function handleFileClick() { fileInputRef.value?.click() }
function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  addFiles(Array.from(input.files))
  input.value = ''
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const imageFiles: File[] = []
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) imageFiles.push(file)
    }
  }
  if (imageFiles.length > 0) {
    e.preventDefault()
    addFiles(imageFiles)
  }
}

// 拖拽上传：与 handlePaste 同源，把拖入的文件交给 addFiles（image 会经后端
// BuildMultimodalUserMessage 路由 vision 模型；后端零改动）。健壮化：只认含 Files 的拖拽、
// 生成模式/禁用态不接收、用 dragDepth 计数避免拖过子元素闪烁。
function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}
function canAcceptFiles(): boolean {
  return !props.disabled && !submitting.value && !isGenMode.value
}
function handleDragEnter(e: DragEvent) {
  if (!canAcceptFiles() || !dragHasFiles(e)) return
  dragDepth.value++
}
function handleDragLeave() {
  if (dragDepth.value > 0) dragDepth.value--
}
function handleDrop(e: DragEvent) {
  dragDepth.value = 0
  if (!canAcceptFiles()) return
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  addFiles(Array.from(files))
}

// Tauri 原生拖拽：dragDropEnabled 默认 true 会拦截 webview 的 HTML drop 事件，桌面端
// 必须监听原生 onDragDropEvent（浏览器 dev 模式下导入失败，自动回退到上面的 HTML @drop）。
let unlistenNativeDrop: (() => void) | null = null
async function handleNativeDrop(paths: string[]) {
  if (!canAcceptFiles() || !paths?.length) return
  const loaded: File[] = []
  for (const path of paths) {
    try {
      loaded.push(await readLocalFileAsFile(path))
    } catch (err) {
      logger.error('[ChatInput] 读取拖入文件失败', path, err)
    }
  }
  if (loaded.length) addFiles(loaded)
}
onMounted(() => {
  // 浏览器 dev 模式下 getCurrentWindow().onDragDropEvent 不可用 → try/catch 回退到 HTML @drop
  try {
    getCurrentWindow()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'over') {
          if (canAcceptFiles()) dragDepth.value = 1
        } else if (p.type === 'leave') {
          dragDepth.value = 0
        } else if (p.type === 'drop') {
          dragDepth.value = 0
          void handleNativeDrop(p.paths)
        }
      })
      .then((unlisten) => {
        unlistenNativeDrop = unlisten
      })
      .catch(() => {
        /* 非 Tauri（浏览器 dev）→ 走 HTML @drop */
      })
  } catch {
    /* 非 Tauri 环境 */
  }
})
onUnmounted(() => {
  unlistenNativeDrop?.()
})

function addFiles(files: File[]) {
  for (const file of files) {
    const isImage = file.type.startsWith('image/')
    attachedFiles.value.push({ file, previewUrl: isImage ? URL.createObjectURL(file) : undefined })
  }
}

function removeFile(index: number) {
  const item = attachedFiles.value[index]
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  attachedFiles.value.splice(index, 1)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

// 统一命令面板入口：与输入「/」等效，更可发现。scope 决定列 Skill / Prompt / 全部。
function openPalette(scope: 'all' | 'skills' | 'prompts') {
  const el = textareaRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  templateQuery.value = ''
  paletteScope.value = scope
  showMention.value = false
  showTemplate.value = true
  templatePosition.value = { bottom: window.innerHeight - rect.top + 8, left: Math.min(rect.left + 14, window.innerWidth - 356) }
  el.focus()
}
function openPromptPicker() { openPalette('prompts') } // ✨ 按钮
function openSkillPicker() { openPalette('skills') }   // 🔧 按钮

function focus() { textareaRef.value?.focus() }
function setInput(text: string) { inputText.value = text; nextTick(() => { handleInput(); focus() }) }
function triggerFileUpload() { handleFileClick() }

defineExpose({ focus, setInput, triggerFileUpload })
</script>

<template>
  <div class="hc-composer">
    <div
      class="hc-composer__box"
      :class="{ 'hc-composer__box--dragging': isDragging }"
      @dragenter.prevent="handleDragEnter"
      @dragover.prevent
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="handleDrop"
    >
      <!-- 拖放文件遮罩 -->
      <div v-if="isDragging" class="hc-composer__dropzone">
        <Upload :size="22" />
        <span>{{ t('chat.dropToUpload', '松开以上传文件') }}</span>
      </div>

      <!-- 已挂载技能 / @ 召唤上下文 chip（本轮生效，可移除） -->
      <div v-if="mountedSkills.length > 0 || contextChips.length > 0" class="hc-composer__skills">
        <span v-for="s in mountedSkills" :key="'skill:' + s.name" class="hc-composer__skill-chip">
          <SkillIcon :skill="s" :size="14" />
          <span class="hc-composer__skill-name">{{ s.display_name || s.name }}</span>
          <button
            class="hc-composer__skill-remove"
            :title="t('chat.removeSkill', '移除技能')"
            @click="removeMountedSkill(s.name)"
          >×</button>
        </span>
        <span v-for="c in contextChips" :key="c.type + ':' + c.id" class="hc-composer__skill-chip">
          <Loader2 v-if="c.loading" :size="13" class="hc-composer__chip-spin" />
          <component :is="contextIcon(c.type)" v-else :size="13" :style="{ color: contextColor(c.type) }" />
          <span class="hc-composer__skill-name">{{ c.label }}</span>
          <button
            class="hc-composer__skill-remove"
            :title="t('chat.removeContext', '移除引用')"
            @click="removeContextRef(c.type, c.id)"
          >×</button>
        </span>
      </div>

      <!-- 附件预览 -->
      <div v-if="attachedFiles.length > 0" class="hc-composer__files">
        <div v-for="(item, idx) in attachedFiles" :key="idx" class="hc-composer__file">
          <img v-if="item.previewUrl" :src="item.previewUrl" class="hc-composer__file-img" />
          <div v-else class="hc-composer__file-card">
            <Paperclip :size="16" class="hc-composer__file-icon" />
            <div class="hc-composer__file-info">
              <span class="hc-composer__file-name">{{ item.file.name }}</span>
              <span class="hc-composer__file-size">{{ formatFileSize(item.file.size) }}</span>
            </div>
          </div>
          <button class="hc-composer__file-remove" @click="removeFile(idx)">×</button>
        </div>
      </div>

      <textarea
        ref="textareaRef"
        v-model="inputText"
        rows="1"
        class="hc-composer__field"
        :placeholder="placeholder"
        :disabled="disabled || submitting"
        @keydown="handleKeydown"
        @input="handleInput"
        @paste="handlePaste"
      />

      <div class="hc-composer__bar">
        <!-- 左：输入动作（+ 添加 · 🧩 skill · ✨ prompt · 🎤 语音听写） -->
        <div class="hc-composer__tools">
          <button
            class="hc-composer__tool"
            :title="t('chat.addFile', '添加 · 上传文件')"
            :disabled="disabled || submitting || isGenMode"
            @click="handleFileClick"
          >
            <Plus :size="20" />
          </button>
          <button
            class="hc-composer__tool"
            :title="t('chat.skillLibrary', '🧩 调用 skill（或输入 /）')"
            :disabled="disabled || submitting || !(skills && skills.length)"
            @click="openSkillPicker"
          >
            <Puzzle :size="18" />
          </button>
          <button
            class="hc-composer__tool"
            :title="t('chat.promptLibrary', '✨ prompt / 命令（或输入 /）')"
            :disabled="disabled || submitting"
            @click="openPromptPicker"
          >
            <Sparkles :size="18" />
          </button>
          <button
            v-if="voiceSupported"
            class="hc-composer__tool"
            :class="{ 'hc-composer__tool--recording': isListening }"
            :title="isListening ? t('chat.voiceStop') : t('chat.voiceStart')"
            :disabled="disabled || submitting || isGenMode"
            @click="toggleListening"
          >
            <Mic :size="18" />
          </button>
        </div>
        <!-- 右：模型 · 模式（slot）· 发送 -->
        <div class="hc-composer__actions">
          <slot name="tools" />
          <!-- P2：分隔「设置区(模型/深度思考)」与「发送动作」，强化主 CTA 焦点 -->
          <span class="hc-composer__action-divider" aria-hidden="true" />
          <button
            v-if="streaming"
            class="hc-composer__send hc-composer__send--stop"
            :title="t('chat.stopGenerate')"
            @click="emit('stop')"
          >
            <Square :size="14" />
          </button>
          <button
            v-else
            class="hc-composer__send"
            :class="{ 'hc-composer__send--active': canSend }"
            :disabled="!canSend"
            :title="t('chat.sendTitle')"
            @click="handleSend"
          >
            <ArrowUp :size="17" stroke-width="2.5" />
          </button>
        </div>
      </div>
    </div>

    <input ref="fileInputRef" type="file" multiple class="hidden" :accept="fileAccept" @change="handleFileChange" />
    <MentionPopup
      ref="mentionRef"
      :visible="showMention"
      :query="mentionQuery"
      :agents="agents || []"
      :knowledge-docs="knowledgeDocs || []"
      :connections="connections || []"
      :sessions="sessions || []"
      :position="mentionPosition"
      @select="handleMentionSelect"
      @close="showMention = false"
    />
    <TemplatePopup ref="templateRef" :visible="showTemplate" :query="templateQuery" :position="templatePosition" :skills="skills || []" :scope="paletteScope" @select="handleTemplateSelect" @close="showTemplate = false" @create="emit('createTemplate')" @skill-action="(a) => { showTemplate = false; emit('skillAction', a) }" />
  </div>
</template>

<style scoped>
/* ─── Apple HIG 规范变量 ───── */
.hc-composer__box {
  position: relative;
  display: flex;
  flex-direction: column;
  /* P0：中性近白底（对齐设计语言「内容区用中性底，蓝只点缀」），蓝色留给 focus ring + 发送 CTA */
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  padding: 20px 20px 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.hc-composer__box:focus-within {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle),
              0 1px 3px rgba(0, 0, 0, 0.06);
}

/* 拖拽文件高亮 */
.hc-composer__box--dragging {
  border-color: var(--hc-accent);
  border-style: dashed;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

/* 拖放文件遮罩：覆盖整个 composer，提示「松开以上传」 */
.hc-composer__dropzone {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--hc-accent, #007AFF) 10%, var(--hc-bg-input));
  color: var(--hc-accent, #007AFF);
  font-size: 13px;
  font-weight: 600;
  pointer-events: none;
  backdrop-filter: blur(2px);
}

/* Textarea */
.hc-composer__field {
  width: 100%;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  font-size: 16px;
  line-height: 1.6;
  max-height: 160px;
  min-height: 24px;
  color: var(--hc-text-primary, #1D1D1F);
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  overflow-y: auto;
  letter-spacing: -0.01em;
}

.hc-composer__field::placeholder {
  /* P1：占位符更克制——比正文/次级文字更浅一档（文案不变，仅降视觉权重） */
  color: var(--hc-text-muted, #A1A1A6);
  font-weight: 400;
}

.hc-composer__field::-webkit-scrollbar { width: 3px; }
.hc-composer__field::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 2px;
}

/* ─── 附件预览 ───── */
.hc-composer__files {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 12px;
  margin-bottom: 8px;
  border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
}

/* 已挂载技能 chip */
.hc-composer__skills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
  margin-bottom: 6px;
}

.hc-composer__skill-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px 3px 7px;
  border-radius: 14px;
  background: var(--hc-bg-active);
  border: 1px solid var(--hc-border);
  font-size: 12px;
  color: var(--hc-text-primary);
  animation: fadeScaleIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.hc-composer__skill-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-composer__skill-remove {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--hc-text-muted);
  font-size: 14px;
  line-height: 1;
  padding: 0 1px;
  border-radius: 50%;
}

.hc-composer__skill-remove:hover {
  color: var(--hc-text-primary);
  background: var(--hc-bg-hover);
}

.hc-composer__chip-spin {
  animation: hc-spin 0.8s linear infinite;
  color: var(--hc-text-muted);
}

@keyframes hc-spin {
  to {
    transform: rotate(360deg);
  }
}

.hc-composer__file {
  position: relative;
  animation: fadeScaleIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.hc-composer__file-img {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 10px;
  border: 0.5px solid rgba(0, 0, 0, 0.08);
}

.hc-composer__file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--hc-bg-card, #F5F5F7);
  border: 0.5px solid rgba(0, 0, 0, 0.06);
  max-width: 200px;
}

.hc-composer__file-icon { color: var(--hc-text-secondary, #6E6E73); flex-shrink: 0; }
.hc-composer__file-info { display: flex; flex-direction: column; min-width: 0; }
.hc-composer__file-name { font-size: 13px; font-weight: 500; color: var(--hc-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc-composer__file-size { font-size: 12px; color: var(--hc-text-secondary, #6E6E73); }

.hc-composer__file-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(20px) saturate(180%);
  color: var(--hc-text-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: color 0.15s;
}

.hc-composer__file-remove:hover { color: var(--hc-error, #FF3B30); }

/* ─── 底部栏 ───── */
.hc-composer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  gap: 8px;
}

.hc-composer__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.hc-composer__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 工具按钮 32x32（输入动作：+ / skill / prompt / 语音） */
.hc-composer__tool {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s, color 0.15s,
              transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* P1：图标 hover 反馈——浮起底色 + 提色，提升可发现性（tooltip 已在 title） */
.hc-composer__tool:hover:not(:disabled) {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.hc-composer__tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.hc-composer__tool:hover {
  color: var(--hc-accent);
  background: var(--hc-bg-hover);
}

.hc-composer__tool:active { transform: scale(0.9); }
.hc-composer__tool:disabled { opacity: 0.4; cursor: default; }
.hc-composer__tool:disabled:hover { color: var(--hc-text-secondary); background: transparent; }

/* Thinking 开启 — 紫色高亮 */
.hc-composer__tool--thinking {
  color: #AF52DE;
  background: rgba(175, 82, 222, 0.1);
}

/* 语音录音中 — 红色脉动 */
.hc-composer__tool--recording {
  color: var(--hc-error, #FF3B30);
  animation: voicePulse 1.2s ease-in-out infinite;
}

@keyframes voicePulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* 发送按钮：克制描边圆（空态清晰可见，非幽灵）；有草稿 → 主色渐变焦点 */
.hc-composer__action-divider {
  width: 1px;
  align-self: stretch;
  margin: 4px 4px 4px 2px;
  background: var(--hc-divider);
  flex-shrink: 0;
}

.hc-composer__send {
  width: 33px;
  height: 33px;
  border-radius: 50%;
  border: 0.5px solid var(--hc-border);
  /* P0：空态明确「未激活」——中性透明 + 弱化色；有内容时 --active 转强调实心 CTA */
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color 0.25s cubic-bezier(0.16, 1, 0.3, 1),
              color 0.2s, border-color 0.2s,
              box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hc-composer__send:disabled { cursor: default; }
.hc-composer__send:not(:disabled):hover { color: var(--hc-text-primary); border-color: var(--hc-border-hl); }

.hc-composer__send--active {
  background: linear-gradient(180deg, var(--hc-accent) 0%, var(--hc-accent-hover) 100%);
  border-color: transparent;
  color: var(--hc-text-inverse);
  box-shadow: 0 5px 16px color-mix(in srgb, var(--hc-accent) 34%, transparent);
}

.hc-composer__send--active:hover {
  transform: scale(1.06);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--hc-accent) 40%, transparent);
}

.hc-composer__send--active:active {
  transform: scale(0.92);
}

.hc-composer__send--stop {
  background: var(--hc-error, #FF3B30);
  color: var(--hc-text-inverse);
}

/* ─── 入场动效 (Apple 弹簧曲线) ───── */
@keyframes fadeScaleIn {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
