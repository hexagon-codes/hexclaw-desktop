import { shallowRef } from 'vue'

export interface PreviewImage {
  key: string
  src: string
  label: string
  width: number
  height: number
  marks?: Array<{
    left: string
    top: string
    transform: string
    text: string
    width: number
    height: number
    style: Record<string, string>
  }>
}

interface PreviewState {
  id: number
  images: PreviewImage[]
  initialKey: string
  returnFocus: HTMLElement
  group: Element
  groupIdentity: string | null
  sources: HTMLImageElement[]
}

// 全应用只持有一份临时预览状态；图片认证和 URL 回收仍属于原页面。
export const imagePreview = shallowRef<PreviewState>()
let generation = 0
const imageSelector = 'img[data-image-preview]'

export function closeImagePreview() {
  imagePreview.value = undefined
}

export function releaseImagePreviewResource(src: string) {
  if (imagePreview.value?.images.some((image) => image.src === src)) closeImagePreview()
}

function readImage(image: HTMLImageElement, fallbackLabel: string): PreviewImage {
  const ratio = image.naturalWidth / image.getBoundingClientRect().width
  const canvas = image.closest('.pg-overlay__canvas')
  // 旧版 DOM 批注保持原来符号、底色、描边与几何，仅整体映射到原图像素坐标。
  const marks = Array.from(canvas?.querySelectorAll<HTMLElement>('.pg-overlay__mark') ?? []).map(
    (mark) => {
      const symbol = mark.querySelector<HTMLElement>('.pg-overlay__sym') ?? mark
      const computed = getComputedStyle(symbol)
      const properties = [
        'display',
        'width',
        'height',
        'padding',
        'box-sizing',
        'place-items',
        'color',
        'background',
        'border-radius',
        'font-family',
        'font-size',
        'font-weight',
        'line-height',
        'letter-spacing',
        'text-shadow',
        '-webkit-text-stroke',
        'box-shadow',
      ]
      const style = Object.fromEntries(
        properties.map((property) => [property, computed.getPropertyValue(property)]),
      )
      Object.assign(style, { transform: `scale(${ratio})`, transformOrigin: 'top left' })
      return {
        left: mark.style.left,
        top: mark.style.top,
        transform: mark.style.transform,
        text: symbol.textContent?.trim() ?? '',
        width: mark.offsetWidth * ratio,
        height: mark.offsetHeight * ratio,
        style,
      }
    },
  )
  const src = image.currentSrc || image.src
  return {
    key: image.dataset.previewKey || src,
    src,
    label: image.dataset.previewLabel || image.alt || fallbackLabel,
    width: image.naturalWidth,
    height: image.naturalHeight,
    marks,
  }
}

export function installImagePreview(fallbackLabel: () => string) {
  function open(event: Event) {
    if (event instanceof KeyboardEvent) {
      document.querySelectorAll('[data-preview-pointer-focus]').forEach((element) => {
        element.removeAttribute('data-preview-pointer-focus')
      })
    }
    if (
      event instanceof KeyboardEvent &&
      (event.isComposing || !['Enter', ' '].includes(event.key))
    )
      return
    const element = event.target instanceof Element ? event.target : null
    const target =
      element?.closest<HTMLImageElement>(imageSelector) ??
      element
        ?.closest('[data-image-preview-trigger]')
        ?.querySelector<HTMLImageElement>(imageSelector)
    if (!target?.complete || !target.naturalWidth) return
    const group =
      target.closest('[data-image-preview-group]') ?? target.closest('.markdown-body') ?? target
    const candidates = group.matches(imageSelector)
      ? [target]
      : Array.from(group.querySelectorAll<HTMLImageElement>(imageSelector))
    const images: PreviewImage[] = [],
      sources: HTMLImageElement[] = []
    const keys = new Set<string>()
    let initialKey = ''
    for (const image of candidates) {
      if (!image.complete || !image.naturalWidth || !image.getClientRects().length) continue
      const entry = readImage(image, fallbackLabel())
      if (image === target) initialKey = entry.key
      if (keys.has(entry.key)) continue
      keys.add(entry.key)
      images.push(entry)
      sources.push(image)
    }
    if (!initialKey) return
    event.preventDefault()
    event.stopPropagation()
    const trigger = target.closest<HTMLElement>('[data-image-preview-trigger]') ?? target
    trigger.toggleAttribute('data-preview-pointer-focus', !(event instanceof KeyboardEvent))
    trigger.focus({ preventScroll: true })
    imagePreview.value = {
      id: ++generation,
      images,
      initialKey,
      returnFocus: trigger,
      group,
      groupIdentity: group.getAttribute('data-image-preview-group'),
      sources,
    }
  }
  // 详情弹窗和图片链接的原有事件不能同时响应图片预览。
  document.addEventListener('click', open, true)
  document.addEventListener('keydown', open, true)
  const observer = new MutationObserver(() => {
    const state = imagePreview.value
    if (!state) return
    if (
      !state.returnFocus.isConnected ||
      !state.group.isConnected ||
      !state.group.getClientRects().length ||
      state.group.getAttribute('data-image-preview-group') !== state.groupIdentity ||
      state.sources.some(
        (source, index) =>
          !source.isConnected || (source.currentSrc || source.src) !== state.images[index]?.src,
      )
    ) {
      closeImagePreview()
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'hidden', 'style', 'class', 'data-image-preview-group'],
  })
  return () => {
    document.removeEventListener('click', open, true)
    document.removeEventListener('keydown', open, true)
    observer.disconnect()
    closeImagePreview()
  }
}
