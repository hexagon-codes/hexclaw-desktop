// 主布局和首次配置共用启动遮罩生命周期。
const MIN_SPLASH_MS = 700

export function dismissSplash() {
  const splash = document.getElementById('splash-screen')
  if (splash) {
    if (splash.classList.contains('fade-out')) return
    const elapsed = performance.now() - Number(splash.dataset.shownAt || 0)
    const remaining = MIN_SPLASH_MS - elapsed
    if (remaining > 0) {
      window.setTimeout(dismissSplash, remaining)
      return
    }
    splash.classList.add('fade-out')
    splash.addEventListener('transitionend', () => splash.remove(), { once: true })
  }
}

