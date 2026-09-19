<script setup lang="ts">
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ImagePreview from './ImagePreview.vue'
import { imagePreview, installImagePreview, closeImagePreview } from '@/composables/useImagePreview'

const route = useRoute()
const { t } = useI18n()
let dispose: (() => void) | undefined
onMounted(() => {
  dispose = installImagePreview(() => t('chat.previewImage'))
})
onBeforeUnmount(() => dispose?.())
watch(() => route.fullPath, closeImagePreview)
</script>

<template>
  <ImagePreview
    v-if="imagePreview"
    :key="imagePreview.id"
    :images="imagePreview.images"
    :initial-key="imagePreview.initialKey"
    :return-focus="imagePreview.returnFocus"
    @close="closeImagePreview"
  />
</template>
