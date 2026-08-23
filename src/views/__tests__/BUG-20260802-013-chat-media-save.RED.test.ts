import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/views/ChatView.vue'), 'utf8')
const downloadImageStart = source.indexOf('async function downloadImage')
const downloadImageEnd = source.indexOf('\n}\n\n/**', downloadImageStart) + 2
const downloadImageSource = source.slice(downloadImageStart, downloadImageEnd)

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

  it('图片和视频都先经 imageSrc 归一化，使历史裸 base64 进入 data URL Blob 分支', () => {
    expect(source.match(/downloadImage\(imageSrc\(att\), att\.name\)/g)).toHaveLength(2)
  })
})
