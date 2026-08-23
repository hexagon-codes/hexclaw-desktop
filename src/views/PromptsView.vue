<script setup lang="ts">
/**
 * §11.8 交互层：Prompt 库管理页（一库两 type）。
 *   - Prompt：prompt 片段 / command 带参（body 用 $ARGUMENTS 占位）。
 * 走 src/api/prompts.ts 服务端接口，运营增删不发版。
 *
 * 砍薄版（§5）+ U2 IA 重定位：旧记忆薄版 Tab 已移除，长期记忆统一在「长期记忆」(MemoryView) 管理。
 */
import { ref, onMounted, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Trash2, Pencil, X, FileText } from 'lucide-vue-next'
import {
  getAllPrompts,
  upsertPrompt,
  deletePrompt,
  type Prompt,
  type PromptType,
} from '@/api/prompts'
import HcSelect from '@/components/common/HcSelect.vue'
import SegmentedControl from '@/components/common/SegmentedControl.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { useSettingsStore } from '@/stores/settings'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    filter?: string
  }>(),
  {
    filter: '',
  },
)

type PromptEditor = Partial<Prompt> & { command?: string }

// ── 顶栏统一搜索（IntegrationView 注入）──
const query = computed(() => (props.filter ?? '').toLowerCase().trim())

// ── Prompt 库 ──
const prompts = ref<Prompt[]>([])
const loadingPrompts = ref(false)
const editing = ref<PromptEditor | null>(null) // 非空 = 正在编辑/新建
const pendingDeletePrompt = ref<Prompt | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)

// 按标题 / 正文过滤 Prompt 列表
const filteredPrompts = computed(() => {
  const q = query.value
  if (!q) return prompts.value
  return prompts.value.filter(
    (p) => p.title.toLowerCase().includes(q) || (p.body_md ?? '').toLowerCase().includes(q),
  )
})

async function loadPrompts() {
  loadingPrompts.value = true
  try {
    prompts.value = (await getAllPrompts()).prompts ?? []
  } finally {
    loadingPrompts.value = false
  }
}

function newPrompt() {
  editing.value = {
    type: 'command',
    title: '',
    command: '/translate',
    body_md: '',
    enabled: true,
    category: '',
    model: '',
    tool_scope: '',
    args_json: '',
  }
}

// 暴露给父级 IntegrationView 工具栏调用
defineExpose({ newPrompt })

function editPrompt(p: Prompt) {
  editing.value = {
    ...p,
    command: p.type === 'command' ? (p as PromptEditor).command ?? '/translate' : '',
  }
}
/** 增删改失败提示（PromptsView 原无错误反馈，失败会静默吞掉）。 */
const actionError = ref('')

async function savePrompt() {
  const e = editing.value
  if (!e || !e.title?.trim()) return
  actionError.value = ''
  try {
    await upsertPrompt({
      id: e.id,
      type: (e.type as PromptType) ?? 'command',
      title: e.title,
      body_md: e.body_md ?? '',
      category: e.category ?? '',
      model: e.model ?? '',
      tool_scope: e.tool_scope ?? '',
      args_json: e.args_json ?? '',
      enabled: e.enabled ?? true,
    })
    editing.value = null
    await loadPrompts()
  } catch (err) {
    actionError.value =
      err instanceof Error ? err.message : t('prompts.saveFailed', '保存失败，请重试')
  }
}
async function confirmRemovePrompt() {
  const target = pendingDeletePrompt.value
  if (!target) return
  pendingDeletePrompt.value = null
  actionError.value = ''
  try {
    await deletePrompt(target.id)
    await loadPrompts()
  } catch (err) {
    actionError.value =
      err instanceof Error ? err.message : t('prompts.deleteFailed', '删除失败，请重试')
  }
}
async function toggleEnabled(p: Prompt) {
  await upsertPrompt({ ...p, enabled: !p.enabled })
  await loadPrompts()
}

const isCommand = computed(() => editing.value?.type === 'command')

// P1：正文「编辑 / 预览」切换。预览复用全局 Markdown/KaTeX 安全边界，模型仍读原文。
const bodyTab = ref<'edit' | 'preview'>('edit')
const bodyPreviewContent = computed(() => editing.value?.body_md ?? '')
const hasBodyPreview = computed(() => bodyPreviewContent.value.trim().length > 0)
// 打开/切换编辑对象时回到「编辑」态（监听 ref 身份，typing 不重置）
watch(editing, (value) => {
  bodyTab.value = 'edit'
  if (value) void nextTick(() => titleInput.value?.focus())
})

// ── Prompt 类型分段：沿用公共 SegmentedControl，避免表单内出现第二套选择交互。 ──
const promptTypeSegments = [
  { value: 'command', label: '命令 /' },
  { value: 'prompt', label: '片段' },
].map(({ value, label }) => ({ key: value, label }))
const editingTypeModel = computed<string>({
  get: () => editing.value?.type ?? 'command',
  set: (v) => {
    if (editing.value) editing.value.type = v as PromptType
  },
})

// 工具范围预设直接写回现有 tool_scope；自定义输入也复用同一字段，避免产生第二份真相。
const toolScopePresets = computed(() => [
  { value: '', label: t('prompts.scopeNone', '无工具') },
  { value: 'knowledge_search', label: t('prompts.scopeKnowledge', '知识库检索') },
  { value: 'mcp', label: t('prompts.scopeMcp', 'MCP 工具') },
])
function setToolScope(value: string) {
  if (editing.value) editing.value.tool_scope = value
}

// ── 建议模型：选择型字段 → 下拉（来自已启用 Provider 的可用模型 + 「不指定」默认）──
const settings = useSettingsStore()
const modelOptions = computed(() => {
  const seen = new Set<string>()
  const opts: { value: string; label: string }[] = [
    { value: '', label: t('prompts.fModelPh', '跟随当前会话') },
  ]
  for (const m of settings.availableModels) {
    if (!m.modelId || seen.has(m.modelId)) continue
    seen.add(m.modelId)
    opts.push({ value: m.modelId, label: m.modelName || m.modelId })
  }
  // 编辑既有 Prompt 时，若其建议模型已不在可用列表，仍保留为可选项，避免被清空
  const cur = editing.value?.model
  if (cur && !seen.has(cur)) opts.push({ value: cur, label: cur })
  return opts
})
const editingModelModel = computed<string>({
  get: () => editing.value?.model ?? '',
  set: (v) => {
    if (editing.value) editing.value.model = v
  },
})

const route = useRoute()
const router = useRouter()

onMounted(() => {
  loadPrompts()
  // 从会话框 ✨「新建模板」跳转过来（?new=1）→ 自动打开新建 Prompt 表单，并清掉 query。
  // 可选链：单测里不装 router 时 useRoute/useRouter 为 undefined，安全跳过。
  if (route?.query?.new === '1') {
    newPrompt()
    router?.replace({ path: route.path })
  }
})
</script>

<template>
  <div class="hc-prompts">
    <p
      v-if="actionError"
      role="alert"
      style="color: var(--hc-error); font-size: 12.5px; margin: 0 0 8px"
    >
      {{ actionError }}
    </p>

    <!-- ── Prompt 库 ── -->
    <section class="hc-prompts__panel">
      <LoadingState v-if="loadingPrompts" />
      <EmptyState
        v-else-if="filteredPrompts.length === 0"
        :icon="FileText"
        :title="t('prompts.empty', '暂无 Prompt，点击右上角新建。')"
      />
      <ul v-else class="hc-prompts__list">
        <li v-for="p in filteredPrompts" :key="p.id" class="hc-prompts__item">
          <div class="hc-prompts__item-main">
            <span class="hc-tag" :class="p.type === 'command' ? 'hc-tag--cmd' : 'hc-tag--prompt'">{{
              p.type === 'command'
                ? t('prompts.typeCommand', '命令')
                : t('prompts.typePrompt', 'Prompt 片段')
            }}</span>
            <span class="hc-prompts__title">{{ p.title }}</span>
            <span v-if="p.category" class="hc-prompts__cat">{{ p.category }}</span>
          </div>
          <div class="hc-prompts__item-actions">
            <label class="hc-switch" :title="t('prompts.enabled', '启用')">
              <input type="checkbox" :checked="p.enabled" @change="toggleEnabled(p)" />
              <span>{{ p.enabled ? t('prompts.on', '已启用') : t('prompts.off', '已禁用') }}</span>
            </label>
            <button class="hc-icon-btn" @click="editPrompt(p)"><Pencil :size="15" /></button>
            <button class="hc-icon-btn hc-icon-btn--danger" @click="pendingDeletePrompt = p">
              <Trash2 :size="15" />
            </button>
          </div>
        </li>
      </ul>
    </section>

    <!-- 新建/编辑 Prompt 弹窗（居中，参照 AgentsView showAddAgent） -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="editing"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="editing = null"
        >
          <div
            class="hc-prompt-modal rounded-2xl border overflow-hidden"
            data-testid="prompt-editor-dialog"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <h2
                class="text-[15px] font-semibold m-0"
                :style="{ color: 'var(--hc-text-primary)' }"
              >
                {{
                  editing.id
                    ? t('prompts.editPrompt', '编辑 Prompt')
                    : t('prompts.newPrompt', '新建 Prompt')
                }}
              </h2>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="editing = null"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="px-5 py-4 hc-modal-body">
              <div class="hc-field">
                <label>{{ t('prompts.fTitle', '标题') }}</label>
                <input
                  ref="titleInput"
                  v-model="editing.title"
                  type="text"
                  :placeholder="t('prompts.fTitlePh', '如：日报总结')"
                />
              </div>
              <div class="hc-field hc-field--row hc-field--type">
                <div>
                  <label>{{ t('prompts.fType', '类型') }}</label>
                  <SegmentedControl v-model="editingTypeModel" :segments="promptTypeSegments" />
                </div>
                <div>
                  <label>{{ t('prompts.fCommand', '命令（输入 / 召唤）') }}</label>
                  <input v-model="editing.command" type="text" placeholder="/translate" />
                  <small class="hc-prompts__hint">{{
                    t('prompts.fCommandHint', '短名直呼是效率用户的肌肉记忆。')
                  }}</small>
                </div>
              </div>
              <div class="hc-field hc-field--row">
                <div>
                  <label>{{ t('prompts.fCategory', '分类') }}</label>
                  <input
                    v-model="editing.category"
                    type="text"
                    :placeholder="t('prompts.fCategoryPh', '办公 / 写作 / 工程')"
                  />
                </div>
                <div>
                  <label>{{ t('prompts.fModel', '建议模型（可选）') }}</label>
                  <HcSelect
                    v-model="editingModelModel"
                    :options="modelOptions"
                    :placeholder="t('prompts.fModelPh', '跟随当前会话')"
                  />
                </div>
              </div>
              <div class="hc-field hc-field--body">
                <div class="hc-body-head">
                  <label>{{ t('prompts.fBody', '正文') }}</label>
                  <div class="hc-body-tabs" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      :aria-selected="bodyTab === 'edit'"
                      :class="{ on: bodyTab === 'edit' }"
                      @click="bodyTab = 'edit'"
                    >
                      {{ t('prompts.tabEdit', '编辑') }}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      :aria-selected="bodyTab === 'preview'"
                      :class="{ on: bodyTab === 'preview' }"
                      @click="bodyTab = 'preview'"
                    >
                      {{ t('prompts.tabPreview', '预览') }}
                    </button>
                  </div>
                </div>
                <textarea
                  v-show="bodyTab === 'edit'"
                  v-model="editing.body_md"
                  rows="5"
                  class="hc-body-edit"
                  :placeholder="
                    isCommand
                      ? t(
                          'prompts.fBodyCmdPh',
                          '用 $ARGUMENTS 占位用户参数，如：翻译以下内容：$ARGUMENTS',
                        )
                      : t('prompts.fBodyPh', 'Prompt 正文（Markdown）')
                  "
                />
                <div v-show="bodyTab === 'preview'" class="hc-body-prev">
                  <MarkdownRenderer
                    v-if="hasBodyPreview"
                    :content="bodyPreviewContent"
                    :show-artifacts="false"
                    highlight-prompt-args
                  />
                  <p v-else class="hc-prev-empty">
                    {{ t('prompts.previewEmpty', '（空）') }}
                  </p>
                </div>
                <small class="hc-prompts__hint"
                  >{{
                    isCommand
                      ? t(
                          'prompts.cmdHint',
                          'command 召唤时，$ARGUMENTS 会被替换为用户填入的文本（纯文本替换）。',
                        )
                      : t('prompts.mdHint', '支持 Markdown。')
                  }}
                  {{ t('prompts.previewNote', '预览仅供阅读，模型看到的是上方原文。') }}</small
                >
              </div>
              <div class="hc-field hc-field--scope">
                <label>{{ t('prompts.fScope', '工具范围') }}</label>
                <div class="hc-prompts__scope-presets" role="group">
                  <button
                    v-for="scope in toolScopePresets"
                    :key="scope.value || 'none'"
                    type="button"
                    class="hc-btn hc-prompts__scope-preset"
                    :class="{ 'is-selected': editing.tool_scope === scope.value }"
                    :aria-pressed="editing.tool_scope === scope.value"
                    @click="setToolScope(scope.value)"
                  >
                    {{ scope.label }}
                  </button>
                </div>
                <input
                  v-model="editing.tool_scope"
                  type="text"
                  :placeholder="
                    t('prompts.fScopePh', '或自定义：web_search, code_exec（逗号分隔）')
                  "
                />
              </div>
            </div>
            <div
              class="hc-prompt-modal__footer flex items-center justify-end gap-2 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button class="hc-btn" @click="editing = null">
                {{ t('common.cancel', '取消') }}
              </button>
              <button
                class="hc-btn hc-btn-primary"
                @click="savePrompt"
              >
                {{ t('common.save', '保存') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      :open="!!pendingDeletePrompt"
      :title="t('prompts.deleteConfirmTitle', '删除 Prompt？')"
      :message="t('prompts.deleteConfirm', '确定删除该 Prompt？此操作不可恢复。')"
      :confirm-text="t('common.delete', '删除')"
      :cancel-text="t('common.cancel', '取消')"
      :confirmation-key="pendingDeletePrompt?.id"
      danger
      @confirm="confirmRemovePrompt"
      @cancel="pendingDeletePrompt = null"
    />
  </div>
</template>

<style scoped>
.hc-prompts {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 与原型内容区保持同一内边距，避免卡片在集成子页间发生位移。 */
  padding: 16px 26px 48px;
}
.hc-prompts__panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hc-prompts__hint {
  font-size: 12px;
  opacity: 0.62;
}
/* 高亮提示条（锚点 prototype .hl） */
.hc-prompts__hl {
  margin-top: 4px;
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-accent-subtle);
}
.hc-prompts__hl p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--hc-text-secondary);
}
.hc-prompts__empty {
  padding: 32px;
  text-align: center;
  opacity: 0.55;
  font-size: 13px;
}
.hc-prompts__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hc-prompts__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 52px;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 11px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
}
.hc-prompts__item-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.hc-prompts__title {
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hc-prompts__cat {
  margin-top: 2px;
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.hc-prompts__item-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
/* 记忆卡网格（对齐原型 .cxcards，2 列） */
.hc-mem-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 4px;
}
/* 记忆卡（对齐原型 .cxcard） */
.hc-mem-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
}
.hc-mem-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hc-mem-card__body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--hc-text-primary);
}
/* 操作行（对齐原型 .crow） */
.hc-mem-card__crow {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.hc-tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 6px;
  font-weight: 600;
}
.hc-tag--cmd {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.hc-tag--prompt {
  background: var(--hc-bg-active);
  color: var(--hc-text-secondary);
}
/* 记忆 kind 徽标：常驻=accent / 命中=warning（对齐原型） */
.hc-tag--standing {
  background: var(--hc-accent-subtle);
  color: var(--hc-accent);
}
.hc-tag--hit {
  background: color-mix(in srgb, var(--hc-warning) 18%, transparent);
  color: var(--hc-warning);
}
.hc-icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: 1px 6px;
  border-radius: 8px;
  opacity: 0.7;
  color: var(--hc-text-secondary);
}
.hc-icon-btn:hover {
  opacity: 1;
  background: var(--hc-bg-hover);
}
.hc-icon-btn--danger:hover {
  color: var(--hc-error);
}
.hc-icon-btn--danger {
  color: var(--hc-error);
}
.hc-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
/* 弹窗正文区：表单字段纵向排列（取代旧内联编辑器布局） */
.hc-prompt-modal {
  display: grid;
  width: min(600px, calc(100vw - 32px));
  min-width: 0;
  max-height: min(686px, calc(100vh - 32px));
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-radius: 16px;
  transform: translateY(-8px);
}
.hc-prompt-modal > :first-child {
  padding: 16px 18px;
}
.hc-prompt-modal > :first-child > button {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  place-items: center;
}
.hc-modal-body {
  display: flex;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  flex-direction: column;
  gap: 15px;
  padding: 18px;
  overflow-y: auto;
}
.hc-modal-body > .hc-field--row + .hc-field--row {
  margin-top: -15px;
}
.hc-prompt-modal__footer {
  min-width: 0;
  gap: 10px;
  padding: 14px 18px;
}
.hc-field {
  display: flex;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  flex-direction: column;
  gap: 4px;
}
.hc-modal-body .hc-field--scope {
  order: 4;
}
.hc-modal-body .hc-field--body {
  order: 5;
}
.hc-field label {
  margin-bottom: 2px;
  font-size: 13px;
  line-height: 19.5px;
  opacity: 0.7;
}
.hc-field--row {
  flex-direction: row;
  gap: 12px;
}
.hc-field--row > div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hc-field--type > div:first-child {
  flex: 0.8;
}
.hc-field--type > div:last-child {
  flex: 1;
}
.hc-field input,
.hc-field select,
.hc-field textarea {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-size: 13px;
  font-family: inherit;
}
.hc-field input:focus,
.hc-field select:focus,
.hc-field textarea:focus {
  outline: none;
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.hc-field textarea {
  resize: vertical;
}
/* 工具范围预设与自定义字段共用 tool_scope，选中态只表达当前字段值。 */
.hc-prompts__scope-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin-bottom: 2px;
}
.hc-prompts__scope-preset {
  padding: 5px 10px;
  font-size: 12px;
}
.hc-prompts__scope-preset.is-selected {
  color: var(--hc-accent);
  border-color: var(--hc-border-hl);
  background: var(--hc-accent-subtle);
}
/* P1：正文 编辑/预览 切换 */
.hc-body-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hc-body-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-input);
}
.hc-body-tabs button {
  padding: 3px 11px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.hc-body-tabs button.on {
  background: var(--hc-bg-elevated);
  color: var(--hc-accent);
  font-weight: 600;
  box-shadow: var(--hc-shadow-sm);
}
.hc-body-edit {
  min-height: 148px;
  padding: 11px 13px;
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-input);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}
.hc-field textarea.hc-body-edit {
  padding: 11px 13px;
  font-size: 12.5px;
  line-height: 20px;
}
.hc-body-prev {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  min-height: 132px;
  max-height: 320px;
  overflow: auto;
  padding: 10px 13px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-main);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--hc-text-primary);
}
.hc-body-prev :deep(.markdown-body) {
  font-size: inherit;
  line-height: inherit;
}
.hc-body-prev :deep(h1),
.hc-body-prev :deep(h2),
.hc-body-prev :deep(h3) {
  font-weight: 700;
  margin: 10px 0 5px;
}
.hc-body-prev :deep(h1) {
  font-size: 15px;
}
.hc-body-prev :deep(h2) {
  font-size: 14px;
}
.hc-body-prev :deep(p) {
  margin: 5px 0;
}
.hc-body-prev :deep(ul),
.hc-body-prev :deep(ol) {
  margin: 5px 0;
  padding-left: 18px;
}
.hc-body-prev :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  background: var(--hc-bg-active);
  padding: 1px 5px;
  border-radius: 5px;
}
.hc-body-prev :deep(.hc-arg) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--hc-warning);
  background: color-mix(in srgb, var(--hc-warning) 16%, transparent);
  padding: 1px 5px;
  border-radius: 5px;
}
.hc-body-prev :deep(.hc-prev-empty) {
  color: var(--hc-text-muted);
}
/* 弹窗淡入/淡出（对齐 AgentsView showAddAgent） */
.modal-enter-active {
  transition: opacity 0.2s ease-out;
}
.modal-leave-active {
  transition: opacity 0.15s ease-in;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
@media (max-width: 560px) {
  .hc-field--row {
    flex-direction: column;
  }
}
</style>
