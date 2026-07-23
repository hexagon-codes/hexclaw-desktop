<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import K12PrintPreviewModal from './K12PrintPreviewModal.vue'
import {
  preparePersistentPrint,
  type PersistentPrintPreparation,
  type PersistentPrintRequest,
} from '../persistent-print'

const emit = defineEmits<{
  result: [printed: boolean]
  error: [error: Error]
}>()

const state = ref({
  open: false,
  printing: false,
  title: '',
  preparation: null as Extract<PersistentPrintPreparation, { status: 'preview' }> | null,
})
let generation = 0

function close(force = false) {
  if (state.value.printing && !force) return
  generation++
  state.value = { open: false, printing: false, title: '', preparation: null }
}

async function open(request: PersistentPrintRequest): Promise<void> {
  const requestGeneration = ++generation
  const prepared = await preparePersistentPrint(request)
  if (requestGeneration !== generation) return
  if (prepared.status === 'completed') {
    emit('result', prepared.printed)
    return
  }
  state.value = {
    open: true,
    printing: false,
    title: prepared.title,
    preparation: prepared,
  }
}

async function confirm() {
  const prepared = state.value.preparation
  if (!prepared || state.value.printing) return
  state.value.printing = true
  try {
    const printed = await prepared.confirm()
    close(true)
    emit('result', printed)
  } catch (cause) {
    // An unavailable receipt is outcome_unknown. Close the stale preview so a
    // second native operation cannot be started against that unresolved job.
    close(true)
    emit('error', cause instanceof Error ? cause : new Error(String(cause)))
  } finally {
    state.value.printing = false
  }
}

onBeforeUnmount(() => close(true))
defineExpose({ open, close })
</script>

<template>
  <K12PrintPreviewModal
    :open="state.open"
    :title="state.title"
    :pdf="state.preparation?.pdf ?? null"
    :printing="state.printing"
    @close="close"
    @print="confirm"
  />
</template>
