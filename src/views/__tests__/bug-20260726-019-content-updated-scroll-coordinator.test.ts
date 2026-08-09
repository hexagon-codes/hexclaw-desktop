import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useConversationScrollCoordinator } from '@/composables/useConversationScrollCoordinator'

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return []
      return productionTypeScriptFiles(path)
    }
    return /\.(?:ts|vue)$/.test(entry.name) ? [path] : []
  })
}

describe('BUG-20260726-019 content-updated uses one anchor-aware scroll coordinator', () => {
  it('has exactly one production ConversationScrollCoordinator owner', () => {
    const candidates = productionTypeScriptFiles(resolve(process.cwd(), 'src')).filter((path) =>
      /(?:class|function|const)\s+(?:create|use)?ConversationScrollCoordinator\b/.test(
        readFileSync(path, 'utf8'),
      ),
    )

    expect(
      candidates.map((path) => path.replace(`${process.cwd()}/`, '')),
      'content growth currently has no unique ConversationScrollCoordinator owner',
    ).toHaveLength(1)

    if (candidates.length !== 1) return
    const coordinator = readFileSync(candidates[0]!, 'utf8')
    for (const requiredFact of [
      /atBottom/,
      /anchor/i,
      /viewportOffset/,
      /layoutEpoch/,
      /contentUpdated|content-updated/,
    ]) {
      expect(coordinator).toMatch(requiredFact)
    }
  })

  it('delegates TaskShell content growth instead of directly settling the page scroller', () => {
    const chat = source('src/views/ChatView.vue')
    const start = chat.indexOf('function handleScenarioContentUpdated')
    const end = chat.indexOf('\nfunction ', start + 1)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const handler = chat.slice(start, end)

    expect(chat).toMatch(/ConversationScrollCoordinator/)
    expect(handler).toMatch(/scrollCoordinator/i)
    expect(handler).not.toMatch(/scrollToBottom|scrollIntoView|scrollTop|setTimeout/)
  })

  it('follows the new bottom when the pre-layout snapshot was already at bottom', async () => {
    const container = document.createElement('div')
    const bottom = document.createElement('div')
    const scrollIntoView = vi.fn()
    bottom.scrollIntoView = scrollIntoView
    let scrollHeight = 1_000
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 600 },
    })
    const coordinator = useConversationScrollCoordinator({
      getContainer: () => container,
      getBottomAnchor: () => bottom,
      isAtBottom: () => true,
    })
    coordinator.recordScrollState()
    scrollHeight = 1_300
    coordinator.publishContentUpdated({
      conversationId: 'conversation-bottom',
      contentIdentity: 'task-shell-bottom',
      reason: 'pending-to-result',
    })
    await nextTick()

    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth' })
  })

  it('reveals a tall result from its top without letting the bottom anchor win', async () => {
    const container = document.createElement('div')
    const target = document.createElement('section')
    const bottom = document.createElement('div')
    const bottomScrollIntoView = vi.fn()
    const onRevealStart = vi.fn()
    bottom.scrollIntoView = bottomScrollIntoView
    container.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect
    target.getBoundingClientRect = () => ({ top: 180, bottom: 780 }) as DOMRect
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_400 },
      scrollTop: { configurable: true, writable: true, value: 600 },
    })
    const coordinator = useConversationScrollCoordinator({
      getContainer: () => container,
      getBottomAnchor: () => bottom,
      getRevealTarget: () => target,
      isAtBottom: () => true,
      onRevealStart,
    })
    coordinator.recordScrollState()
    coordinator.publishContentUpdated({
      conversationId: 'conversation-tall-result',
      contentIdentity: 'blank-worksheet-guide',
      reason: 'blank-guide-ready',
      reveal: 'start',
    })
    await nextTick()

    expect(container.scrollTop).toBe(680)
    expect(onRevealStart).toHaveBeenCalledOnce()
    expect(bottomScrollIntoView).not.toHaveBeenCalled()
  })

  it('compensates growth above the active upscroll anchor without jumping to bottom', async () => {
    const container = document.createElement('div')
    const anchor = document.createElement('article')
    const bottom = document.createElement('div')
    anchor.dataset.scrollAnchorId = 'message-anchor'
    container.append(anchor)
    const scrollIntoView = vi.fn()
    bottom.scrollIntoView = scrollIntoView
    let anchorTop = 100
    let scrollHeight = 1_000
    container.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect
    anchor.getBoundingClientRect = () =>
      ({ top: anchorTop, bottom: anchorTop + 80 }) as DOMRect
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 200 },
    })
    const coordinator = useConversationScrollCoordinator({
      getContainer: () => container,
      getBottomAnchor: () => bottom,
      isAtBottom: () => false,
    })
    coordinator.recordScrollState()
    anchorTop = 160
    scrollHeight = 1_060
    coordinator.publishContentUpdated({
      conversationId: 'conversation-anchor',
      contentIdentity: 'task-shell-anchor',
      reason: 'pending-to-result',
    })
    await nextTick()

    expect(container.scrollTop).toBe(260)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('lets a newer user intent invalidate an older pending layout epoch', async () => {
    const container = document.createElement('div')
    const anchor = document.createElement('article')
    const bottom = document.createElement('div')
    anchor.dataset.scrollAnchorId = 'message-user-intent'
    container.append(anchor)
    let anchorTop = 100
    let scrollHeight = 1_000
    container.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect
    anchor.getBoundingClientRect = () =>
      ({ top: anchorTop, bottom: anchorTop + 80 }) as DOMRect
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, writable: true, value: 200 },
    })
    const coordinator = useConversationScrollCoordinator({
      getContainer: () => container,
      getBottomAnchor: () => bottom,
      isAtBottom: () => false,
    })
    coordinator.recordScrollState()
    anchorTop = 160
    scrollHeight = 1_060
    coordinator.publishContentUpdated({
      conversationId: 'conversation-user-intent',
      contentIdentity: 'task-shell-user-intent',
      reason: 'pending-to-result',
    })
    container.scrollTop = 80
    coordinator.markUserIntent()
    await nextTick()

    expect(container.scrollTop).toBe(80)
  })
})
