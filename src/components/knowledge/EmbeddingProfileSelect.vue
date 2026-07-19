<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
import type { EmbeddingSelection, KnowledgeEmbeddingProfile } from '@/api/knowledge-index'

interface SelectLabels {
  selectLabel: string
  auto: string
  recommended: string
  cloudGroup: string
  localGroup: string
  textOnly: string
  local: string
  cloud: string
  installed: string
  connected: string
  downloadable?: string
  downloading?: string
  unavailable: string
}

const props = withDefaults(
  defineProps<{
    selection: EmbeddingSelection
    profiles: KnowledgeEmbeddingProfile[]
    recommendationProfileId?: string | null
    labels: SelectLabels
    providerNotice: string
    providerDocsLabel: string
    providerDocsAriaLabel: string
    providerDocsUrl: string
    disabled?: boolean
  }>(),
  {
    recommendationProfileId: null,
    disabled: false,
  },
)

const emit = defineEmits<{
  select: [selection: EmbeddingSelection]
}>()

type PickerOption =
  | {
      key: 'auto' | 'disabled'
      selection: Extract<EmbeddingSelection, { kind: 'auto' | 'disabled' }>
      profile: null
      disabled: false
      groupLabel?: string
    }
  | {
      key: string
      selection: Extract<EmbeddingSelection, { kind: 'profile' }>
      profile: KnowledgeEmbeddingProfile
      disabled: boolean
      groupLabel?: string
    }

const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const listboxId = `kb-index-model-listbox-${instanceId}`
const noticeId = `kb-index-provider-notice-${instanceId}`

const open = ref(false)
const highlightedIndex = ref(-1)
const triggerRef = ref<HTMLButtonElement | null>(null)
const popoverRef = ref<HTMLDivElement | null>(null)
const listboxRef = ref<HTMLUListElement | null>(null)
const docsLinkRef = ref<HTMLAnchorElement | null>(null)
const popoverStyle = ref<Record<string, string>>({})

function byDisplayOrder(a: KnowledgeEmbeddingProfile, b: KnowledgeEmbeddingProfile) {
  return a.display_order - b.display_order || a.model_name.localeCompare(b.model_name)
}

const cloudProfiles = computed(() =>
  props.profiles.filter((profile) => profile.location === 'cloud').sort(byDisplayOrder),
)
const localProfiles = computed(() =>
  props.profiles.filter((profile) => profile.location === 'local').sort(byDisplayOrder),
)

function profileIsDisabled(profile: KnowledgeEmbeddingProfile) {
  return (
    profile.availability === 'downloadable' ||
    profile.availability === 'downloading' ||
    profile.availability === 'unavailable'
  )
}

const options = computed<PickerOption[]>(() => [
  {
    key: 'auto',
    selection: { kind: 'auto' },
    profile: null,
    disabled: false,
  },
  ...cloudProfiles.value.map<PickerOption>((profile, index) => ({
    key: `profile:${profile.profile_id}`,
    selection: { kind: 'profile', profile_id: profile.profile_id },
    profile,
    disabled: profileIsDisabled(profile),
    groupLabel: index === 0 ? props.labels.cloudGroup : undefined,
  })),
  ...localProfiles.value.map<PickerOption>((profile, index) => ({
    key: `profile:${profile.profile_id}`,
    selection: { kind: 'profile', profile_id: profile.profile_id },
    profile,
    disabled: profileIsDisabled(profile),
    groupLabel: index === 0 ? props.labels.localGroup : undefined,
  })),
  {
    key: 'disabled',
    selection: { kind: 'disabled' },
    profile: null,
    disabled: false,
  },
])

function selectionKey(selection: EmbeddingSelection) {
  return selection.kind === 'profile' ? `profile:${selection.profile_id}` : selection.kind
}

const selectedKey = computed(() => selectionKey(props.selection))
const selectedIndex = computed(() =>
  options.value.findIndex((option) => option.key === selectedKey.value),
)
const selectedProfile = computed(() => {
  if (props.selection.kind !== 'profile') return null
  return props.profiles.find((profile) => profile.profile_id === props.selection.profile_id) ?? null
})
const displayLabel = computed(() => {
  if (props.selection.kind === 'auto') return props.labels.auto
  if (props.selection.kind === 'disabled') return props.labels.textOnly
  return selectedProfile.value?.model_name ?? props.selection.profile_id
})
const activeDescendant = computed(() =>
  open.value && highlightedIndex.value >= 0 ? optionId(highlightedIndex.value) : undefined,
)

function optionId(index: number) {
  return `${listboxId}-option-${index}`
}

function optionIsSelected(option: PickerOption) {
  return option.key === selectedKey.value
}

function optionTitle(option: PickerOption) {
  if (option.key === 'auto') return props.labels.auto
  if (option.key === 'disabled') return props.labels.textOnly
  return option.profile?.model_name ?? option.selection.profile_id
}

function optionIsRecommended(option: PickerOption) {
  return (
    option.key === 'auto' ||
    (option.profile !== null && option.profile.profile_id === props.recommendationProfileId)
  )
}

function highlightOption(index: number) {
  if (!options.value[index]?.disabled) highlightedIndex.value = index
}

function statusLabel(profile: KnowledgeEmbeddingProfile) {
  switch (profile.availability) {
    case 'installed':
      return props.labels.installed
    case 'connected':
      return props.labels.connected
    case 'downloadable':
      return props.labels.downloadable ?? props.labels.unavailable
    case 'downloading':
      return props.labels.downloading ?? props.labels.unavailable
    default:
      return props.labels.unavailable
  }
}

function firstEnabledIndex() {
  return options.value.findIndex((option) => !option.disabled)
}

function lastEnabledIndex() {
  for (let index = options.value.length - 1; index >= 0; index -= 1) {
    if (!options.value[index]?.disabled) return index
  }
  return -1
}

function nextEnabledIndex(from: number, direction: 1 | -1) {
  const count = options.value.length
  if (!count) return -1
  let index = from
  for (let step = 0; step < count; step += 1) {
    index = (index + direction + count) % count
    if (!options.value[index]?.disabled) return index
  }
  return -1
}

function updatePosition() {
  const trigger = triggerRef.value
  if (!trigger) return

  const rect = trigger.getBoundingClientRect()
  const viewportGap = 12
  const availableWidth = Math.max(0, window.innerWidth - viewportGap * 2)
  const width = Math.min(Math.max(rect.width, 420), availableWidth)
  const left = Math.min(
    Math.max(viewportGap, rect.left),
    Math.max(viewportGap, window.innerWidth - viewportGap - width),
  )
  const spaceBelow = window.innerHeight - rect.bottom - viewportGap
  const spaceAbove = rect.top - viewportGap
  const flipUp = spaceBelow < 320 && spaceAbove > spaceBelow
  const maxHeight = Math.max(180, Math.min(520, flipUp ? spaceAbove - 4 : spaceBelow - 4))

  popoverStyle.value = flipUp
    ? {
        position: 'fixed',
        bottom: `${window.innerHeight - rect.top + 4}px`,
        left: `${left}px`,
        width: `${width}px`,
        maxHeight: `${maxHeight}px`,
      }
    : {
        position: 'fixed',
        top: `${rect.bottom + 4}px`,
        left: `${left}px`,
        width: `${width}px`,
        maxHeight: `${maxHeight}px`,
      }
}

function scrollHighlightedIntoView() {
  nextTick(() => {
    listboxRef.value
      ?.querySelector<HTMLElement>(`[data-option-index="${highlightedIndex.value}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  })
}

async function openPopover(preferredIndex = selectedIndex.value) {
  if (props.disabled) return
  if (!open.value) open.value = true
  const fallback = firstEnabledIndex()
  highlightedIndex.value =
    preferredIndex >= 0 && !options.value[preferredIndex]?.disabled ? preferredIndex : fallback
  await nextTick()
  updatePosition()
  scrollHighlightedIntoView()
}

function closePopover(refocus = true) {
  if (!open.value) {
    if (refocus) triggerRef.value?.focus()
    return
  }
  open.value = false
  highlightedIndex.value = -1
  if (refocus) triggerRef.value?.focus()
}

function togglePopover() {
  if (props.disabled) return
  if (open.value) closePopover()
  else void openPopover()
}

function pick(index: number) {
  const option = options.value[index]
  if (!option || option.disabled || props.disabled) return
  emit('select', { ...option.selection })
  closePopover()
}

async function onTriggerKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      if (!open.value) await openPopover()
      else {
        highlightedIndex.value = nextEnabledIndex(highlightedIndex.value, 1)
        scrollHighlightedIntoView()
      }
      break
    case 'ArrowUp':
      event.preventDefault()
      if (!open.value) await openPopover(lastEnabledIndex())
      else {
        highlightedIndex.value = nextEnabledIndex(highlightedIndex.value, -1)
        scrollHighlightedIntoView()
      }
      break
    case 'Home':
      event.preventDefault()
      if (!open.value) await openPopover(firstEnabledIndex())
      else highlightedIndex.value = firstEnabledIndex()
      scrollHighlightedIntoView()
      break
    case 'End':
      event.preventDefault()
      if (!open.value) await openPopover(lastEnabledIndex())
      else highlightedIndex.value = lastEnabledIndex()
      scrollHighlightedIntoView()
      break
    case 'Enter':
    case ' ':
      event.preventDefault()
      if (!open.value) await openPopover()
      else pick(highlightedIndex.value)
      break
    case 'Escape':
      if (!open.value) return
      event.preventDefault()
      closePopover()
      break
    case 'Tab':
      if (!open.value || event.shiftKey) return
      event.preventDefault()
      docsLinkRef.value?.focus()
      break
  }
}

function onDocsLinkKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePopover()
    return
  }
  if (event.key === 'Tab' && event.shiftKey) {
    event.preventDefault()
    triggerRef.value?.focus()
  }
}

function onClickOutside(event: MouseEvent) {
  const target = event.target as Node
  if (triggerRef.value?.contains(target) || popoverRef.value?.contains(target)) return
  closePopover(false)
}

function onFocusOutside(event: FocusEvent) {
  if (!open.value) return
  const target = event.target as Node
  if (triggerRef.value?.contains(target) || popoverRef.value?.contains(target)) return
  closePopover(false)
}

function onViewportChange() {
  if (open.value) updatePosition()
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside, true)
  document.addEventListener('focusin', onFocusOutside, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  document.removeEventListener('focusin', onFocusOutside, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closePopover(false)
  },
)
</script>

<template>
  <div class="kb-profile-select">
    <button
      ref="triggerRef"
      type="button"
      class="kb-profile-select__trigger hc-input"
      :class="{ 'kb-profile-select__trigger--disabled': disabled }"
      role="combobox"
      data-testid="kb-index-model-trigger"
      :aria-label="`${labels.selectLabel}: ${displayLabel}`"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-controls="listboxId"
      :aria-activedescendant="activeDescendant"
      :aria-describedby="open ? noticeId : undefined"
      :aria-disabled="disabled || undefined"
      @click="togglePopover"
      @keydown="onTriggerKeydown"
    >
      <span class="kb-profile-select__trigger-copy">
        <span class="kb-profile-select__trigger-label">{{ displayLabel }}</span>
        <span
          v-if="selectedProfile"
          class="kb-profile-select__location"
          :class="`kb-profile-select__location--${selectedProfile.location}`"
        >
          {{ selectedProfile.location === 'local' ? labels.local : labels.cloud }}
        </span>
      </span>
      <ChevronDown
        :size="14"
        class="kb-profile-select__chevron"
        :class="{ 'kb-profile-select__chevron--open': open }"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <Transition name="kb-profile-popover">
        <div v-if="open" ref="popoverRef" class="kb-profile-select__popover" :style="popoverStyle">
          <ul
            :id="listboxId"
            ref="listboxRef"
            class="kb-profile-select__listbox"
            role="listbox"
            :aria-label="labels.selectLabel"
            :aria-describedby="noticeId"
          >
            <template v-for="(option, index) in options" :key="option.key">
              <li
                v-if="option.groupLabel"
                class="kb-profile-select__group-label"
                role="presentation"
              >
                {{ option.groupLabel }}
              </li>
              <li
                :id="optionId(index)"
                class="kb-profile-select__option"
                :class="{
                  'kb-profile-select__option--simple': !option.profile,
                  'kb-profile-select__option--text-only': option.key === 'disabled',
                  'kb-profile-select__option--selected': optionIsSelected(option),
                  'kb-profile-select__option--highlighted': highlightedIndex === index,
                  'kb-profile-select__option--disabled': option.disabled,
                }"
                role="option"
                :aria-selected="optionIsSelected(option)"
                :aria-disabled="option.disabled || undefined"
                :data-option-index="index"
                @mousedown.prevent
                @click="pick(index)"
                @mouseenter="highlightOption(index)"
              >
                <span class="kb-profile-select__option-copy">
                  <span class="kb-profile-select__option-main">
                    <span class="kb-profile-select__option-title">{{ optionTitle(option) }}</span>
                    <span
                      v-if="option.profile"
                      class="kb-profile-select__location"
                      :class="`kb-profile-select__location--${option.profile.location}`"
                    >
                      {{ option.profile.location === 'local' ? labels.local : labels.cloud }}
                    </span>
                    <span
                      v-if="optionIsRecommended(option)"
                      class="kb-profile-select__badge kb-profile-select__badge--recommended"
                    >
                      {{ labels.recommended }}
                    </span>
                  </span>
                  <span v-if="option.profile" class="kb-profile-select__option-meta">
                    {{ option.profile.provider_name }}
                    <span aria-hidden="true"> · </span>
                    {{ statusLabel(option.profile) }}
                  </span>
                </span>
                <Check
                  v-if="optionIsSelected(option)"
                  :size="15"
                  class="kb-profile-select__check"
                  aria-hidden="true"
                />
              </li>
            </template>
          </ul>

          <div
            :id="noticeId"
            class="kb-profile-select__notice"
            data-testid="kb-index-provider-notice"
            role="note"
          >
            <span>{{ providerNotice }}</span>
            <a
              ref="docsLinkRef"
              class="kb-profile-select__docs-link"
              data-testid="kb-index-provider-docs"
              :href="providerDocsUrl"
              :aria-label="providerDocsAriaLabel"
              target="_blank"
              rel="noopener noreferrer"
              @keydown="onDocsLinkKeydown"
            >
              {{ providerDocsLabel }}
            </a>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.kb-profile-select {
  width: 100%;
  min-width: 0;
}

.kb-profile-select__trigger {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 32px;
  border-radius: var(--hc-radius-md, 10px);
  appearance: none;
  -webkit-appearance: none;
  color: var(--hc-text-primary);
  text-align: left;
  cursor: pointer;
}

.kb-profile-select__trigger--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.kb-profile-select__trigger-copy,
.kb-profile-select__option-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.kb-profile-select__trigger-copy {
  flex: 1;
}

.kb-profile-select__trigger-label,
.kb-profile-select__option-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-profile-select__trigger-label {
  flex: 1;
}

.kb-profile-select__chevron {
  position: absolute;
  right: 10px;
  color: var(--hc-text-muted);
  transition: transform 0.16s var(--hc-ease-out, ease-out);
}

.kb-profile-select__chevron--open {
  transform: rotate(180deg);
}

.kb-profile-select__location,
.kb-profile-select__badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
}

.kb-profile-select__location--cloud {
  color: var(--hc-accent);
  background: var(--hc-accent-subtle);
}

.kb-profile-select__location--local {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 13%, transparent);
}

.kb-profile-select__badge--recommended {
  color: var(--hc-success);
  background: color-mix(in srgb, var(--hc-success) 12%, transparent);
}
</style>

<style>
.kb-profile-select__popover {
  z-index: var(--hc-z-popover, 9200);
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius-md, 10px);
  background: var(--hc-bg-elevated);
  -webkit-backdrop-filter: blur(var(--hc-blur-heavy, 40px));
  backdrop-filter: blur(var(--hc-blur-heavy, 40px));
  box-shadow: var(--hc-shadow-float);
}

.kb-profile-select__listbox {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 6px;
  list-style: none;
}

.kb-profile-select__group-label {
  padding: 9px 10px 4px;
  color: var(--hc-text-muted);
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

.kb-profile-select__option {
  box-sizing: border-box;
  min-height: 50px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--hc-radius-sm, 6px);
  color: var(--hc-text-secondary);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}

.kb-profile-select__option--simple {
  min-height: 38px;
  justify-content: space-between;
}

.kb-profile-select__option--text-only {
  margin-top: 5px;
  border-top: 1px solid var(--hc-border-subtle, var(--hc-border));
  border-radius: 0 0 var(--hc-radius-sm, 6px) var(--hc-radius-sm, 6px);
}

.kb-profile-select__option--highlighted {
  color: var(--hc-text-primary);
  background: var(--hc-bg-hover);
}

.kb-profile-select__option--selected {
  color: var(--hc-accent);
}

.kb-profile-select__option--selected.kb-profile-select__option--highlighted {
  background: var(--hc-accent-subtle);
}

.kb-profile-select__option--disabled {
  opacity: 0.46;
  cursor: not-allowed;
}

.kb-profile-select__option-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kb-profile-select__option-main {
  color: inherit;
  font-size: 13px;
  font-weight: 520;
}

.kb-profile-select__option-title {
  flex: 0 1 auto;
}

.kb-profile-select__option-meta {
  min-width: 0;
  overflow: hidden;
  color: var(--hc-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kb-profile-select__check {
  flex-shrink: 0;
  color: var(--hc-accent);
}

.kb-profile-select__notice {
  flex-shrink: 0;
  padding: 9px 12px 10px;
  border-top: 1px solid var(--hc-border-subtle, var(--hc-border));
  color: var(--hc-text-muted);
  font-size: 11.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.kb-profile-select__docs-link {
  display: inline;
  margin-left: 4px;
  color: var(--hc-accent);
  font-weight: 550;
  text-decoration: none;
  white-space: nowrap;
}

.kb-profile-select__docs-link:hover {
  color: var(--hc-accent-hover);
  text-decoration: underline;
}

.kb-profile-popover-enter-active,
.kb-profile-popover-leave-active {
  transform-origin: top center;
  transition:
    opacity 0.14s ease,
    transform 0.14s var(--hc-ease-out, ease-out);
}

.kb-profile-popover-enter-from,
.kb-profile-popover-leave-to {
  opacity: 0;
  transform: translateY(-3px) scale(0.99);
}

@media (max-width: 420px) {
  .kb-profile-select__option {
    min-height: 48px;
    padding-inline: 9px;
  }

  .kb-profile-select__notice {
    padding-inline: 10px;
    font-size: 11px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kb-profile-select__chevron,
  .kb-profile-popover-enter-active,
  .kb-profile-popover-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
