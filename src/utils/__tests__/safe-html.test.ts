import { describe, expect, it, vi } from 'vitest'
import { openSanitizedArtifact, sanitizeArtifactHtml } from '../safe-html'

describe('safe-html', () => {
  it('sanitizes executable content from artifact previews', () => {
    const html = sanitizeArtifactHtml(
      '<div onclick="alert(1)">safe</div><script>alert(2)</script>',
      'Preview',
    )

    expect(html).toContain('safe')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick=')
  })

  it('opens sanitized artifact content via blob url', () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:preview')
    const revokeObjectURL = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL

    const opened = openSanitizedArtifact('<script>alert(1)</script><p>hello</p>', 'Demo')

    expect(opened).toBe(true)
    expect(open).toHaveBeenCalledWith('blob:preview', '_blank', 'noopener,noreferrer')
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    open.mockRestore()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })
})
