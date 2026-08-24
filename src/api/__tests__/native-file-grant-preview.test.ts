import { describe, expect, it } from 'vitest'

import { fileFromNativeGrant, type NativeFileGrant } from '../native-files'

describe('native file grant preview bytes', () => {
  it('keeps the attested byte length when converting a non-empty grant to a preview File', () => {
    const grant: NativeFileGrant = {
      grantId: 'native-preview-grant',
      operationId: 'native-drop:preview',
      purpose: 'attachment_upload',
      name: 'artwork.png',
      mime: 'image/png',
      size: 3,
      sourceSha256: 'a'.repeat(64),
    }

    const file = fileFromNativeGrant(grant)

    expect(file.size).toBe(grant.size)
  })
})
