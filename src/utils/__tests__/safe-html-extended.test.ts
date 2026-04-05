import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sanitizeArtifactHtml, openSanitizedArtifact } from '../safe-html'

describe('safe-html extended', () => {
  describe('sanitizeArtifactHtml — full HTML document mode', () => {
    it('handles a full HTML document with <!DOCTYPE html><html><body>', () => {
      const input = '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Content</p></body></html>'
      const result = sanitizeArtifactHtml(input)

      // WHOLE_DOCUMENT mode should preserve the document structure
      expect(result).toContain('<body>')
      expect(result).toContain('Content')
      expect(result).toContain('<p>')
    })

    it('wraps a fragment in a full document when input is not a document', () => {
      const input = '<p>Just a paragraph</p>'
      const result = sanitizeArtifactHtml(input)

      expect(result).toContain('<!doctype html>')
      expect(result).toContain('<html')
      expect(result).toContain('<body>')
      expect(result).toContain('Just a paragraph')
    })
  })

  describe('sanitizeArtifactHtml — event handler stripping', () => {
    it('strips onerror attribute', () => {
      const result = sanitizeArtifactHtml('<img onerror="alert(1)" src="x.png">')
      expect(result).not.toContain('onerror')
      expect(result).toContain('src="x.png"')
    })

    it('strips onload attribute', () => {
      const result = sanitizeArtifactHtml('<img onload="alert(1)" src="x.png">')
      expect(result).not.toContain('onload')
    })

    it('strips onmouseover attribute', () => {
      const result = sanitizeArtifactHtml('<div onmouseover="alert(1)">hover</div>')
      expect(result).not.toContain('onmouseover')
      expect(result).toContain('hover')
    })

    it('strips onclick attribute', () => {
      const result = sanitizeArtifactHtml('<button onclick="alert(1)">click</button>')
      expect(result).not.toContain('onclick')
    })
  })

  describe('sanitizeArtifactHtml — dangerous tag stripping', () => {
    it('strips <script> tags', () => {
      const result = sanitizeArtifactHtml('<div>safe</div><script>alert("xss")</script>')
      expect(result).not.toContain('<script')
      expect(result).toContain('safe')
    })

    it('strips <iframe> tags', () => {
      const result = sanitizeArtifactHtml('<iframe src="https://evil.com"></iframe><p>ok</p>')
      expect(result).not.toContain('<iframe')
      expect(result).toContain('ok')
    })

    it('strips <object> tags', () => {
      const result = sanitizeArtifactHtml('<object data="exploit.swf"></object><span>text</span>')
      expect(result).not.toContain('<object')
      expect(result).toContain('text')
    })

    it('strips <embed> tags', () => {
      const result = sanitizeArtifactHtml('<embed src="exploit.swf"><p>content</p>')
      expect(result).not.toContain('<embed')
      expect(result).toContain('content')
    })
  })

  describe('sanitizeArtifactHtml — safe tag allowance', () => {
    const safeTags: Array<{ tag: string; html: string; expected: string }> = [
      { tag: 'div', html: '<div>block</div>', expected: '<div>block</div>' },
      { tag: 'span', html: '<span>inline</span>', expected: '<span>inline</span>' },
      { tag: 'p', html: '<p>paragraph</p>', expected: '<p>paragraph</p>' },
      { tag: 'h1', html: '<h1>heading</h1>', expected: '<h1>heading</h1>' },
      { tag: 'a', html: '<a href="https://example.com">link</a>', expected: '<a href="https://example.com">' },
      { tag: 'img', html: '<img src="photo.jpg" alt="pic">', expected: 'src="photo.jpg"' },
      { tag: 'pre', html: '<pre>preformatted</pre>', expected: '<pre>preformatted</pre>' },
      { tag: 'code', html: '<code>code</code>', expected: '<code>code</code>' },
      { tag: 'table', html: '<table><tr><td>cell</td></tr></table>', expected: '<table>' },
      { tag: 'ul', html: '<ul><li>item</li></ul>', expected: '<ul>' },
      { tag: 'ol', html: '<ol><li>item</li></ol>', expected: '<ol>' },
      { tag: 'li', html: '<ul><li>item</li></ul>', expected: '<li>item</li>' },
    ]

    for (const { tag, html, expected } of safeTags) {
      it(`allows <${tag}> tag`, () => {
        const result = sanitizeArtifactHtml(html)
        expect(result).toContain(expected)
      })
    }
  })

  describe('sanitizeArtifactHtml — safe attribute allowance', () => {
    it('allows class attribute', () => {
      const result = sanitizeArtifactHtml('<div class="highlight">text</div>')
      expect(result).toContain('class="highlight"')
    })

    it('allows id attribute', () => {
      const result = sanitizeArtifactHtml('<div id="main">text</div>')
      expect(result).toContain('id="main"')
    })

    it('allows style attribute', () => {
      const result = sanitizeArtifactHtml('<div style="color: red">text</div>')
      expect(result).toContain('style="color: red"')
    })

    it('allows href attribute on links', () => {
      const result = sanitizeArtifactHtml('<a href="https://example.com">link</a>')
      expect(result).toContain('href="https://example.com"')
    })

    it('allows src attribute on images', () => {
      const result = sanitizeArtifactHtml('<img src="photo.jpg">')
      expect(result).toContain('src="photo.jpg"')
    })

    it('allows alt attribute on images', () => {
      const result = sanitizeArtifactHtml('<img src="photo.jpg" alt="description">')
      expect(result).toContain('alt="description"')
    })

    it('allows width and height attributes', () => {
      const result = sanitizeArtifactHtml('<img src="photo.jpg" width="100" height="50">')
      expect(result).toContain('width="100"')
      expect(result).toContain('height="50"')
    })
  })

  describe('sanitizeArtifactHtml — form-related tag stripping', () => {
    it('strips <form> tags', () => {
      const result = sanitizeArtifactHtml('<form action="/submit"><p>content</p></form>')
      expect(result).not.toContain('<form')
      expect(result).toContain('content')
    })

    it('strips <input> tags', () => {
      const result = sanitizeArtifactHtml('<input type="text" value="evil"><p>ok</p>')
      expect(result).not.toContain('<input')
      expect(result).toContain('ok')
    })

    it('strips <button> tags', () => {
      const result = sanitizeArtifactHtml('<button type="submit">Submit</button><p>ok</p>')
      expect(result).not.toContain('<button')
      expect(result).toContain('ok')
    })

    it('strips <textarea> tags', () => {
      const result = sanitizeArtifactHtml('<textarea>content</textarea><p>ok</p>')
      expect(result).not.toContain('<textarea')
      expect(result).toContain('ok')
    })

    it('strips <select> tags', () => {
      const result = sanitizeArtifactHtml('<select><option>A</option></select><p>ok</p>')
      expect(result).not.toContain('<select')
      expect(result).toContain('ok')
    })
  })

  describe('sanitizeArtifactHtml — title parameter sanitization', () => {
    it('sanitizes XSS in title parameter', () => {
      const maliciousTitle = '<script>alert("xss")</script>'
      const result = sanitizeArtifactHtml('<p>content</p>', maliciousTitle)
      expect(result).not.toContain('<script')
      expect(result).toContain('<title>')
    })

    it('sanitizes HTML injection in title parameter', () => {
      const maliciousTitle = '"><img src=x onerror=alert(1)>'
      const result = sanitizeArtifactHtml('<p>content</p>', maliciousTitle)
      expect(result).not.toContain('onerror')
    })
  })

  describe('looksLikeHtmlDocument detection', () => {
    // We test this indirectly through sanitizeArtifactHtml behavior:
    // if looksLikeHtmlDocument returns true, the output will NOT contain our wrapper template's
    // specific style block (body { margin: 0; padding: 16px; ...) because WHOLE_DOCUMENT mode
    // is used instead of the wrapper template.

    const wrapperStyleFragment = 'font-family: ui-sans-serif'

    it('detects <body> as a document', () => {
      const input = '<body><p>content</p></body>'
      const result = sanitizeArtifactHtml(input)
      expect(result).not.toContain(wrapperStyleFragment)
    })

    it('detects <head> as a document', () => {
      const input = '<head><title>T</title></head><p>content</p>'
      const result = sanitizeArtifactHtml(input)
      expect(result).not.toContain(wrapperStyleFragment)
    })

    it('detects <!doctype html> (lowercase) as a document', () => {
      const input = '<!doctype html><html><body><p>content</p></body></html>'
      const result = sanitizeArtifactHtml(input)
      expect(result).not.toContain(wrapperStyleFragment)
    })

    it('detects <!DOCTYPE HTML> (uppercase) as a document', () => {
      const input = '<!DOCTYPE HTML><html><body><p>content</p></body></html>'
      const result = sanitizeArtifactHtml(input)
      expect(result).not.toContain(wrapperStyleFragment)
    })

    it('does NOT detect a plain fragment as a document', () => {
      const input = '<p>just a paragraph</p>'
      const result = sanitizeArtifactHtml(input)
      expect(result).toContain(wrapperStyleFragment)
    })
  })

  describe('openSanitizedArtifact — popup blocked (window.open returns null)', () => {
    let originalCreateObjectURL: typeof URL.createObjectURL
    let originalRevokeObjectURL: typeof URL.revokeObjectURL

    beforeEach(() => {
      originalCreateObjectURL = URL.createObjectURL
      originalRevokeObjectURL = URL.revokeObjectURL
      URL.createObjectURL = vi.fn(() => 'blob:test-url')
      URL.revokeObjectURL = vi.fn()
    })

    afterEach(() => {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
    })

    it('returns false and revokes URL when popup is blocked', () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

      const result = openSanitizedArtifact('<p>test</p>', 'Test')

      expect(result).toBe(false)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url')
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)

      openSpy.mockRestore()
    })
  })
})
