<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import PdfAttachmentCard from '@/components/chat/PdfAttachmentCard.vue'
import { k12GetPrintArtifactContent, type PrintableArtifactDTO } from '@/api/k12'
import { backendScopeKey } from '@/services/backend-context'
import { useToast } from '@/composables/useToast'
import { prepareFinalArtifactOutput } from '../final-artifact-action'
import { safePdfFilename } from '../export'

const props = defineProps<{
  agent: string
  artifactId: string
  artifactDigest: string
  title: string
}>()
const artifact = shallowRef<PrintableArtifactDTO | null>(null)
const preparing = ref(false)
const toast = useToast()
const filename = computed(() => safePdfFilename(artifact.value?.title || props.title))
const sourceKey = computed(
  () => `${props.agent}\u0000${props.artifactId}\u0000${props.artifactDigest}\u0000${props.title}`,
)
let generation = 0
let request: AbortController | null = null
let pending: Promise<PrintableArtifactDTO> | null = null

function release() {
  generation++
  request?.abort()
  request = null
  pending = null
  artifact.value = null
  preparing.value = false
}
onBeforeUnmount(release)

function prepare(): Promise<PrintableArtifactDTO> {
  if (artifact.value) return Promise.resolve(artifact.value)
  if (pending) return pending
  const version = generation
  const current = new AbortController()
  request = current
  preparing.value = true
  const agent = props.agent
  pending = prepareFinalArtifactOutput(
    agent,
    {
      action: 'export_pdf',
      artifact_id: props.artifactId,
      artifact_digest: props.artifactDigest,
      artifact_title: props.title,
    },
    current.signal,
  )
    .then((result) => {
      if (current.signal.aborted || version !== generation)
        throw new DOMException('Report source changed', 'AbortError')
      artifact.value = result
      return result
    })
    .finally(() => {
      if (version === generation) {
        pending = null
        request = null
        preparing.value = false
      }
    })
  return pending
}

watch(
  () => [sourceKey.value, backendScopeKey()],
  () => {
    release()
    const version = generation
    void prepare().catch((error) => {
      if (
        version === generation &&
        !(error instanceof DOMException && error.name === 'AbortError')
      ) {
        toast.error(error instanceof Error ? error.message : 'Failed to prepare PDF report')
      }
    })
  },
  { immediate: true },
)

async function loadPdf(signal: AbortSignal) {
  const agent = props.agent
  const result = await prepare()
  return k12GetPrintArtifactContent(agent, result.artifact_id, signal)
}
</script>

<template>
  <PdfAttachmentCard
    :filename="filename"
    :source-key="sourceKey"
    :load-pdf="loadPdf"
    :preparing="preparing"
  />
</template>
