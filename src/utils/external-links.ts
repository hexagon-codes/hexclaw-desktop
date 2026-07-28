import { open as shellOpen } from '@tauri-apps/plugin-shell'

import { logger } from './logger'
import { isTauri } from './platform'

const CONTROLLER_KEY = Symbol.for('hexclaw.external-link-controller')

interface ExternalLinkControllerRegistration {
  uninstall: () => void
}

type DocumentWithExternalLinkController = Document & {
  [CONTROLLER_KEY]?: ExternalLinkControllerRegistration
}

function findAnchor(event: MouseEvent): HTMLAnchorElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement && target.hasAttribute('href')) return target
  }

  return event.target instanceof Element
    ? (event.target.closest('a[href]') as HTMLAnchorElement | null)
    : null
}

function isManagedExternalLink(anchor: HTMLAnchorElement): boolean {
  if (anchor.hasAttribute('download')) return false
  const href = anchor.getAttribute('href')
  return Boolean(href && !href.startsWith('#') && !href.startsWith('/'))
}

/**
 * Install the single external-link dispatcher for a document.
 *
 * A user activation has exactly one owner:
 * - Tauri calls the native shell opener once.
 * - Browser/dev calls window.open once.
 *
 * Native failures are logged but never retried through another opener because the
 * operating system may already have accepted the first request.
 */
export function installExternalLinkController(
  targetDocument: Document = document,
): () => void {
  const controlledDocument = targetDocument as DocumentWithExternalLinkController
  const installed = controlledDocument[CONTROLLER_KEY]
  if (installed) return installed.uninstall

  const consumedEvents = new WeakSet<Event>()

  const handleClick = (event: MouseEvent) => {
    if (event.button !== 0 || consumedEvents.has(event)) return

    const anchor = findAnchor(event)
    if (!anchor || !isManagedExternalLink(anchor)) return

    const href = anchor.getAttribute('href')
    if (!href) return

    consumedEvents.add(event)
    event.preventDefault()

    if (isTauri()) {
      void shellOpen(href).catch((error: unknown) => {
        logger.error('打开外部链接失败:', error)
      })
      return
    }

    window.open(href, '_blank')
  }

  let active = true
  const uninstall = () => {
    if (!active) return
    active = false
    targetDocument.removeEventListener('click', handleClick, true)
    if (controlledDocument[CONTROLLER_KEY]?.uninstall === uninstall) {
      delete controlledDocument[CONTROLLER_KEY]
    }
  }

  controlledDocument[CONTROLLER_KEY] = { uninstall }
  targetDocument.addEventListener('click', handleClick, true)
  return uninstall
}
