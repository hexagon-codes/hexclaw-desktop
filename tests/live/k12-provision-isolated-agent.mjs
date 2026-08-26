import { request as playwrightRequest } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'

const START_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000
const PRIVATE_FILE_MODE = 0o600

class ProvisionError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function nonEmpty(value, code) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new ProvisionError(code)
  return normalized
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function targetKey(target) {
  return `${target.platform}\u0000${target.instance_id}\u0000${target.chat_id}`
}

function normalizedTarget(value) {
  const target = {
    platform: nonEmpty(value?.platform, 'SOURCE_TARGET_INVALID').toLowerCase(),
    instance_id: nonEmpty(value?.instance_id, 'SOURCE_TARGET_INVALID'),
    chat_id: nonEmpty(value?.chat_id, 'SOURCE_TARGET_INVALID'),
  }
  if (target.platform !== 'dingtalk') throw new ProvisionError('SOURCE_TARGET_INVALID')
  return target
}

function ruleTarget(rule) {
  const chatID = String(rule?.chat_id || rule?.user_id || '').trim()
  if (String(rule?.platform ?? '').toLowerCase() !== 'dingtalk' || !chatID) return null
  return normalizedTarget({
    platform: 'dingtalk',
    instance_id: rule.instance_id,
    chat_id: chatID,
  })
}

function runtime(env = process.env) {
  const baseURL = new URL(nonEmpty(env.HEXCLAW_CREATIVE_PROVISION_BASE_URL, 'BASE_URL_REQUIRED'))
  if (
    baseURL.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(baseURL.hostname) ||
    !['', '/'].includes(baseURL.pathname)
  ) {
    throw new ProvisionError('BASE_URL_INVALID')
  }
  return {
    baseURL: baseURL.origin,
    config: resolve(nonEmpty(env.HEXCLAW_CREATIVE_PROVISION_CONFIG, 'CONFIG_REQUIRED')),
    sidecar: resolve(nonEmpty(env.HEXCLAW_CREATIVE_PROVISION_SIDECAR_BIN, 'SIDECAR_REQUIRED')),
    assetRoot: resolve(nonEmpty(env.HEXCLAW_CREATIVE_PROVISION_ASSET_ROOT, 'ASSET_ROOT_REQUIRED')),
    sourceState: resolve(
      nonEmpty(env.HEXCLAW_CREATIVE_PROVISION_SOURCE_STATE, 'SOURCE_STATE_REQUIRED'),
    ),
    output: resolve(nonEmpty(env.HEXCLAW_CREATIVE_PROVISION_OUTPUT, 'OUTPUT_REQUIRED')),
  }
}

async function sleep(milliseconds) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

async function writePrivateJSON(pathname, value) {
  const temporary = `${pathname}.tmp-${randomBytes(6).toString('hex')}`
  const handle = await open(temporary, 'wx', PRIVATE_FILE_MODE)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, pathname)
  await chmod(pathname, PRIVATE_FILE_MODE)
}

async function apiRequest(api, method, pathname, data) {
  const response = await api.fetch(pathname, {
    method,
    data,
    timeout: REQUEST_TIMEOUT_MS,
    failOnStatusCode: false,
  })
  const bytes = await response.body()
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ProvisionError('PUBLIC_API_JSON_INVALID')
  }
  if (response.status() !== 200) {
    const error = new ProvisionError('PUBLIC_API_STATUS_INVALID')
    error.status = response.status()
    error.bodyDigest = sha256(bytes)
    throw error
  }
  return value
}

async function waitReady(api, child) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new ProvisionError('SIDECAR_EXITED_BEFORE_READY')
    }
    try {
      await apiRequest(api, 'GET', '/api/v1/version')
      return
    } catch {
      await sleep(250)
    }
  }
  throw new ProvisionError('SIDECAR_START_TIMEOUT')
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolveClose) => child.once('close', resolveClose))
  child.kill('SIGTERM')
  if (!(await Promise.race([closed.then(() => true), sleep(10_000).then(() => false)]))) {
    child.kill('SIGKILL')
    await closed
  }
}

function cloneAgent(source, name) {
  const clone = {
    name,
    display_name: source.display_name,
    description: source.description,
    model: source.model,
    provider: source.provider,
    system_prompt: source.system_prompt,
    skills: Array.isArray(source.skills) ? source.skills : [],
    max_tokens: Number.isInteger(source.max_tokens) ? source.max_tokens : 0,
    reasoning_policy: source.reasoning_policy ?? { mode: 'inherit' },
    metadata: source.metadata ?? {},
  }
  if (Object.hasOwn(source, 'temperature')) clone.temperature = source.temperature
  return clone
}

async function main() {
  const rt = runtime()
  const sourceState = JSON.parse(await readFile(rt.sourceState, 'utf8'))
  const sourceAgentName = nonEmpty(sourceState?.agent_name, 'SOURCE_AGENT_INVALID')
  const expectedTargets = sourceState?.expected_targets?.map(normalizedTarget) ?? []
  if (expectedTargets.length === 0) throw new ProvisionError('SOURCE_TARGETS_EMPTY')
  const expectedKeys = [...new Set(expectedTargets.map(targetKey))].sort()
  if (expectedKeys.length !== expectedTargets.length) {
    throw new ProvisionError('SOURCE_TARGETS_DUPLICATED')
  }

  const capability = randomBytes(32).toString('hex')
  const child = spawn(rt.sidecar, ['serve', '--desktop', '--config', rt.config], {
    env: {
      ...process.env,
      HEXCLAW_ASSET_ROOT: rt.assetRoot,
      HEXCLAW_SIDECAR_CAPABILITY_TOKEN: capability,
      DINGTALK_LIVE_SEND: '1',
    },
    stdio: 'ignore',
  })
  const api = await playwrightRequest.newContext({
    baseURL: rt.baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${capability}`, Accept: 'application/json' },
  })
  let createdAgent = ''
  try {
    await waitReady(api, child)
    const projection = await apiRequest(api, 'GET', '/api/v1/agents')
    const sourceAgents = projection?.agents?.filter((agent) => agent?.name === sourceAgentName) ?? []
    if (sourceAgents.length !== 1) throw new ProvisionError('SOURCE_AGENT_NOT_FOUND')
    const source = sourceAgents[0]
    if (
      source.provider !== 'hexclaw-gpt' ||
      source.model !== 'gpt-5.6-sol' ||
      source.metadata?.scenario !== 'k12-tutor'
    ) {
      throw new ProvisionError('SOURCE_AGENT_ROUTE_INVALID')
    }

    const matchingRules = (projection?.rules ?? []).filter((rule) => {
      if (rule?.agent_name !== sourceAgentName) return false
      const target = ruleTarget(rule)
      return target && expectedKeys.includes(targetKey(target))
    })
    const matchedKeys = [...new Set(matchingRules.map((rule) => targetKey(ruleTarget(rule))))].sort()
    if (JSON.stringify(matchedKeys) !== JSON.stringify(expectedKeys)) {
      throw new ProvisionError('SOURCE_RULE_SET_INVALID')
    }

    const suffix = sha256(`${sourceState.run_id}:${randomUUID()}`).slice(0, 16)
    createdAgent = `hc-k12-real-${suffix}`
    await apiRequest(api, 'POST', '/api/v1/agents', cloneAgent(source, createdAgent))

    const createdRuleIDs = []
    for (const rule of matchingRules) {
      const added = await apiRequest(api, 'POST', '/api/v1/agents/rules', {
        platform: rule.platform,
        instance_id: rule.instance_id,
        user_id: rule.user_id,
        chat_id: rule.chat_id,
        agent_name: createdAgent,
        priority: rule.priority,
      })
      createdRuleIDs.push(added.id)
    }

    const verified = await apiRequest(api, 'GET', '/api/v1/agents')
    const newAgents = verified?.agents?.filter((agent) => agent?.name === createdAgent) ?? []
    const newTargets = [
      ...new Map(
        (verified?.rules ?? [])
          .filter((rule) => rule?.agent_name === createdAgent)
          .map(ruleTarget)
          .filter(Boolean)
          .map((target) => [targetKey(target), target]),
      ).values(),
    ]
    if (
      newAgents.length !== 1 ||
      newAgents[0].provider !== 'hexclaw-gpt' ||
      newAgents[0].model !== 'gpt-5.6-sol' ||
      newAgents[0].metadata?.scenario !== 'k12-tutor' ||
      JSON.stringify(newTargets.map(targetKey).sort()) !== JSON.stringify(expectedKeys)
    ) {
      throw new ProvisionError('PROVISION_VERIFY_FAILED')
    }

    await writePrivateJSON(rt.output, {
      schema_version: 1,
      agent_name: createdAgent,
      expected_targets: expectedTargets,
      created_rule_ids: createdRuleIDs,
    })
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'PASS',
          agent_name_sha256: sha256(createdAgent),
          target_hashes: expectedKeys.map(sha256),
          target_count: expectedTargets.length,
          rule_count: createdRuleIDs.length,
        },
        null,
        2,
      )}\n`,
    )
  } catch (error) {
    if (createdAgent) {
      try {
        await apiRequest(api, 'DELETE', `/api/v1/agents/${encodeURIComponent(createdAgent)}`)
      } catch {
        // 回滚失败由隔离配置目录保留，后续可通过同一公开 API 定向清理。
      }
    }
    const output = { status: 'FAIL', code: error?.code ?? 'PROVISION_FAILED' }
    if (error?.status) output.http_status = error.status
    if (error?.bodyDigest) output.body_sha256 = error.bodyDigest
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
    process.exitCode = 1
  } finally {
    await api.dispose()
    await stop(child)
  }
}

await main()
