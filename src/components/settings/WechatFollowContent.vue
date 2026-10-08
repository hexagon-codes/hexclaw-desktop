<script setup lang="ts">
import qrUrl from '@/assets/hexclaw-wechat-qr.png'
</script>

<template>
  <!-- 原始码点与静区共用一份资源；主题变化只改变周围文本，不反色或裁切二维码。 -->
  <div class="wechat-follow">
    <img :src="qrUrl" alt="hexclaw 微信公众号二维码" width="240" height="240" />
    <strong>hexclaw</strong>
    <p>使用微信扫一扫</p>
  </div>
</template>

<style scoped>
.wechat-follow{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.wechat-follow img{display:block;max-width:100%;height:auto;object-fit:contain;background:#fff}
.wechat-follow strong{font-size:14px;color:var(--hc-text-primary)}
.wechat-follow p{margin:0;color:var(--hc-text-secondary);font-size:12px;line-height:1.5}
</style>
