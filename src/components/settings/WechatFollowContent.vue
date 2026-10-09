<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import qrUrl from '@/assets/hexclaw-wechat-qr.png'
const { t } = useI18n()
</script>

<template>
  <!-- 原始码点与静区共用一份资源；主题变化只改变周围文本，不反色或裁切二维码。 -->
  <div class="wechat-follow">
    <img :src="qrUrl" :alt="t('settings.experience.qrAlt')" width="240" height="240" />
    <strong>hexclaw</strong>
    <p>{{ t('settings.experience.qrInstruction') }}</p>
  </div>
</template>

<style scoped>
.wechat-follow{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.wechat-follow img{display:block;max-width:100%;height:auto;object-fit:contain;background:#fff}
.wechat-follow strong{font-size:14px;color:var(--hc-text-primary)}
.wechat-follow p{margin:0;color:var(--hc-text-secondary);font-size:12px;line-height:1.5}
</style>
