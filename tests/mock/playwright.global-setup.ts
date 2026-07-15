const normaliseURL = (value: string) => value.replace(/\/$/, '')

const requiredURL = (name: 'HEX_E2E_SIDECAR_URL' | 'HEX_MOCKSERVER_URL'): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(
      `${name} is required for the L4 mock lane; the lane must use a real Sidecar and the Docker mock stack`,
    )
  }
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP(S), received ${url.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} must be loopback-only, received ${url.hostname}`)
  }
  return normaliseURL(url.toString())
}

const probe = async (label: string, url: string): Promise<void> => {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  } catch (error) {
    throw new Error(`${label} is unreachable at ${url}`, { cause: error })
  }
  if (!response.ok) {
    throw new Error(`${label} readiness probe returned HTTP ${response.status} at ${url}`)
  }
}

export default async function globalSetup(): Promise<void> {
  const sidecarURL = requiredURL('HEX_E2E_SIDECAR_URL')
  const mockserverURL = requiredURL('HEX_MOCKSERVER_URL')

  await probe('real Sidecar', `${sidecarURL}/health`)
  await probe('MockServer fixture stack', `${mockserverURL}/__hexclaw_mock__/ping`)
}
