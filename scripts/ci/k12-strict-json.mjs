import jsoncParser from 'jsonc-parser'

function duplicateKey(node, path = '$') {
  if (node?.type === 'object') {
    const keys = new Set()
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value
      if (keys.has(key)) return `${path}.${String(key)}`
      keys.add(key)
      const nested = duplicateKey(property.children?.[1], `${path}.${String(key)}`)
      if (nested) return nested
    }
    return undefined
  }
  if (node?.type === 'array') {
    for (const [index, child] of (node.children ?? []).entries()) {
      const nested = duplicateKey(child, `${path}[${index}]`)
      if (nested) return nested
    }
  }
  return undefined
}

export function parseStrictJSON(raw, { label = 'JSON document' } = {}) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }

  const errors = []
  const tree = jsoncParser.parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  })
  if (!tree || errors.length > 0) {
    throw new Error(`${label} is not valid JSON`)
  }
  const duplicate = duplicateKey(tree)
  if (duplicate) {
    throw new Error(`${label} contains duplicate JSON key at ${duplicate}`)
  }
  return value
}
