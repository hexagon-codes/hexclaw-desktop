import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MessageText from '../MessageText.vue'
import messageTextSource from '../MessageText.vue?raw'
import zhCN from '@/i18n/locales/zh-CN'
import { plainMathSegmentsWithSourceSpans } from '@/utils/math-content'

const SOURCE = String.raw`修路队第一天修了 $2\frac{3}{4}$ 千米，第二天多修 $1\frac{1}{2}$ 千米。`
const FORMULAS = [String.raw`2\frac{3}{4}`, String.raw`1\frac{1}{2}`]

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': zhCN, zh: zhCN },
  })
}

function mountEditor(content = SOURCE) {
  return mount(MessageText, {
    props: {
      content,
      editable: true,
      'onUpdate:content': (content: string) => wrapper.setProps({ content }),
    },
    global: { plugins: [i18n()] },
    attachTo: document.body,
  })
}

let wrapper: ReturnType<typeof mount<typeof MessageText>>

afterEach(() => {
  wrapper?.unmount()
  window.getSelection()?.removeAllRanges()
})

function visibleProjection(element: Element): string {
  const clone = element.cloneNode(true) as Element
  clone.querySelectorAll('.katex-mathml, annotation').forEach((node) => node.remove())
  return clone.textContent ?? ''
}

function setSelection(node: Node, start: number, end = start) {
  const selection = window.getSelection()!
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  selection.removeAllRanges()
  selection.addRange(range)
}

function transfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => {
      data.set(type, value)
    },
  }
}

function dragEvent(type: string, dataTransfer: ReturnType<typeof transfer>, x = 0, y = 0) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

describe('MessageText editable canonical math projection', () => {
  it('preserves exact legacy delimiter and vulgar-fraction source spans during projection', () => {
    const source = String.raw`A \(x\) B \[\frac{3}{4}\] C ½ D`
    const sourceSegments = plainMathSegmentsWithSourceSpans(source)
      .filter((segment) => segment.type === 'math')
    wrapper = mountEditor(source)
    const editor = wrapper.get('[data-testid="message-math-editor"]')

    expect(
      sourceSegments.map((segment) => ({
        source: segment.source,
        sourceStart: segment.sourceStart,
        sourceEnd: segment.sourceEnd,
        canonicalSlice: source.slice(segment.sourceStart, segment.sourceEnd),
      })),
    ).toEqual([
      { source: String.raw`\(x\)`, sourceStart: 2, sourceEnd: 7, canonicalSlice: String.raw`\(x\)` },
      {
        source: String.raw`\[\frac{3}{4}\]`,
        sourceStart: 10,
        sourceEnd: 25,
        canonicalSlice: String.raw`\[\frac{3}{4}\]`,
      },
      { source: '½', sourceStart: 28, sourceEnd: 29, canonicalSlice: '½' },
    ])
    expect(editor.attributes('data-canonical-source')).toBe(source)
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(3)
    expect(
      editor
        .findAll('[data-edit-math-state="rendered"]')
        .map((formula) => formula.attributes('data-formula-markdown')),
    ).toEqual([String.raw`\(x\)`, String.raw`\[\frac{3}{4}\]`, '½'])
    expect(
      editor
        .findAll('annotation[encoding="application/x-tex"]')
        .map((annotation) => annotation.text()),
    ).toEqual(['x', String.raw`\frac{3}{4}`, String.raw`\frac{1}{2}`])
  })

  it.each([
    [String.raw`\(x\)`, String.raw`A \(x\) B`],
    [String.raw`\[\frac{3}{4}\]`, String.raw`A \[\frac{3}{4}\] B`],
    ['½', 'A ½ B'],
  ])('copies %s as its exact canonical source span', (expectedFormula, source) => {
    wrapper = mountEditor(source)
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formula = editor.get('[data-edit-math-state="rendered"]').element
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNode(formula)
    selection.removeAllRanges()
    selection.addRange(range)
    const setData = vi.fn()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { setData, getData: vi.fn() },
    })

    editor.element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/plain', expectedFormula)
  })

  it.each([
    String.raw`\(x\)`,
    String.raw`\[\frac{3}{4}\]`,
    '½',
  ])('deletes %s by its exact canonical span as one atom', async (formulaSource) => {
    wrapper = mountEditor(`A ${formulaSource} B`)
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formula = editor.get('[data-edit-math-state="rendered"]').element
    const childIndex = Array.from(editor.element.childNodes).indexOf(formula)
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(editor.element, childIndex + 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.props('content')).toBe('A  B')
  })

  it('enters one editable surface with complete formulas rendered and canonical source unchanged', () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')

    expect(editor.attributes('contenteditable')).toBe('true')
    expect(editor.attributes('data-canonical-source')).toBe(SOURCE)
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(2)
    expect(
      editor
        .findAll('annotation[encoding="application/x-tex"]')
        .map((annotation) => annotation.text()),
    ).toEqual(FORMULAS)
    expect(visibleProjection(editor.element)).not.toContain(String.raw`\frac`)
  })

  it('activates only the selected formula as canonical source and re-renders its edited value', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formulas = editor.findAll('[data-edit-math-state="rendered"]')

    await formulas[1]!.trigger('click')

    const active = editor.get('[data-edit-math-state="source-active"]')
    expect(active.text()).toBe(String.raw`$1\frac{1}{2}$`)
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(1)

    active.element.textContent = String.raw`$1\frac{3}{4}$`
    await active.trigger('input')
    await editor.trigger('focusout')

    expect(wrapper.props('content')).toBe(
      String.raw`修路队第一天修了 $2\frac{3}{4}$ 千米，第二天多修 $1\frac{3}{4}$ 千米。`,
    )
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(2)
    expect(
      editor
        .findAll('annotation[encoding="application/x-tex"]')
        .map((annotation) => annotation.text()),
    ).toEqual([FORMULAS[0], String.raw`1\frac{3}{4}`])
  })

  it('activates the owning formula when a deeply nested KaTeX fraction node is clicked', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const secondFormula = editor.findAll('[data-edit-math-state="rendered"]')[1]!
    const deepFractionNode = secondFormula.find('.frac-line')
    expect(deepFractionNode.exists()).toBe(true)

    await deepFractionNode.trigger('click')

    expect(editor.get('[data-edit-math-state="source-active"]').text()).toBe(
      String.raw`$1\frac{1}{2}$`,
    )
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(1)
  })

  it('copies a rendered formula as its exact canonical source', () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formula = editor.findAll('[data-edit-math-state="rendered"]')[0]!.element
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNode(formula)
    selection.removeAllRanges()
    selection.addRange(range)
    const setData = vi.fn()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { setData, getData: vi.fn() },
    })

    editor.element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(setData).toHaveBeenCalledWith('text/plain', String.raw`$2\frac{3}{4}$`)
  })

  it('deletes a rendered formula as one canonical atom with Backspace', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const firstFormula = editor.findAll('[data-edit-math-state="rendered"]')[0]!.element
    const childIndex = Array.from(editor.element.childNodes).indexOf(firstFormula)
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(editor.element, childIndex + 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.props('content')).toBe(
      String.raw`修路队第一天修了  千米，第二天多修 $1\frac{1}{2}$ 千米。`,
    )
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(1)
  })

  it('keeps an incomplete active formula as editable canonical source without losing text', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    await editor.findAll('[data-edit-math-state="rendered"]')[1]!.trigger('click')
    const active = editor.get('[data-edit-math-state="source-active"]')
    active.element.textContent = String.raw`$1\frac{3}{`
    await active.trigger('input')
    await editor.trigger('focusout')

    expect(wrapper.props('content')).toBe(
      String.raw`修路队第一天修了 $2\frac{3}{4}$ 千米，第二天多修 $1\frac{3}{ 千米。`,
    )
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(1)
    expect(editor.text()).toContain(String.raw`$1\frac{3}{`)
  })

  it('undoes canonical formula edits without reading back KaTeX DOM', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    await editor.findAll('[data-edit-math-state="rendered"]')[1]!.trigger('click')
    const active = editor.get('[data-edit-math-state="source-active"]')
    active.element.textContent = String.raw`$1\frac{3}{4}$`
    await active.trigger('input')
    await editor.trigger('focusout')
    expect(wrapper.props('content')).toContain(String.raw`$1\frac{3}{4}$`)

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.props('content')).toBe(SOURCE)
    expect(
      editor
        .findAll('annotation[encoding="application/x-tex"]')
        .map((annotation) => annotation.text()),
    ).toEqual(FORMULAS)

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()
    expect(wrapper.props('content')).toContain(String.raw`$1\frac{3}{4}$`)
  })

  it('keeps undo and redo at canonical history boundaries instead of falling through to DOM history', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    await editor.findAll('[data-edit-math-state="rendered"]')[1]!.trigger('click')
    const active = editor.get('[data-edit-math-state="source-active"]')
    active.element.textContent = String.raw`$1\frac{3}{4}$`
    await active.trigger('input')
    await editor.trigger('focusout')

    const dispatchHistoryKey = async (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        metaKey: true,
        ...init,
      })
      editor.element.dispatchEvent(event)
      await wrapper.vm.$nextTick()
      return event
    }

    expect((await dispatchHistoryKey({ key: 'z' })).defaultPrevented).toBe(true)
    expect(wrapper.props('content')).toBe(SOURCE)
    expect((await dispatchHistoryKey({ key: 'z' })).defaultPrevented).toBe(true)
    expect(wrapper.props('content')).toBe(SOURCE)

    expect((await dispatchHistoryKey({ key: 'z', shiftKey: true })).defaultPrevented).toBe(true)
    expect(wrapper.props('content')).toContain(String.raw`$1\frac{3}{4}$`)
    expect((await dispatchHistoryKey({ key: 'z', shiftKey: true })).defaultPrevented).toBe(true)
    expect(wrapper.props('content')).toContain(String.raw`$1\frac{3}{4}$`)

    const menuRedoAtBoundary = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'historyRedo',
    })
    editor.element.dispatchEvent(menuRedoAtBoundary)
    expect(menuRedoAtBoundary.defaultPrevented).toBe(true)
    expect(wrapper.props('content')).toContain(String.raw`$1\frac{3}{4}$`)
  })

  it('reprojects an active formula when IME composition ends after focus already left the editor', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const outside = document.createElement('button')
    document.body.append(outside)

    await editor.findAll('[data-edit-math-state="rendered"]')[1]!.trigger('click')
    const active = editor.get('[data-edit-math-state="source-active"]')
    await active.trigger('compositionstart')
    active.element.textContent = String.raw`$1\frac{3}{4}$`
    await active.trigger('input')
    outside.focus()
    await editor.trigger('focusout', { relatedTarget: outside })

    expect(editor.findAll('[data-edit-math-state="source-active"]')).toHaveLength(1)
    await active.trigger('compositionend')

    expect(editor.findAll('[data-edit-math-state="source-active"]')).toHaveLength(0)
    expect(editor.findAll('[data-edit-math-state="rendered"]')).toHaveLength(2)
    expect(wrapper.props('content')).toContain(String.raw`$1\frac{3}{4}$`)
    outside.remove()
  })

  it('coalesces one IME composition into one canonical undo transaction', async () => {
    wrapper = mountEditor('A')
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const text = editor.get('[data-edit-text]').element.firstChild!
    setSelection(text, 1)

    await editor.trigger('compositionstart')
    text.textContent = 'A中'
    await editor.trigger('input')
    text.textContent = 'A中文'
    await editor.trigger('input')
    await editor.trigger('compositionend')
    expect(wrapper.props('content')).toBe('A中文')

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.props('content')).toBe('A')
  })

  it.each([
    [String.raw`$x$`, 1],
    [`$$\nx\n$$`, 3],
    [String.raw`\(x\)`, 2],
    [String.raw`\[x\]`, 2],
  ])('places the caret at the content start when clicking %s', async (formulaSource, offset) => {
    wrapper = mountEditor(`A ${formulaSource} B`)
    const editor = wrapper.get('[data-testid="message-math-editor"]')

    await editor.get('[data-edit-math-state="rendered"]').trigger('click')

    const active = editor.get('[data-edit-math-state="source-active"]')
    expect(window.getSelection()?.anchorNode).toBe(active.element.firstChild)
    expect(window.getSelection()?.anchorOffset).toBe(offset)
  })

  it.each([
    [String.raw`$x$`, 1],
    [`$$\nx\n$$`, 3],
    [String.raw`\(x\)`, 2],
    [String.raw`\[x\]`, 2],
  ])('places the caret at the content start when ArrowRight enters %s', async (formulaSource, offset) => {
    wrapper = mountEditor(`A ${formulaSource} B`)
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formula = editor.get('[data-edit-math-state="rendered"]').element
    const childIndex = Array.from(editor.element.childNodes).indexOf(formula)
    setSelection(editor.element, childIndex)

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()

    const active = editor.get('[data-edit-math-state="source-active"]')
    expect(window.getSelection()?.anchorNode).toBe(active.element.firstChild)
    expect(window.getSelection()?.anchorOffset).toBe(offset)
  })

  it.each([
    [String.raw`$x$`, 2],
    [`$$\nx\n$$`, 4],
    [String.raw`\(x\)`, 3],
    [String.raw`\[x\]`, 3],
  ])('places the caret at the content end when ArrowLeft enters %s', async (formulaSource, offset) => {
    wrapper = mountEditor(`A ${formulaSource} B`)
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formula = editor.get('[data-edit-math-state="rendered"]').element
    const childIndex = Array.from(editor.element.childNodes).indexOf(formula)
    setSelection(editor.element, childIndex + 1)

    editor.element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    }))
    await wrapper.vm.$nextTick()

    const active = editor.get('[data-edit-math-state="source-active"]')
    expect(window.getSelection()?.anchorNode).toBe(active.element.firstChild)
    expect(window.getSelection()?.anchorOffset).toBe(offset)
  })

  it('keeps a display formula block-level while its canonical source is active', async () => {
    const displaySource = String.raw`推导：$$
\frac{\frac{1}{2}}{\frac{3}{4}}
$$完成。`
    wrapper = mount(MessageText, {
      props: {
        content: displaySource,
        editable: true,
        'onUpdate:content': (content: string) => wrapper.setProps({ content }),
      },
      global: { plugins: [i18n()] },
      attachTo: document.body,
    })
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const formula = editor.get('[data-edit-math-state="rendered"]')

    expect(formula.classes()).toContain('hc-msg__math--display')
    expect(messageTextSource).toMatch(
      /\.hc-msg__text--editable\s+:deep\(\.hc-msg__math--display\)\s*\{/,
    )
    await formula.trigger('click')

    const active = editor.get('[data-edit-math-state="source-active"]')
    expect(active.text()).toBe(String.raw`$$
\frac{\frac{1}{2}}{\frac{3}{4}}
$$`)
    expect(messageTextSource).toMatch(
      /\.hc-msg__text--editable\s+:deep\(\.hc-msg__math-source\)\s*\{/,
    )
    expect(active.classes()).toContain('hc-msg__math-source--display')
    expect(messageTextSource).toMatch(
      /\.hc-msg__text--editable\s+:deep\(\.hc-msg__math-source--display\)\s*\{[^}]*display:\s*block/s,
    )
    const selection = window.getSelection()
    expect(selection?.anchorNode).toBe(active.element.firstChild)
    expect(selection?.anchorOffset).toBe(3)
  })

  it('activates the formula that was clicked even when the prior edit stops being a formula', async () => {
    wrapper = mountEditor()
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const rendered = editor.findAll('[data-edit-math-state="rendered"]')
    const secondFormula = rendered[1]!

    await rendered[0]!.trigger('click')
    const firstSource = editor.get('[data-edit-math-state="source-active"]')
    firstSource.element.textContent = '普通文本'
    await firstSource.trigger('input')
    await secondFormula.trigger('click')

    expect(editor.findAll('[data-edit-math-state="source-active"]')).toHaveLength(1)
    expect(editor.get('[data-edit-math-state="source-active"]').text()).toBe(
      String.raw`$1\frac{1}{2}$`,
    )
  })

  it('inserts an external drop at the browser-reported drop caret', async () => {
    wrapper = mountEditor('abcd')
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const text = editor.get('[data-edit-text]').element.firstChild!
    setSelection(text, 0)
    const original = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 2 }),
    })

    try {
      editor.element.dispatchEvent(dragEvent('drop', transfer({ 'text/plain': 'X' }), 20, 10))
      await wrapper.vm.$nextTick()
      expect(wrapper.props('content')).toBe('abXcd')
    } finally {
      if (original) Object.defineProperty(document, 'caretPositionFromPoint', original)
      else Reflect.deleteProperty(document, 'caretPositionFromPoint')
    }
  })

  it('moves an internal drag as one undoable canonical transaction', async () => {
    wrapper = mountEditor('abcd')
    const editor = wrapper.get('[data-testid="message-math-editor"]')
    const text = editor.get('[data-edit-text]').element.firstChild!
    setSelection(text, 1, 3)
    const dataTransfer = transfer()
    editor.element.dispatchEvent(dragEvent('dragstart', dataTransfer))
    const original = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 4 }),
    })

    try {
      editor.element.dispatchEvent(dragEvent('drop', dataTransfer, 40, 10))
      await wrapper.vm.$nextTick()
      expect(wrapper.props('content')).toBe('adbc')

      editor.element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }))
      await wrapper.vm.$nextTick()
      expect(wrapper.props('content')).toBe('abcd')
    } finally {
      if (original) Object.defineProperty(document, 'caretPositionFromPoint', original)
      else Reflect.deleteProperty(document, 'caretPositionFromPoint')
    }
  })
})
