import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ArtifactPreview from '../ArtifactPreview.vue'

describe('ArtifactPreview', () => {
  it('renders sanitized iframe preview without script execution affordance', () => {
    const wrapper = mount(ArtifactPreview, {
      props: {
        artifact: {
          id: 'artifact-1',
          type: 'html',
          title: 'Preview Demo',
          content: '<h1>Hello</h1><script>alert(1)</script>',
          messageId: 'msg-1',
          createdAt: new Date().toISOString(),
        },
      },
    })

    expect(wrapper.text()).not.toContain('Run')

    const iframe = wrapper.get('iframe')
    expect(iframe.attributes('title')).toBe('Preview Demo')
    expect(iframe.attributes('sandbox')).toBe('')
    expect(iframe.attributes('srcdoc')).toContain('Hello')
    expect(iframe.attributes('srcdoc')).not.toContain('<script')
  })
})
