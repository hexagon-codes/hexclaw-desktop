<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import HcClearableField from '@/components/common/HcClearableField.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import {
  CRON_SCHEDULE_PRESETS,
  formatCronSchedule,
  parseCronSchedule,
  type CronSchedulePattern,
} from '@/utils/cron-schedule'

const props = withDefaults(defineProps<{
  modelValue: string
  simple?: boolean
  disabled?: boolean
}>(), {
  simple: false,
  disabled: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const { t, locale } = useI18n()
const rawSchedule = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})
const schedulePresets = computed(() => CRON_SCHEDULE_PRESETS.map((preset) => ({
  ...preset,
  label: t(preset.labelKey),
})))
const pattern = computed(() => parseCronSchedule(props.modelValue))
const customSelected = ref(false)
const selectedKind = computed(() => customSelected.value ? 'custom' : pattern.value.kind)
const simpleTime = ref('09:00')
const simpleWeekday = ref(1)
const advancedOpen = ref(false)
const showPresets = ref(false)

watch(pattern, (value) => {
  if (value.kind === 'custom') return
  simpleTime.value = value.time
  if (value.kind === 'weekly') simpleWeekday.value = value.weekday
}, { immediate: true })

const weekdays = computed(() => {
  const formatter = new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' })
  return [1, 2, 3, 4, 5, 6, 0].map((value) => ({
    value,
    label: formatter.format(new Date(Date.UTC(2026, 0, 4 + value))),
  }))
})

function updateSimpleSchedule(kind: Exclude<CronSchedulePattern['kind'], 'custom'>) {
  const next = formatCronSchedule(kind === 'weekly'
    ? { kind, time: simpleTime.value, weekday: simpleWeekday.value }
    : { kind, time: simpleTime.value })
  if (next !== null) emit('update:modelValue', next)
}

function selectKind(value: string) {
  const kind = value as CronSchedulePattern['kind']
  customSelected.value = kind === 'custom'
  advancedOpen.value = false
  if (kind !== 'custom') updateSimpleSchedule(kind)
}

function selectTime(event: Event) {
  simpleTime.value = (event.target as HTMLInputElement).value
  if (selectedKind.value !== 'custom') updateSimpleSchedule(selectedKind.value)
}

function selectWeekday(value: string) {
  simpleWeekday.value = Number(value)
  if (selectedKind.value !== 'custom') updateSimpleSchedule(selectedKind.value)
}

function selectPreset(value: string) {
  rawSchedule.value = value
  showPresets.value = false
}

function toggleAdvanced(event: Event) {
  if (event.target instanceof HTMLDetailsElement) advancedOpen.value = event.target.open
}
</script>

<template>
  <div class="cron-schedule-field">
    <template v-if="props.simple">
      <label class="schedule-field">
        <span class="schedule-field__label">{{ t('tasks.scheduleMode') }}</span>
        <HcSelect
          :model-value="selectedKind"
          :disabled="props.disabled"
          :aria-label="t('tasks.scheduleMode')"
          :options="[
            { value: 'daily', label: t('tasks.scheduleDaily') },
            { value: 'weekdays', label: t('tasks.scheduleWeekdays') },
            { value: 'weekly', label: t('tasks.scheduleWeekly') },
            { value: 'custom', label: t('tasks.scheduleCustom') },
          ]"
          @update:model-value="selectKind"
        />
      </label>
      <div v-if="selectedKind !== 'custom'" class="schedule-time-row">
        <label class="schedule-field">
          <span class="schedule-field__label">{{ t('tasks.scheduleTime') }}</span>
          <input type="time" class="hc-input" :value="simpleTime" :disabled="props.disabled" @change="selectTime" />
        </label>
        <label v-if="selectedKind === 'weekly'" class="schedule-field">
          <span class="schedule-field__label">{{ t('tasks.scheduleWeekday') }}</span>
          <HcSelect
            :model-value="String(simpleWeekday)"
            :disabled="props.disabled"
            :aria-label="t('tasks.scheduleWeekday')"
            :options="weekdays.map((weekday) => ({ value: String(weekday.value), label: weekday.label }))"
            @update:model-value="selectWeekday"
          />
        </label>
      </div>
    </template>
    <component
      :is="props.simple && selectedKind !== 'custom' ? 'details' : 'div'"
      class="schedule-advanced"
      :open="advancedOpen"
      @toggle="toggleAdvanced"
    >
      <summary v-if="props.simple && selectedKind !== 'custom'">{{ t('tasks.scheduleAdvanced') }}</summary>
      <div class="schedule-raw">
        <div class="schedule-input-wrap">
          <HcClearableField>
            <input
              v-model="rawSchedule"
              type="text"
              class="hc-input"
              style="font-family: monospace"
              :aria-label="t('tasks.schedule')"
              :placeholder="t('tasks.cronExprPlaceholder')"
              :disabled="props.disabled"
            />
          </HcClearableField>
          <button
            class="schedule-preset-btn"
            data-governed-button="tasks-schedule"
            type="button"
            :disabled="props.disabled"
            :aria-expanded="showPresets"
            :aria-label="t('tasks.schedule')"
            @click="showPresets = !showPresets"
          >
            <ChevronDown :size="14" />
          </button>
        </div>
        <Transition name="fade">
          <div v-if="showPresets" class="schedule-presets">
            <button
              v-for="preset in schedulePresets"
              :key="preset.value"
              type="button"
              class="schedule-preset-item"
              data-governed-button="tasks-schedule"
              :class="{ 'schedule-preset-item--active': props.modelValue === preset.value }"
              :disabled="props.disabled"
              @click="selectPreset(preset.value)"
            >
              <span class="schedule-preset-item__label">{{ preset.label }}</span>
              <code class="schedule-preset-item__value">{{ preset.value }}</code>
            </button>
          </div>
        </Transition>
      </div>
    </component>
  </div>
</template>

<style scoped>
.cron-schedule-field {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.schedule-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.schedule-field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.schedule-time-row {
  display: flex;
  gap: 12px;
}

.schedule-time-row > .schedule-field {
  flex: 1;
}

.schedule-advanced > summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--hc-text-secondary);
}

.schedule-advanced > summary + .schedule-raw {
  margin-top: 10px;
}

.schedule-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.schedule-input-wrap .hc-input {
  padding-right: 32px;
}

.schedule-preset-btn {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  padding: 4px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  border-radius: var(--hc-radius-sm);
  cursor: pointer;
  display: flex;
  transition:
    background 0.15s,
    color 0.15s;
}

.schedule-preset-btn:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-secondary);
}

.schedule-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 0 0;
}

.schedule-preset-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-card);
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
  font-size: 12px;
}

.schedule-preset-item:hover {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.schedule-preset-item--active {
  border-color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.schedule-preset-item__label {
  color: var(--hc-text-primary);
  font-weight: 500;
}

.schedule-preset-item__value {
  color: var(--hc-text-muted);
  font-family: monospace;
  font-size: 11px;
}

.fade-enter-active {
  transition: opacity 0.15s ease-out;
}

.fade-leave-active {
  transition: opacity 0.1s ease-in;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
