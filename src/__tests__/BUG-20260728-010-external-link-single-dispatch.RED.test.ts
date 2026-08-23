import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const app = {
    component: vi.fn(),
    use: vi.fn(),
    mount: vi.fn(),
    config: {} as { errorHandler?: (...args: unknown[]) => void },
  }

  return {
    app,
    pinia: { use: vi.fn() },
    shellOpen: vi.fn<(href: string) => Promise<void>>(),
    windowOpen: vi.fn(),
  }
})

vi.mock('vue', () => ({
  createApp: vi.fn(() => harness.app),
}))

vi.mock('pinia', () => ({
  createPinia: vi.fn(() => harness.pinia),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: harness.shellOpen,
}))

vi.mock('../App.vue', () => ({ default: {} }))
vi.mock('../router', () => ({ default: {} }))
vi.mock('../i18n', () => ({ i18n: {} }))
vi.mock('../features/k12', () => ({ registerK12Scenario: vi.fn() }))
vi.mock('../components/common/HcClearableField.vue', () => ({ default: {} }))
vi.mock('../utils/input-autofix', () => ({ installInputAutofixOff: vi.fn() }))
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}))

function freshDocument(): Document {
  return document.implementation.createHTMLDocument('BUG-20260728-010')
}

async function installApplicationEntry(): Promise<void> {
  vi.resetModules()
  await import('../main')
}

function appendExternalLink(testDocument: Document): HTMLAnchorElement {
  const anchor = testDocument.createElement('a')
  anchor.href = 'https://hexclaw.net/zh/third-party-ai-services'
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  testDocument.body.append(anchor)

  return anchor
}

function dispatchExternalClick(testDocument: Document): MouseEvent {
  const anchor = appendExternalLink(testDocument)

  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  })
  anchor.dispatchEvent(event)
  return event
}

function dispatchExternalKeyboardActivation(
  testDocument: Document,
  key: 'Enter' | ' ',
): KeyboardEvent {
  const anchor = appendExternalLink(testDocument)
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  })
  anchor.dispatchEvent(event)
  return event
}

async function settleOpeners(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('BUG-20260728-010 外链一次激活只允许一个派发器', () => {
  let testDocument: Document

  beforeEach(() => {
    testDocument = freshDocument()
    vi.stubGlobal('document', testDocument)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      open: harness.windowOpen,
    })
    harness.shellOpen.mockReset()
    harness.windowOpen.mockReset()
    harness.app.component.mockClear()
    harness.app.use.mockClear()
    harness.app.mount.mockClear()
    harness.pinia.use.mockClear()
    delete (globalThis as Record<string, unknown>).isTauri
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).isTauri
    vi.unstubAllGlobals()
  })

  it('Tauri：单次外链事件只调用 shell 一次，绝不调用 window.open', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    harness.shellOpen.mockResolvedValue(undefined)
    await installApplicationEntry()

    const event = dispatchExternalClick(testDocument)
    await settleOpeners()

    expect(event.defaultPrevented).toBe(true)
    expect(harness.shellOpen).toHaveBeenCalledTimes(1)
    expect(harness.windowOpen).not.toHaveBeenCalled()
  }, 20_000)

  it('Tauri：shell 拒绝后也不回退 window.open，避免已产生副作用后重复打开', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    harness.shellOpen.mockRejectedValue(new Error('native bridge rejected after dispatch'))
    await installApplicationEntry()

    dispatchExternalClick(testDocument)
    await settleOpeners()

    expect(harness.shellOpen).toHaveBeenCalledTimes(1)
    expect(harness.windowOpen).not.toHaveBeenCalled()
  }, 20_000)

  it('Tauri：捕获阶段必须阻止冒泡的第二派发器处理同一次外链激活', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    harness.shellOpen.mockResolvedValue(undefined)
    await installApplicationEntry()
    const secondDispatcher = vi.fn((event: Event) => {
      void harness.shellOpen((event.target as HTMLAnchorElement).href)
    })
    testDocument.addEventListener('click', secondDispatcher)

    const event = dispatchExternalClick(testDocument)
    await settleOpeners()

    expect(event.defaultPrevented).toBe(true)
    expect(secondDispatcher).not.toHaveBeenCalled()
    expect(harness.shellOpen).toHaveBeenCalledTimes(1)
  }, 20_000)

  it.each([
    ['Enter', 'Enter' as const],
    ['Space', ' ' as const],
  ])('Tauri：%s 激活外链时只派发一次', async (_name, key) => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    harness.shellOpen.mockResolvedValue(undefined)
    await installApplicationEntry()

    const event = dispatchExternalKeyboardActivation(testDocument, key)
    await settleOpeners()

    expect(event.defaultPrevented).toBe(true)
    expect(harness.shellOpen).toHaveBeenCalledTimes(1)
    expect(harness.windowOpen).not.toHaveBeenCalled()
  }, 20_000)

  it('浏览器：单次外链事件只调用 window.open 一次，不探测 Tauri shell', async () => {
    harness.shellOpen.mockRejectedValue(new Error('not in Tauri'))
    await installApplicationEntry()

    dispatchExternalClick(testDocument)
    await settleOpeners()

    expect(harness.shellOpen).not.toHaveBeenCalled()
    expect(harness.windowOpen).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('重复安装共享控制器后，同一个事件仍然只派发一次', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    harness.shellOpen.mockResolvedValue(undefined)
    await installApplicationEntry()
    await installApplicationEntry()

    dispatchExternalClick(testDocument)
    await settleOpeners()

    expect(harness.shellOpen).toHaveBeenCalledTimes(1)
    expect(harness.windowOpen).not.toHaveBeenCalled()
  }, 20_000)

  it('两个独立事件分别派发一次，不把正常的后续点击误判为重复', async () => {
    ;(globalThis as Record<string, unknown>).isTauri = true
    harness.shellOpen.mockResolvedValue(undefined)
    await installApplicationEntry()

    dispatchExternalClick(testDocument)
    dispatchExternalClick(testDocument)
    await settleOpeners()

    expect(harness.shellOpen).toHaveBeenCalledTimes(2)
    expect(harness.windowOpen).not.toHaveBeenCalled()
  }, 20_000)
})
