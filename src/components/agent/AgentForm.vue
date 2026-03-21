<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, Trash2, Shield, Wrench, BookOpen } from 'lucide-vue-next'
import type { AgentRole } from '@/types'

const props = defineProps<{
  visible: boolean
  role?: AgentRole | null
  readonly?: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [role: AgentRole]
}>()

const { t } = useI18n()

const form = ref<AgentRole>({
  name: '',
  title: '',
  goal: '',
  backstory: '',
  tools: [],
  constraints: [],
})

const newTool = ref('')
const newConstraint = ref('')

watch(() => props.visible, (v) => {
  if (v && props.role) {
    form.value = {
      name: props.role.name,
      title: props.role.title,
      goal: props.role.goal,
      backstory: props.role.backstory || '',
      tools: [...(props.role.tools || [])],
      constraints: [...(props.role.constraints || [])],
    }
  } else if (v) {
    form.value = { name: '', title: '', goal: '', backstory: '', tools: [], constraints: [] }
  }
})

function addTool() {
  if (!newTool.value.trim()) return
  form.value.tools = [...(form.value.tools || []), newTool.value.trim()]
  newTool.value = ''
}

function removeTool(idx: number) {
  form.value.tools = form.value.tools!.filter((_, i) => i !== idx)
}

function addConstraint() {
  if (!newConstraint.value.trim()) return
  form.value.constraints = [...(form.value.constraints || []), newConstraint.value.trim()]
  newConstraint.value = ''
}

function removeConstraint(idx: number) {
  form.value.constraints = form.value.constraints!.filter((_, i) => i !== idx)
}

function handleSave() {
  if (!form.value.name.trim() || !form.value.title.trim()) return
  emit('save', { ...form.value })
}

const isReadonly = () => props.readonly ?? false
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="hc-modal-overlay" @click.self="emit('close')">
        <div class="hc-modal">
          <div class="hc-modal__header">
            <h2 class="hc-modal__title">{{ readonly ? t('agents.title') : (role ? t('agents.editAgent') : t('agents.createAgent')) }}</h2>
            <button class="hc-modal__close" @click="emit('close')">
              <X :size="17" />
            </button>
          </div>
          <div class="hc-modal__body">
            <!-- 基本信息 -->
            <div class="hc-field">
              <label class="hc-field__label">{{ t('agents.name') }} (ID)</label>
              <input
                v-if="!isReadonly()"
                v-model="form.name"
                class="hc-input"
                placeholder="e.g. researcher, coder"
                :disabled="!!role"
              />
              <div v-else class="hc-readonly">{{ form.name }}</div>
            </div>
            <div class="hc-field">
              <label class="hc-field__label">{{ t('agents.displayName') }}</label>
              <input
                v-if="!isReadonly()"
                v-model="form.title"
                class="hc-input"
                placeholder="e.g. Research Analyst"
              />
              <div v-else class="hc-readonly">{{ form.title }}</div>
            </div>
            <div class="hc-field">
              <label class="hc-field__label">{{ t('agents.goal') }}</label>
              <textarea
                v-if="!isReadonly()"
                v-model="form.goal"
                class="hc-input hc-textarea"
                :placeholder="t('agents.goal') + '...'"
                rows="2"
              />
              <div v-else class="hc-readonly">{{ form.goal }}</div>
            </div>

            <!-- 背景故事 -->
            <div class="hc-field">
              <label class="hc-field__label">
                <BookOpen :size="12" class="inline" /> {{ t('agents.backstory') }}
              </label>
              <textarea
                v-if="!isReadonly()"
                v-model="form.backstory"
                class="hc-input hc-textarea"
                :placeholder="t('agents.backstory') + '...'"
                rows="3"
              />
              <div v-else class="hc-readonly hc-readonly--pre">{{ form.backstory || '-' }}</div>
            </div>

            <!-- 工具列表 -->
            <div class="hc-field">
              <label class="hc-field__label">
                <Wrench :size="12" class="inline" /> {{ t('agents.tools') }}
              </label>
              <div v-if="form.tools && form.tools.length > 0" class="hc-tag-list">
                <span v-for="(tool, i) in form.tools" :key="i" class="hc-tag">
                  {{ tool }}
                  <button v-if="!isReadonly()" class="hc-tag__remove" @click="removeTool(i)">
                    <X :size="10" />
                  </button>
                </span>
              </div>
              <div v-else-if="isReadonly()" class="hc-readonly">-</div>
              <div v-if="!isReadonly()" class="hc-add-row">
                <input
                  v-model="newTool"
                  class="hc-input hc-input--sm"
                  placeholder="Add tool name..."
                  @keyup.enter="addTool"
                />
                <button class="hc-add-btn" @click="addTool">
                  <Plus :size="12" />
                </button>
              </div>
            </div>

            <!-- 约束条件 -->
            <div class="hc-field">
              <label class="hc-field__label">
                <Shield :size="12" class="inline" /> Constraints
              </label>
              <div v-if="form.constraints && form.constraints.length > 0" class="hc-constraint-list">
                <div v-for="(c, i) in form.constraints" :key="i" class="hc-constraint-item">
                  <span class="hc-constraint-text">{{ c }}</span>
                  <button v-if="!isReadonly()" class="hc-tag__remove" @click="removeConstraint(i)">
                    <Trash2 :size="10" />
                  </button>
                </div>
              </div>
              <div v-else-if="isReadonly()" class="hc-readonly">-</div>
              <div v-if="!isReadonly()" class="hc-add-row">
                <input
                  v-model="newConstraint"
                  class="hc-input hc-input--sm"
                  placeholder="Add constraint..."
                  @keyup.enter="addConstraint"
                />
                <button class="hc-add-btn" @click="addConstraint">
                  <Plus :size="12" />
                </button>
              </div>
            </div>
          </div>
          <div class="hc-modal__footer">
            <button class="hc-btn hc-btn-secondary" @click="emit('close')">
              {{ readonly ? t('common.close') : t('common.cancel') }}
            </button>
            <button
              v-if="!readonly"
              class="hc-btn hc-btn-primary"
              :disabled="!form.name.trim() || !form.title.trim()"
              @click="handleSave"
            >
              {{ t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-modal-overlay {
  position: fixed;
  top: var(--hc-titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

.hc-modal {
  width: 100%;
  max-width: 520px;
  max-height: 85vh;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-modal__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-modal__close {
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
}

.hc-modal__body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  overflow-y: auto;
}

.hc-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--hc-divider);
}

.hc-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.hc-input {
  padding: 8px 12px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
  width: 100%;
  box-sizing: border-box;
}

.hc-input:focus { border-color: var(--hc-accent); }
.hc-input:disabled { opacity: 0.5; cursor: not-allowed; }
.hc-input--sm { padding: 5px 10px; font-size: 12px; }

.hc-textarea {
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
}

.hc-readonly {
  font-size: 13px;
  color: var(--hc-text-primary);
  padding: 8px 12px;
  background: var(--hc-bg-main);
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
}

.hc-readonly--pre {
  white-space: pre-wrap;
  line-height: 1.5;
}

.hc-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.hc-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 100px;
  background: var(--hc-accent-subtle, rgba(59,130,246,0.1));
  color: var(--hc-accent);
  font-weight: 500;
}

.hc-tag__remove {
  padding: 1px;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  display: flex;
  opacity: 0.6;
}
.hc-tag__remove:hover { opacity: 1; }

.hc-constraint-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hc-constraint-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: var(--hc-radius-sm);
  background: var(--hc-bg-main);
  border: 1px solid var(--hc-border);
  color: var(--hc-text-secondary);
}

.hc-constraint-text { flex: 1; }

.hc-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.hc-add-row .hc-input { flex: 1; }

.hc-add-btn {
  padding: 5px 8px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
}
.hc-add-btn:hover { background: var(--hc-bg-active); }

.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
