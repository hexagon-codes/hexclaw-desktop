import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/views/ChatView.vue'), 'utf8')
const downloadImageStart = source.indexOf('async function downloadImage')
const downloadImageEnd = source.indexOf('\n}\n\n/**', downloadImageStart) + 2
const downloadImageSource = source.slice(downloadImageStart, downloadImageEnd)
const messageImageSrcStart = source.indexOf('function messageImageSrc')
const messageImageSrcEnd = source.indexOf('\n}\n\nwatch', messageImageSrcStart) + 2
const messageImageSrcSource = source.slice(messageImageSrcStart, messageImageSrcEnd)

describe('BUG-20260802-013 · Chat 媒体保存使用 opaque grant 共享链', () => {
  it('不再调用已删除的裸路径保存命令或把完整 base64 传入 IPC', () => {
    expect(source).not.toMatch(/save_file_from_url|save_bytes_to_path|base64Data/)
    expect(source).not.toContain("import('@tauri-apps/plugin-dialog')")
  })

  it('managed HTTP 资源走 downloadInApp，data/blob 资源转 Blob 后走 saveBlobInApp', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*downloadInApp[^}]*saveBlobInApp[^}]*\}\s*from\s*['"]@\/utils\/download['"]/,
    )
    expect(downloadImageSource).toContain('/^https?:\\/\\//i.test(src)')
    expect(downloadImageSource).toContain('downloadInApp(src, filename)')
    expect(downloadImageSource).toContain('/^(?:data:|blob:)/i.test(src)')
    expect(downloadImageSource).toContain('fetch(blobSource)')
    expect(downloadImageSource).toContain('response.blob()')
    expect(downloadImageSource).toContain('saveBlobInApp(blob, filename)')
  })

  it('非 K12 图片继续经 imageSrc 归一化，K12 图片仅在认证 URL 可用后开放渲染与保存', () => {
    expect(messageImageSrcSource).toContain('const assetId = k12AssetIdentity(attachment)')
    expect(messageImageSrcSource).toContain(': imageSrc(attachment)')
    expect(messageImageSrcSource).toContain("k12AssetDisplayURLs.value.get(assetId) ?? ''")

    expect(source).toMatch(
      /<span v-if="messageImageSrc\(att\)" class="hc-msg__img-wrap">[\s\S]*?downloadImage\(messageImageSrc\(att\), att\.name\)/,
    )
    expect(source).toMatch(
      /<template v-if="att\.type === 'image'">\s*<img\s+v-if="messageImageSrc\(att\)"/,
    )
    expect(source).toMatch(
      /<template v-for="\(att, ai\) in editingImages\(msg\)" :key="ai">\s*<img\s+v-if="messageImageSrc\(att\)"/,
    )
    expect(source).toContain('downloadImage(imageSrc(att), att.name)')
  })
})
