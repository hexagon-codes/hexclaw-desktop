<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { TeachingDiagramAssetDTO } from '@/api/k12'
import { k12GetAssetBlob } from '@/api/k12-asset-url'

const props = defineProps<{ diagram: TeachingDiagramAssetDTO }>()
const source = ref('')
let controller: AbortController | undefined

function release() {
  controller?.abort()
  if (source.value) URL.revokeObjectURL(source.value)
  source.value = ''
}

// 使用既有认证资产通道；异步旧请求不能覆盖新题图片，卸载时释放本地对象URL。
watch(() => props.diagram.asset_id, async (id) => {
  release()
  const current = new AbortController()
  controller = current
  const owner = id.startsWith('asset://') ? id.slice('asset://'.length, id.lastIndexOf('/')) : ''
  if (!owner || props.diagram.mime !== 'image/svg+xml') return
  const blob = await k12GetAssetBlob(owner, id, current.signal)
  if (blob && !current.signal.aborted) source.value = URL.createObjectURL(blob)
}, { immediate: true })

onBeforeUnmount(release)
</script>

<template>
  <figure v-if="source" class="teaching-diagram">
    <img :src="source" :alt="diagram.alt_text" :width="diagram.width" :height="diagram.height" />
  </figure>
</template>

<style scoped>
.teaching-diagram { width: 100%; margin: 8px 0; }
.teaching-diagram img { display: block; width: 100%; height: auto; object-fit: contain; }
</style>
