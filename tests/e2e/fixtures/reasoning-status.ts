import { createApp, h } from 'vue'

import AssistantRunStatus from '@/components/chat/AssistantRunStatus.vue'
import { i18n } from '@/i18n'
import type { ReasoningExecution, ReasoningRequest } from '@/types/chat'
import type { ModelReasoningSupport } from '@/types/settings'
import '@/assets/styles/global.css'

const params = new URLSearchParams(window.location.search)
const surface = params.get('surface') === 'quick-chat' ? 'quick-chat' : 'chat'
const reasoningRequest = (params.get('request') ?? 'off') as ReasoningRequest
const reasoningSupport = (params.get('support') ?? 'unknown') as ModelReasoningSupport
const reasoningExecution = (params.get('execution') ?? 'unknown') as ReasoningExecution
const hasVisibleAnswer = params.get('answer') === 'true'

const app = createApp({
  render() {
    return h(
      'main',
      {
        id: 'visual-compare-frame',
        class: ['visual-compare-frame', `visual-compare-frame--${surface}`],
        'data-surface': surface,
      },
      [
        h('div', { 'data-implementation-status-host': '' }, [
          h(AssistantRunStatus, {
            reasoningRequest,
            reasoningSupport,
            reasoningExecution,
            hasVisibleAnswer,
            elapsedSeconds: 19,
          }),
        ]),
        hasVisibleAnswer
          ? h(
              'div',
              {
                class: 'visual-answer',
                'data-reasoning-answer': '',
              },
              '这是首个可渲染回答正文。',
            )
          : null,
      ],
    )
  },
})

app.use(i18n)
app.mount('#app')
