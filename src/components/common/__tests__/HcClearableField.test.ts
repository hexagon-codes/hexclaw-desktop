import { defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import HcClearableField from '../HcClearableField.vue'
import clearableSource from '../HcClearableField.vue?raw'

function mountTextField(initial = 'filled') {
  return mount(defineComponent({
    components: { HcClearableField },
    setup() {
      return { value: ref(initial) }
    },
    template: `
      <HcClearableField>
        <input v-model="value" data-testid="field" />
      </HcClearableField>
    `,
  }), { attachTo: document.body })
}

describe('HcClearableField', () => {
  it('owns a full-width, min-width-safe field contract for every slotted input and textarea', () => {
    expect(clearableSource).toMatch(
      /\.hc-clearable-field\s+:deep\(input\),[\s\S]*?\.hc-clearable-field\s+:deep\(textarea\)\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*box-sizing:\s*border-box/s,
    )
  })

  it('shows a real clear button only while an editable field has content', async () => {
    const wrapper = mountTextField()
    await nextTick()
    expect(wrapper.get('button').attributes('aria-label')).toBe('Clear input')

    await wrapper.get('input').setValue('')
    expect(wrapper.find('button').exists()).toBe(false)

    wrapper.unmount()
  })

  it('clears through the native input event and keeps focus in the field', async () => {
    const wrapper = mountTextField()
    await nextTick()
    const input = wrapper.get<HTMLInputElement>('input')

    await wrapper.get('button').trigger('click')

    expect((wrapper.vm as unknown as { value: string }).value).toBe('')
    expect(input.element.value).toBe('')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('supports textarea fields with the same clear semantics', async () => {
    const wrapper = mount(defineComponent({
      components: { HcClearableField },
      setup() {
        return { value: ref('multiline') }
      },
      template: `
        <HcClearableField>
          <textarea v-model="value" data-testid="field" />
        </HcClearableField>
      `,
    }))
    await nextTick()

    await wrapper.get('button').trigger('click')

    expect((wrapper.vm as unknown as { value: string }).value).toBe('')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it.each(['disabled', 'readonly'] as const)('does not offer clearing for %s fields', (state) => {
    const wrapper = mount(defineComponent({
      components: { HcClearableField },
      template: `
        <HcClearableField>
          <input value="protected" ${state} />
        </HcClearableField>
      `,
    }))

    expect(wrapper.find('button').exists()).toBe(false)
  })
})
