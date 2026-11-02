<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { MODEL_CAPABILITY_DISPLAY, localizedModelCapabilityDisplay } from '@/config/model-capability-display'
import type { ModelCapability } from '@/types/settings'

const props = defineProps<{
  modelValue: Record<ModelCapability, boolean>
  editing?: boolean
  testIdPrefix?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<ModelCapability, boolean>] }>()
const { t } = useI18n()
const groups: Array<{ key: string; capabilities: ModelCapability[] }> = [
  { key: 'inputUnderstanding', capabilities: ['text', 'vision', 'video'] },
  { key: 'generationIndexing', capabilities: ['code', 'image_generation', 'video_generation', 'embedding'] },
  { key: 'audioInteraction', capabilities: ['audio', 'computer_use'] },
]

function update(capability: ModelCapability, event: Event) {
  emit('update:modelValue', { ...props.modelValue, [capability]: (event.target as HTMLInputElement).checked })
}
</script>

<template>
  <div class="hc-model-capability-fields" :class="{ 'is-edit': editing }">
    <fieldset v-for="group in groups" :key="group.key" class="hc-model-capability-group">
      <legend>{{ t(`settings.modelList.${group.key}`) }}</legend>
      <div class="hc-edit-model__caps">
        <label v-for="cap in group.capabilities" :key="cap" class="hc-edit-model__cap-item">
          <input type="checkbox" :value="cap" :checked="modelValue[cap]" :data-testid="testIdPrefix ? `${testIdPrefix}${cap}` : undefined" @change="update(cap, $event)" />
          <span class="hc-edit-model__cap-icon" aria-hidden="true">{{ MODEL_CAPABILITY_DISPLAY[cap].icon }}</span>
          <span>{{ cap === 'video' ? t('settings.modelList.videoUnderstanding') : localizedModelCapabilityDisplay(cap, t).label }}</span>
        </label>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.hc-model-capability-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 0; padding: 0; border: 0; }
.hc-model-capability-group + .hc-model-capability-group { margin-top: 12px; }
.hc-model-capability-group legend { margin-bottom: 6px; padding: 0 2px; font-size: 12px; font-weight: 550; color: var(--hc-text-secondary); }
.hc-edit-model__caps { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.hc-edit-model__cap-item { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 8px 10px; border: 1px solid var(--hc-border); border-radius: 6px; font-size: 12px; font-weight: 400; line-height: 1.5; color: var(--hc-text-secondary); cursor: pointer; }
.hc-edit-model__cap-item:hover { background: var(--hc-bg-hover); }
.hc-edit-model__cap-item input { margin: 0; accent-color: var(--hc-accent); }
.hc-edit-model__cap-icon { display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
.is-edit .hc-edit-model__cap-item { padding: 7px 10px; }
.is-edit .hc-model-capability-group + .hc-model-capability-group { margin-top: 10px; }
@media (max-height: 760px) {
  .is-edit .hc-edit-model__caps { gap: 6px; }
  .is-edit .hc-model-capability-group + .hc-model-capability-group { margin-top: 8px; }
}
</style>
