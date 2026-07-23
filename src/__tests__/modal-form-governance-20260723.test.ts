import { describe, expect, it } from 'vitest'
import clearableSource from '../components/common/HcClearableField.vue?raw'
import webhookSource from '../features/k12/views/K12WebhookPanel.vue?raw'
import worksSource from '../features/k12/views/K12CreativeWorksPanel.vue?raw'
import knowledgeSource from '../views/KnowledgeView.vue?raw'
import promptsSource from '../views/PromptsView.vue?raw'

describe('2026-07-23 modal form governance', () => {
  it('keeps the Prompt editor on the authoritative 600px full-width form track', () => {
    expect(promptsSource).toContain('data-testid="prompt-editor-dialog"')
    expect(promptsSource).toContain('class="hc-prompt-modal')
    expect(promptsSource).toMatch(
      /\.hc-prompt-modal\s*\{[^}]*width:\s*min\(600px,\s*calc\(100vw - 32px\)\)[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s,
    )
    expect(promptsSource).toMatch(
      /\.hc-modal-body\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box[^}]*overflow-y:\s*auto/s,
    )
    expect(promptsSource).toMatch(
      /\.hc-field\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s,
    )
    expect(promptsSource).toMatch(
      /\.hc-field input,[\s\S]*?\.hc-field textarea\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s,
    )
    expect(promptsSource).toMatch(
      /@media \(max-width:\s*560px\)[\s\S]*?\.hc-field--row\s*\{[^}]*flex-direction:\s*column/s,
    )
  })

  it('keeps the add-document dialog on one bounded full-width body track', () => {
    const start = knowledgeSource.indexOf('data-testid="knowledge-add-document-modal"')
    const end = knowledgeSource.indexOf('<!-- 删除确认 -->', start)
    const dialog = knowledgeSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(dialog).toContain('class="knowledge-add-document-modal')
    expect(dialog).toContain('class="knowledge-add-document-modal__body')
    expect(dialog).toContain('class="knowledge-add-document-modal__drop')
    expect(dialog).toContain('class="knowledge-add-document-modal__footer')
    expect(knowledgeSource).toMatch(
      /\.knowledge-add-document-modal\s*\{[^}]*max-height:\s*min\(760px,\s*calc\(100vh - 24px\)\)[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s,
    )
    expect(knowledgeSource).toMatch(
      /\.knowledge-add-document-modal__body\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow-y:\s*auto/s,
    )
  })

  it('keeps the K12 Webhook editor in a fixed header, scrolling body and fixed footer', () => {
    const start = webhookSource.indexOf('data-testid="k12-webhook-editor-dialog"')
    const end = webhookSource.indexOf('v-if="secretResult"', start)
    const dialog = webhookSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(dialog).toContain('class="k12wh__dialog k12wh__dialog--editor"')
    expect(dialog).toContain('class="k12wh__editor-body"')
    expect(dialog).toContain('class="k12wh__dialog-actions k12wh__editor-footer"')
    expect(dialog).toContain('data-testid="k12-webhook-editor-cancel"')
    expect(webhookSource).toMatch(
      /\.k12wh__dialog--editor\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto[^}]*overflow:\s*hidden/s,
    )
    expect(webhookSource).toMatch(
      /\.k12wh__editor-body\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow-y:\s*auto/s,
    )
    expect(webhookSource).toMatch(
      /\.k12wh__editor-body input:not\(\[type='checkbox'\]\)\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s,
    )
  })

  it('keeps the shared clearable field and approved K12 work forms intrinsically full width', () => {
    expect(clearableSource).toMatch(
      /\.hc-clearable-field\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s,
    )
    expect(clearableSource).toMatch(
      /\.hc-clearable-field :deep\(input\),[\s\S]*?:deep\(textarea\)\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s,
    )
    expect(worksSource).toMatch(
      /\.k12cw-modal__body\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box[^}]*overflow:\s*auto/s,
    )
    expect(worksSource).toMatch(
      /\.k12cw-detail-modal__body\s*\{[^}]*max-height:\s*62vh[^}]*overflow:\s*auto/s,
    )
  })
})
