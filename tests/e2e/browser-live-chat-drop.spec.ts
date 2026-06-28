import { test, expect } from '@playwright/test'

/**
 * 真机 E2E [BUG-20260622-CHATINPUT-DROP]：拖拽真实图片到会话框 → 附件出现 → 可发送。
 *
 * 说明：Tauri 原生 OS 拖放（onDragDropEvent）来自操作系统、无法被浏览器自动化模拟；
 * 本 spec 在浏览器（HTML drop 路径）真发 drag/drop 事件，覆盖与原生路径**共享的下游**
 * addFiles → 附件预览 → canSend → 发送。原生「路径→字节」半段由 src-tauri cargo test
 * read_file_as_base64 真机覆盖，单测 bug-20260622-chatinput-native-drop 覆盖原生事件接线。
 *
 * 前置：Vite dev server(5173) + sidecar(16060) 已起（pnpm test:e2e:live）。
 */
test.describe('拖拽图片到会话框（live sidecar）', () => {
  test.setTimeout(120_000)

  test('真实拖一张 PNG → 附件预览出现 → 发送按钮可用并能发送', async ({ page }) => {
    // 本 spec 焦点＝拖图→预览→发送→草稿清空；welcome 流由 browser-live-welcome-settings 覆盖。
    // 必须显式指定 model（与 browser-live-sidecar 同模式）：无模型时 handleSend 会按设计在
    // model==='' 处 return false（拒绝发送、保留草稿），那会污染本 spec 的「发送后清空」断言。
    await page.addInitScript(() => sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1'))
    await page.goto('/chat?model=qwen3.5:9b')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/chat/)

    const box = page.locator('.hc-composer__box')
    await expect(box).toBeVisible()

    // 构造真实 PNG File 放进 DataTransfer（1x1 透明 PNG）
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const file = new File([arr], 'e2e-drop.png', { type: 'image/png' })
      dt.items.add(file)
      return dt
    })

    // 真发拖拽事件序列
    await box.dispatchEvent('dragenter', { dataTransfer })
    await box.dispatchEvent('dragover', { dataTransfer })
    await box.dispatchEvent('drop', { dataTransfer })

    // ① 附件预览出现（图片渲染为缩略图）
    await expect(page.locator('.hc-composer__file-img')).toBeVisible({ timeout: 10_000 })

    // ② 仅凭附件，发送按钮即变为可用（canSend）
    await expect(page.locator('.hc-composer__send--active')).toBeVisible()

    // ③ 能发送：点击发送 → 草稿被接收清空（附件预览消失）
    await page.locator('.hc-composer__send').click()
    await expect(page.locator('.hc-composer__file-img')).toHaveCount(0, { timeout: 30_000 })
  })
})
