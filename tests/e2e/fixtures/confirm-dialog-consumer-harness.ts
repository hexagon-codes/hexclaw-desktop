import { createApp } from 'vue'
import ConfirmDialogConsumerHarness from './ConfirmDialogConsumerHarness.vue'
import '@/assets/styles/global.css'

document.documentElement.setAttribute('data-theme', 'light')
createApp(ConfirmDialogConsumerHarness).mount('#app')
