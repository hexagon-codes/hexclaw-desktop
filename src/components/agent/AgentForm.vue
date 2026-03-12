<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Save } from 'lucide-vue-next'
import type { AgentRole, AgentRoleInput } from '@/api/agents'

const props = defineProps<{
  visible: boolean
  role?: AgentRole | null
}>()

const emit = defineEmits<{
  close: []
  save: [data: AgentRoleInput]
}>()

const form = ref<AgentRoleInput>({
  name: '',
  display_name: '',
  description: '',
  system_prompt: '',
  model: 'gpt-4o',
  temperature: 0.7,
  tools: [],
  skills: [],
})

const { t } = useI18n()
const isEdit = computed(() => !!props.role)
const title = computed(() => (isEdit.value ? t('agents.editAgent') : t('agents.createAgent')))

// 编辑模式时填充表单
watch(
  () => props.role,
  (role) => {
    if (role) {
      form.value = {
        name: role.name,
        display_name: role.display_name,
        description: role.description,
        system_prompt: role.system_prompt,
        model: role.model || 'gpt-4o',
        temperature: role.temperature ?? 0.7,
        tools: [...(role.tools || [])],
        skills: [...(role.skills || [])],
      }
    } else {
      form.value = {
        name: '',
        display_name: '',
        description: '',
        system_prompt: '',
        model: 'gpt-4o',
        temperature: 0.7,
        tools: [],
        skills: [],
      }
    }
  },
  { immediate: true },
)

const canSave = computed(
  () => form.value.name.trim() && form.value.display_name.trim() && form.value.system_prompt.trim(),
)

function handleSave() {
  if (!canSave.value) return
  emit('save', { ...form.value })
}

function handleClose() {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-center justify-center"
        @click.self="handleClose"
      >
        <!-- 背景遮罩 -->
        <div class="absolute inset-0 bg-black/50" />

        <!-- 模态框内容 -->
        <div
          class="relative w-full max-w-lg max-h-[80vh] rounded-xl border overflow-hidden flex flex-col"
          :style="{ background: 'var(--hc-bg-panel)', borderColor: 'var(--hc-border)' }"
        >
          <!-- 头部 -->
          <div
            class="flex items-center justify-between px-6 py-4 border-b"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <h2 class="text-base font-semibold" :style="{ color: 'var(--hc-text-primary)' }">
              {{ title }}
            </h2>
            <button
              class="p-1 rounded hover:bg-white/5 transition-colors"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="handleClose"
            >
              <X :size="18" />
            </button>
          </div>

          <!-- 表单 -->
          <div class="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            <div>
              <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">
                名称 (英文标识)
              </label>
              <input
                v-model="form.name"
                type="text"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                placeholder="research-agent"
              />
            </div>

            <div>
              <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">
                显示名称
              </label>
              <input
                v-model="form.display_name"
                type="text"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                placeholder="研究助手"
              />
            </div>

            <div>
              <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">
                描述
              </label>
              <input
                v-model="form.description"
                type="text"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                placeholder="擅长信息检索和深度分析"
              />
            </div>

            <div>
              <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">
                System Prompt
              </label>
              <textarea
                v-model="form.system_prompt"
                rows="5"
                class="w-full rounded-lg border px-3 py-2 text-sm outline-none resize-none"
                :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                placeholder="你是一个专注于信息检索和深度分析的 AI 助手..."
              />
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">模型</label>
                <select
                  v-model="form.model"
                  class="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                  :style="{ background: 'var(--hc-bg-input)', borderColor: 'var(--hc-border)', color: 'var(--hc-text-primary)' }"
                >
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="deepseek-chat">DeepSeek Chat</option>
                  <option value="claude-sonnet-4-20250514">Claude Sonnet</option>
                  <option value="qwen-plus">通义千问 Plus</option>
                </select>
              </div>
              <div>
                <label class="block text-sm mb-1.5" :style="{ color: 'var(--hc-text-secondary)' }">Temperature</label>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="form.temperature"
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    class="flex-1 accent-blue-500"
                  />
                  <span class="text-xs tabular-nums w-8" :style="{ color: 'var(--hc-text-muted)' }">
                    {{ form.temperature }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 底部操作 -->
          <div
            class="flex items-center justify-end gap-3 px-6 py-4 border-t"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <button
              class="px-4 py-2 rounded-lg text-sm transition-colors"
              :style="{ color: 'var(--hc-text-secondary)' }"
              @click="handleClose"
            >
              取消
            </button>
            <button
              class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity"
              :class="canSave ? 'opacity-100' : 'opacity-50 cursor-not-allowed'"
              :style="{ background: 'var(--hc-accent)' }"
              :disabled="!canSave"
              @click="handleSave"
            >
              <Save :size="14" />
              {{ isEdit ? '保存' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
