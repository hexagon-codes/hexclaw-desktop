import { nextTick } from 'vue'

export interface ConversationContentUpdated {
  conversationId: string
  contentIdentity: string
  reason: string
}

interface ScrollSnapshot {
  atBottom: boolean
  anchorIdentity?: string
  viewportOffset?: number
  scrollTop: number
  scrollHeight: number
  intentRevision: number
}

export interface ConversationContentUpdateTicket extends ScrollSnapshot {
  conversationId: string
  contentIdentity: string
  reason: string
  layoutEpoch: number
}

interface ConversationScrollCoordinatorOptions {
  getContainer: () => HTMLElement | undefined
  getBottomAnchor: () => HTMLElement | undefined
  isAtBottom: () => boolean
  onFollowBottom?: () => void
}

const CONTENT_BOTTOM_TOLERANCE_PX = 100

function visibleAnchor(container: HTMLElement): {
  anchorIdentity?: string
  viewportOffset?: number
} {
  const viewport = container.getBoundingClientRect()
  const anchors = container.querySelectorAll<HTMLElement>('[data-scroll-anchor-id]')
  for (const anchor of anchors) {
    const rect = anchor.getBoundingClientRect()
    if (rect.bottom < viewport.top || rect.top > viewport.bottom) continue
    const anchorIdentity = anchor.dataset.scrollAnchorId
    if (!anchorIdentity) continue
    return {
      anchorIdentity,
      viewportOffset: rect.top - viewport.top,
    }
  }
  return {}
}

/**
 * Unique owner for asynchronous conversation-content growth.
 *
 * Producers publish contentUpdated only. This coordinator freezes the pre-layout
 * bottom/anchor facts, waits for the Vue layout epoch, then either follows the
 * bottom or restores the same visible anchor. A newer user intent invalidates an
 * older layoutEpoch so delayed work never pulls the viewport away from the user.
 */
export function useConversationScrollCoordinator(options: ConversationScrollCoordinatorOptions) {
  let layoutEpoch = 0
  let intentRevision = 0
  let latestPendingEpoch = 0
  let baseline: ScrollSnapshot | undefined

  function currentSnapshot(): ScrollSnapshot | undefined {
    const container = options.getContainer()
    if (!container) return undefined
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    const atBottom =
      options.isAtBottom() || distanceFromBottom <= CONTENT_BOTTOM_TOLERANCE_PX
    return {
      atBottom,
      ...visibleAnchor(container),
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      intentRevision,
    }
  }

  function recordScrollState() {
    baseline = currentSnapshot()
  }

  function markUserIntent() {
    intentRevision += 1
    recordScrollState()
  }

  function restoreAnchor(ticket: ConversationContentUpdateTicket) {
    const container = options.getContainer()
    if (!container) return
    if (!ticket.anchorIdentity || ticket.viewportOffset === undefined) {
      container.scrollTop = ticket.scrollTop
      return
    }
    const anchor = Array.from(
      container.querySelectorAll<HTMLElement>('[data-scroll-anchor-id]'),
    ).find((candidate) => candidate.dataset.scrollAnchorId === ticket.anchorIdentity)
    if (!anchor) {
      container.scrollTop = ticket.scrollTop
      return
    }
    const viewportTop = container.getBoundingClientRect().top
    const nextOffset = anchor.getBoundingClientRect().top - viewportTop
    container.scrollTop += nextOffset - ticket.viewportOffset
  }

  function settleContentUpdated(ticket: ConversationContentUpdateTicket) {
    if (
      ticket.layoutEpoch !== latestPendingEpoch ||
      ticket.intentRevision !== intentRevision
    ) {
      return
    }
    latestPendingEpoch = 0
    if (ticket.atBottom) {
      options.getBottomAnchor()?.scrollIntoView({ behavior: 'smooth' })
      options.onFollowBottom?.()
      baseline = {
        ...ticket,
        atBottom: true,
        anchorIdentity: undefined,
        viewportOffset: undefined,
      }
      return
    }
    restoreAnchor(ticket)
    baseline = currentSnapshot()
  }

  function publishContentUpdated(
    identity: ConversationContentUpdated,
  ): ConversationContentUpdateTicket {
    const beforeLayout = baseline ?? currentSnapshot()
    const ticket: ConversationContentUpdateTicket = {
      conversationId: identity.conversationId,
      contentIdentity: identity.contentIdentity,
      reason: identity.reason,
      layoutEpoch: ++layoutEpoch,
      atBottom: beforeLayout?.atBottom ?? true,
      anchorIdentity: beforeLayout?.anchorIdentity,
      viewportOffset: beforeLayout?.viewportOffset,
      scrollTop: beforeLayout?.scrollTop ?? 0,
      scrollHeight: beforeLayout?.scrollHeight ?? 0,
      intentRevision,
    }
    latestPendingEpoch = ticket.layoutEpoch
    void nextTick(() => settleContentUpdated(ticket))
    return ticket
  }

  function notifyLayoutObserved() {
    if (latestPendingEpoch !== 0) return
    const beforeLayout = baseline
    const current = currentSnapshot()
    if (!current) return
    // A browser layout pass or an earlier programmatic scroll may already have
    // landed on the real bottom without emitting a final scroll event. Reconcile
    // the shared navigation state from geometry instead of restoring a stale
    // pre-layout upscroll flag.
    if (current.atBottom) {
      options.onFollowBottom?.()
      baseline = current
      return
    }
    if (!beforeLayout) {
      baseline = current
      return
    }
    if (
      current.scrollHeight === beforeLayout.scrollHeight &&
      current.scrollTop === beforeLayout.scrollTop
    ) {
      baseline = current
      return
    }
    const ticket: ConversationContentUpdateTicket = {
      ...beforeLayout,
      conversationId: '',
      contentIdentity: 'observed-layout',
      reason: 'observed-layout',
      layoutEpoch: ++layoutEpoch,
    }
    latestPendingEpoch = ticket.layoutEpoch
    settleContentUpdated(ticket)
  }

  function reset() {
    layoutEpoch += 1
    latestPendingEpoch = 0
    intentRevision += 1
    baseline = undefined
    void nextTick(recordScrollState)
  }

  return {
    markUserIntent,
    notifyLayoutObserved,
    publishContentUpdated,
    recordScrollState,
    reset,
  }
}
