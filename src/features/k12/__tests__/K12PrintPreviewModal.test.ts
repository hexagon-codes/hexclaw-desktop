import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import K12PrintPreviewModal from '../components/K12PrintPreviewModal.vue'

describe('K12PrintPreviewModal', () => {
  it('shows an A4 PDF preview and only emits print after explicit confirmation', async () => {
    const wrapper = mount(K12PrintPreviewModal, {
      props: {
        open: true,
        title: '本周错题卷',
        pdfUrl: 'blob:worksheet.pdf',
      },
    })

    const dialog = document.body.querySelector<HTMLElement>('[data-testid="k12-print-preview"]')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toBe(
      'blob:worksheet.pdf',
    )
    expect(wrapper.emitted('print')).toBeUndefined()

    await document.body.querySelector<HTMLButtonElement>('[data-testid="k12-print-preview-print"]')!.click()
    expect(wrapper.emitted('print')).toHaveLength(1)
    wrapper.unmount()
  })

  it('closes without emitting print', async () => {
    const wrapper = mount(K12PrintPreviewModal, {
      props: { open: true, title: '本周错题卷', pdfUrl: 'blob:worksheet.pdf' },
    })

    const closeButtons = document.body.querySelectorAll<HTMLButtonElement>('[data-testid="k12-print-preview-close"]')
    await closeButtons[closeButtons.length - 1]!.click()
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('print')).toBeUndefined()
  })
})
