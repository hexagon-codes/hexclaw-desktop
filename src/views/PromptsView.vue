<script setup lang="ts">
/**
 * §11.8 交互层：Prompt 库 + 记忆薄版管理页（集成页内 Tab）。
 *   - Prompt：一库两 type（prompt 片段 / command 带参，body 用 $ARGUMENTS 占位）。
 *   - 记忆：standing（每轮全量注入）/ fact（命中注入），后端每轮组 prompt 时注入。
 * 全部走 src/api/prompts.ts 的服务端接口，运营增删不发版。
 */
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Trash2, Pencil, X, FileText, Brain } from 'lucide-vue-next'
import {
  getAllPrompts,
  upsertPrompt,
  deletePrompt,
  type Prompt,
  type PromptType,
  getMemories,
  upsertMemory,
  deleteMemory,
  type UserMemory,
  type MemoryKind,
} from '@/api/prompts'
import UnderlineTabs from '@/components/common/UnderlineTabs.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingState from '@/components/common/LoadingState.vue'
import { useSettingsStore } from '@/stores/settings'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  filter?: string
}>(), {
  filter: '',
})

const emit = defineEmits<{ (e: 'section-change', section: 'prompts' | 'memories'): void }>()

type Section = 'prompts' | 'memories'
const section = ref<Section>('prompts')

// 二级 tab（统一 UnderlineTabs）：传原始计数即可，0 时由 UnderlineTabs 统一隐藏徽标。
const promptSectionTabs = computed(() => [
  { key: 'prompts', label: t('prompts.tabAll', '全部'), count: prompts.value.length },
  { key: 'memories', label: t('prompts.tabMemories', '记忆'), count: memories.value.length },
])

// ── 顶栏统一搜索（IntegrationView 注入）──
const query = computed(() => (props.filter ?? '').toLowerCase().trim())

// ── Prompt 库 ──
const prompts = ref<Prompt[]>([])
const loadingPrompts = ref(false)
const editing = ref<Partial<Prompt> | null>(null) // 非空 = 正在编辑/新建

// 按标题 / 正文过滤 Prompt 列表
const filteredPrompts = computed(() => {
  const q = query.value
  if (!q) return prompts.value
  return prompts.value.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      (p.body_md ?? '').toLowerCase().includes(q),
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
  // 切到「全部」再打开新建表单（toolbar「新建 Prompt」在任意子 tab 都可触发）
  section.value = 'prompts'
  editing.value = {
    type: 'prompt',
    title: '',
    body_md: '',
    enabled: true,
    category: '',
    model: '',
    tool_scope: '',
    args_json: '',
  }
}

// 监听 section 变化，通知父级（用于工具栏按钮文字切换）
watch(section, (s) => emit('section-change', s))

// 暴露给父级 IntegrationView 工具栏调用
defineExpose({ newPrompt, addMemory })

function editPrompt(p: Prompt) {
  editing.value = { ...p }
}
async function savePrompt() {
  const e = editing.value
  if (!e || !e.title?.trim()) return
  await upsertPrompt({
    id: e.id,
    type: (e.type as PromptType) ?? 'prompt',
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
}
async function removePrompt(id: string) {
  if (!confirm(t('prompts.deleteConfirm', '确定删除该 Prompt？此操作不可恢复。'))) return
  await deletePrompt(id)
  await loadPrompts()
}
async function toggleEnabled(p: Prompt) {
  await upsertPrompt({ ...p, enabled: !p.enabled })
  await loadPrompts()
}

const isCommand = computed(() => editing.value?.type === 'command')

// ── HcSelect 投影（替代原生 <select>，value 一律 string）──
const promptTypeOptions = [
  { value: 'prompt', label: 'prompt' },
  { value: 'command', label: 'command' },
]
const editingTypeModel = computed<string>({
  get: () => editing.value?.type ?? 'prompt',
  set: (v) => { if (editing.value) editing.value.type = v as PromptType },
})

// ── 建议模型：选择型字段 → 下拉（来自已启用 Provider 的可用模型 + 「不指定」默认）──
const settings = useSettingsStore()
const modelOptions = computed(() => {
  const seen = new Set<string>()
  const opts: { value: string; label: string }[] = [
    { value: '', label: t('prompts.fModelPh', '不指定（默认）') },
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
  set: (v) => { if (editing.value) editing.value.model = v },
})

// ── 记忆薄版 ──
const memories = ref<UserMemory[]>([])
const loadingMem = ref(false)
const editingMem = ref<Partial<UserMemory> | null>(null) // 非空 = 正在编辑记忆

// 按正文过滤记忆列表
const filteredMemories = computed(() => {
  const q = query.value
  if (!q) return memories.value
  return memories.value.filter((m) => m.content.toLowerCase().includes(q))
})

async function loadMemories() {
  loadingMem.value = true
  try {
    memories.value = (await getMemories()).memories ?? []
  } finally {
    loadingMem.value = false
  }
}

// 新建记忆（由工具栏「添加记忆」按钮调用）
function addMemory() {
  section.value = 'memories'
  editingMem.value = { kind: 'fact', content: '' }
}

function editMemory(m: UserMemory) {
  editingMem.value = { ...m }
}

const memoryKindOptions = computed(() => [
  { value: 'standing', label: t('memories.kindStanding', '常驻 · 每轮注入') },
  { value: 'fact', label: t('memories.kindFact', '命中 · 关键词触发') },
])
const editingMemKindModel = computed<string>({
  get: () => editingMem.value?.kind ?? 'fact',
  set: (v) => { if (editingMem.value) editingMem.value.kind = v as MemoryKind },
})

async function saveMemory() {
  const e = editingMem.value
  if (!e || !e.content?.trim()) return
  await upsertMemory({
    id: e.id,
    kind: (e.kind as MemoryKind) ?? 'fact',
    content: e.content.trim(),
  })
  editingMem.value = null
  await loadMemories()
}

async function removeMemory(id: string) {
  // 记忆删除不可逆：先确认再删（后端暂无 enabled 字段，无"停用"软态，删除即永久）。
  if (!confirm(t('memories.deleteConfirm', '确定删除该记忆？此操作不可恢复。'))) return
  await deleteMemory(id)
  await loadMemories()
}

const route = useRoute()
const router = useRouter()

onMounted(() => {
  loadPrompts()
  loadMemories()
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
    <!-- 子分段：全部 / 记忆（统一 UnderlineTabs，滑动下划线） -->
    <UnderlineTabs
      :tabs="promptSectionTabs"
      :model-value="section"
      @update:model-value="section = $event as Section"
    />

    <!-- ── Prompt 库 ── -->
    <section v-if="section === 'prompts'" class="hc-prompts__panel">

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
              p.type === 'command' ? t('prompts.typeCommand', '命令') : t('prompts.typePrompt', 'Prompt 片段')
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
            <button class="hc-icon-btn hc-icon-btn--danger" @click="removePrompt(p.id)">
              <Trash2 :size="15" />
            </button>
          </div>
        </li>
      </ul>

    </section>

    <!-- ── 记忆薄版 ── -->
    <section v-else class="hc-prompts__panel">
      <!-- 高亮提示条（锚点 prototype .hl，常驻 / 命中 口径） -->
      <div class="hc-prompts__hl">
        <p>{{
          t(
            'memories.hint',
            '用户手写、每轮自动注入的记忆。常驻=每轮全量带上；命中=含关键词才带上（省 token）。',
          )
        }}</p>
      </div>

      <LoadingState v-if="loadingMem" />
      <EmptyState
        v-else-if="filteredMemories.length === 0 && !editingMem"
        :icon="Brain"
        :title="t('memories.empty', '暂无记忆，添加第一条吧。')"
      />

      <!-- 记忆卡网格（对齐原型 .cxcards） -->
      <div v-else-if="filteredMemories.length > 0" class="hc-mem-cards">
        <div v-for="m in filteredMemories" :key="m.id" class="hc-mem-card">
          <!-- 首行：tag + 触发词 meta（fact 型才有） -->
          <div class="hc-mem-card__top">
            <span
              class="hc-tag"
              :class="m.kind === 'standing' ? 'hc-tag--standing' : 'hc-tag--hit'"
            >{{ m.kind === 'standing'
              ? t('memories.kindStanding', '常驻 · 每轮注入')
              : t('memories.kindFact', '命中 · 关键词触发')
            }}</span>
          </div>
          <!-- 正文 -->
          <div class="hc-mem-card__body">{{ m.content }}</div>
          <!-- 操作行（对齐原型 .crow：编辑 / 停用） -->
          <div class="hc-mem-card__crow">
            <button class="hc-btn hc-btn--sm" @click="editMemory(m)">
              {{ t('memories.edit', '编辑') }}
            </button>
            <button class="hc-btn hc-btn--sm hc-btn--ghost" @click="removeMemory(m.id)">
              {{ t('memories.delete', '删除') }}
            </button>
          </div>
        </div>
      </div>

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
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
                {{ editing.id ? t('prompts.editPrompt', '编辑 Prompt') : t('prompts.newPrompt', '新建 Prompt') }}
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
                  v-model="editing.title"
                  type="text"
                  :placeholder="t('prompts.fTitlePh', '如：日报总结')"
                />
              </div>
              <div class="hc-field hc-field--row">
                <div>
                  <label>{{ t('prompts.fType', '类型') }}</label>
                  <HcSelect v-model="editingTypeModel" :options="promptTypeOptions" />
                </div>
                <div>
                  <label>{{ t('prompts.fCategory', '分类') }}</label>
                  <input
                    v-model="editing.category"
                    type="text"
                    :placeholder="t('prompts.fCategoryPh', '如：写作 / 翻译 / 编程（自定义）')"
                  />
                </div>
              </div>
              <div class="hc-field">
                <label>{{ t('prompts.fBody', '正文') }}</label>
                <textarea
                  v-model="editing.body_md"
                  rows="5"
                  :placeholder="
                    isCommand
                      ? t(
                          'prompts.fBodyCmdPh',
                          '用 $ARGUMENTS 占位用户参数，如：翻译以下内容：$ARGUMENTS',
                        )
                      : t('prompts.fBodyPh', 'Prompt 正文（Markdown）')
                  "
                />
                <small v-if="isCommand" class="hc-prompts__hint">{{
                  t(
                    'prompts.cmdHint',
                    'command 召唤时，$ARGUMENTS 会被替换为用户填入的文本（纯文本替换）。',
                  )
                }}</small>
              </div>
              <div class="hc-field hc-field--row">
                <div>
                  <label>{{ t('prompts.fModel', '建议模型（可选）') }}</label>
                  <HcSelect
                    v-model="editingModelModel"
                    :options="modelOptions"
                    :placeholder="t('prompts.fModelPh', '不指定（默认）')"
                  />
                </div>
                <div>
                  <label>{{ t('prompts.fScope', '工具范围（逗号分隔，可选）') }}</label>
                  <input
                    v-model="editing.tool_scope"
                    type="text"
                    :placeholder="t('prompts.fScopePh', '如：web_search, code_exec')"
                  />
                </div>
              </div>
              <label class="hc-switch">
                <input v-model="editing.enabled" type="checkbox" /> {{ t('prompts.enabled', '启用') }}
              </label>
            </div>
            <div
              class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button class="hc-btn" @click="editing = null">{{ t('common.cancel', '取消') }}</button>
              <button
                class="hc-btn hc-btn--primary"
                :disabled="!editing.title?.trim()"
                @click="savePrompt"
              >
                {{ t('common.create', '创建') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 新建/编辑记忆弹窗（居中，同 Prompt 风格） -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="editingMem"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="editingMem = null"
        >
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
                {{ editingMem.id ? t('memories.editMemory', '编辑记忆') : t('memories.newMemory', '添加记忆') }}
              </h2>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="editingMem = null"
              >
                <X :size="17" />
              </button>
            </div>
            <div class="px-5 py-4 hc-modal-body">
              <div class="hc-field hc-field--row">
                <div>
                  <label>{{ t('prompts.fType', '类型') }}</label>
                  <HcSelect v-model="editingMemKindModel" :options="memoryKindOptions" />
                </div>
              </div>
              <div class="hc-field">
                <label>{{ t('prompts.fBody', '正文') }}</label>
                <textarea
                  v-model="editingMem.content"
                  rows="3"
                  :placeholder="t('memories.ph', '记住一条…（如：用户偏好简洁回答）')"
                />
              </div>
            </div>
            <div
              class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button class="hc-btn" @click="editingMem = null">{{ t('common.cancel', '取消') }}</button>
              <button
                class="hc-btn hc-btn--primary"
                :disabled="!editingMem.content?.trim()"
                @click="saveMemory"
              >
                {{ t('common.create', '创建') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.hc-prompts {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 与 Skills/MCP 二级 tab 容器（px-6 pt-3）对齐：左右 24px、上 12px，
     避免在三个集成子 tab 间切换时「全部/记忆」这排 tab 左右跳动/缩进不一致。 */
  padding: 12px 24px 24px;
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
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--hc-radius-md);
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hc-prompts__cat {
  font-size: 11px;
  opacity: 0.5;
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
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px;
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
.hc-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.hc-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.hc-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.hc-btn--primary {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  border-color: transparent;
}
.hc-btn--primary:hover {
  background: var(--hc-accent);
  color: var(--hc-text-inverse);
  opacity: 0.9;
}
.hc-btn--ghost {
  background: transparent;
  border-color: transparent;
}
.hc-btn--ghost:hover {
  background: var(--hc-bg-hover);
  border-color: var(--hc-border);
}
.hc-btn--sm {
  padding: 4px 10px;
  font-size: 12px;
}
.hc-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 弹窗正文区：表单字段纵向排列（取代旧内联编辑器布局） */
.hc-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 70vh;
  overflow-y: auto;
}
.hc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hc-field label {
  font-size: 12px;
  opacity: 0.7;
}
.hc-field--row {
  flex-direction: row;
  gap: 12px;
}
.hc-field--row > div {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hc-field input,
.hc-field select,
.hc-field textarea {
  padding: 8px 10px;
  border-radius: var(--hc-radius-md);
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
</style>
