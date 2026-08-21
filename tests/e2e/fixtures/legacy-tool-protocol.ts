import { createApp, h } from 'vue'

import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import { i18n } from '@/i18n'
import '@/assets/styles/global.css'

const params = new URLSearchParams(window.location.search)
const state = params.get('state') === 'open' ? 'open' : 'closed'
const content =
  state === 'closed'
    ? `<function=code_exec>
<parameter=code>
print('hello from legacy code_exec')
</parameter>
</function>
</tool_call>`
    : `<function=code_exec><parameter=code>print('still streaming')`

const app = createApp({
  render() {
    return h(
      'main',
      {
        id: 'visual-compare-frame',
        'data-implementation-legacy-state': state,
      },
      [
        h(
          'div',
          {
            class: 'implementation-bubble',
            'data-legacy-tool-protocol-projection':
              state === 'closed' ? 'code-block' : 'raw-stream',
          },
          [h(MarkdownRenderer, { content, showArtifacts: false })],
        ),
      ],
    )
  },
})

app.use(i18n)
app.mount('#app')
