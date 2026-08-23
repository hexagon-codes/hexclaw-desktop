import process from 'node:process'

process.env.HEX_PROVIDER_CASE_FILTER ||= '20260818-001'
process.env.HEX_PROVIDER_EVIDENCE_ROOT ||=
  '/tmp/hexclaw-provider-current-source-visual-gate/status-green'

await import('./provider-cardhead-prototype-compare.mjs')
