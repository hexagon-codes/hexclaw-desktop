#!/usr/bin/env node

/**
 * BUG-20260723-028 当前工作树的隔离原生四弹窗边界。
 *
 * 该门只启动由当前源码快照构建的唯一 Test.app，并在真实 Tauri WKWebView
 * 内注入离线业务 fixture。它只读取 DOM、computed-style、bbox 和 overflow；
 * 不修改生产源码、权威原型、真实 HOME、/Applications 或真实 Provider。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 复用已经验证过的当前源码 Test.app 构建、来源快照和清理工具，但不执行其主门。
process.env.HEXCLAW_NATIVE_LIBRARY = '1'
const {
  captureWindow,
  createSourceSnapshot,
  currentSourceManifest,
  listenerPIDs,
  renderConfig,
  reserveLoopbackPort,
  runCommand,
  sanitizeLog,
  sha256File,
  stopOwnedSidecar,
  stopProcess,
  treeManifest,
  waitForHealth,
} = await import('./bug-20260728-007-current-worktree-wkwebview.mjs')

const nativeDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(nativeDir, '../..')
const docsRoot = resolve(repoRoot, '../hexclaw-docs')
const srcTauriDir = join(repoRoot, 'src-tauri')
const evidenceRoot = join(docsRoot, 'test/evidence/bug-20260723-028-current-source/native')
const productName = 'HexClaw Modal Forms Test'
const bundleIdentifier = 'com.hexclaw.desktop.bug-20260723-028'
const frame = { width: 1440, height: 900 }
const AGENT = 'k12-modal-track-fixture'
const SESSION = 'k12-modal-track-session'
const commandTimeoutMs = 15 * 60 * 1000
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function readJSONBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 2 * 1024 * 1024) throw new Error('fixture body exceeds 2 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const webhookBinding = {
  binding_id: 'binding-modal-track',
  name: 'homework-hook',
  agent_id: AGENT,
  learner_id: 'learner-modal-track',
  scope: 'direct',
  allowed_events: [
    'k12.submission.requested.v1',
    'k12.practice_return.requested.v1',
    'k12.workflow_run.requested.v1',
  ],
  allowed_workflows: ['weekly@v1'],
  has_secret: true,
  secret_version: 2,
  status: 'enabled',
  created_by: 'desktop-fixture',
  created_at: '2026-07-20T08:00:00+08:00',
  updated_at: '2026-07-28T08:00:00+08:00',
}

function runtimeFixture(path, method, url) {
  if (path === '/health') return { status: 'healthy' }
  if (path === '/api/v1/config') {
    return {
      general: { language: 'zh-CN', welcomeCompleted: true },
      knowledge: { enabled: true },
      llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
    }
  }
  if (path === '/api/v1/config/llm') {
    return { default: '', providers: {}, routing: { enabled: false }, cache: { enabled: false } }
  }
  if (path === '/api/v1/ollama/status') return { running: false, models: [] }
  if (path === '/api/v1/prompts' || path === '/api/v1/prompts/all') {
    return { prompts: [], total: 0 }
  }
  if (path === '/api/v1/knowledge/documents') {
    return { documents: [], total: 0, limit: 50, offset: 0, sources: [] }
  }
  if (path === '/api/v1/knowledge/config') {
    return {
      rerank_enabled: false,
      rerank_model: '',
      query_expansion: false,
      contextual: false,
      min_score: 0.2,
      candidate_k: 50,
    }
  }
  if (path === '/api/v1/knowledge/embedding-status') {
    return { enabled: true, configured: false, local: false, ready: false }
  }
  if (path === '/api/v1/agents' && method === 'GET') {
    return {
      agents: [
        {
          name: AGENT,
          display_name: '小明的辅导助手',
          description: '五年级下 · 弹窗宽度验收夹具',
          provider: '',
          model: '',
          metadata: {
            scenario: 'k12-tutor',
            avatar: '🎓',
            'k12.child_name': '小明',
            'k12.learner_id': 'learner-modal-track',
            'k12.grade_term': '五年级下',
          },
        },
      ],
      total: 1,
      default: AGENT,
    }
  }
  if (path === '/api/v1/agents/rules') return { rules: [], total: 0 }
  if (path === '/api/v1/roles' || path === '/api/v1/skills') {
    return { items: [], roles: [], skills: [], total: 0 }
  }
  if (path === '/api/v1/sessions') {
    return {
      sessions: [
        {
          id: SESSION,
          title: '小明的辅导助手',
          created_at: '2026-07-20T00:00:00+08:00',
          updated_at: '2026-07-20T00:00:00+08:00',
          message_count: 0,
        },
      ],
      total: 1,
    }
  }
  if (path.includes('/api/v1/sessions/' + SESSION + '/')) {
    return { messages: [], artifacts: [], total: 0 }
  }
  if (path === '/api/k12/view-descriptor') {
    return {
      header_tabs: ['辅导', '学习档案', '学情'],
      message_badges: [],
      composer_placeholder: '拍照或输入题目',
      composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
      record_collections: [],
      side_panels: [],
      actions: [],
      i18n_keys: [],
      schema_version: 1,
    }
  }
  if (path === '/api/k12/creative-works') return { items: [] }
  if (path === '/api/k12/mistakes' || path === '/api/k12/review-queue') {
    return { items: [] }
  }
  if (path === '/api/k12/accumulation' || path === '/api/k12/accumulations') {
    return { items: [] }
  }
  if (path === '/api/k12/practice-sets') return { items: [] }
  if (path === '/api/k12/weekly-practice/settings') {
    return {
      agent: AGENT,
      revision: 1,
      timezone: 'Asia/Shanghai',
      due_review_enabled: true,
      textbook_consolidation_enabled: false,
      textbook_consolidation_tier: 'standard',
      arithmetic_warmup_enabled: false,
      arithmetic_minutes: 2,
    }
  }
  if (path === '/api/k12/weekly-practice/plans/current') return { plan: null }
  if (path === '/api/k12/weekly-practice/plans/history') {
    return { items: [], next_cursor: null }
  }
  if (path === '/api/k12/insight-report') {
    return {
      trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
      weak_top3: [],
      consecutive_fail_kps: [],
      month_new_mistakes: 0,
      review_completion_rate: -1,
      week_pending: 0,
      practice_pending: 0,
      suggestion: '',
    }
  }
  if (path === '/api/k12/study-time') return { days: [], total_records: 0, total_minutes: 0, note: '' }
  if (path === '/api/v1/webhooks' && method === 'GET') {
    if (url.searchParams.get('agent_id')) return { k12_bindings: [webhookBinding], total: 1 }
    return { webhooks: [], k12_bindings: [], total: 0 }
  }
  if (path.startsWith('/api/k12/')) return { items: [] }
  if (path.startsWith('/api/v1/')) return { items: [], total: 0 }
  return {}
}

function createFixtureServer(port) {
  const state = { reports: [], requests: [], chatRequests: 0, updaterRequests: 0, unexpectedRequests: [] }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Origin': '*',
        })
        response.end()
        return
      }
      if (request.method === 'POST' && url.pathname === '/__modal_tracks__/report') {
        state.reports.push(await readJSONBody(request))
        json(response, 200, { ok: true })
        return
      }
      state.requests.push(`${request.method} ${url.pathname}${url.search}`)
      if (request.method === 'GET' && url.pathname === '/updater') {
        state.updaterRequests += 1
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        json(response, 200, { object: 'list', data: [] })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        state.chatRequests += 1
        json(response, 503, { error: { message: 'model calls are forbidden in this gate' } })
        return
      }
      const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
      if (apiPath === '/health' || apiPath.startsWith('/api/')) {
        json(response, 200, runtimeFixture(apiPath, request.method || 'GET', url))
        return
      }
      state.unexpectedRequests.push(`${request.method} ${url.pathname}`)
      json(response, 404, { error: 'unexpected fixture request' })
    } catch (error) {
      state.unexpectedRequests.push(`fixture-error:${error instanceof Error ? error.message : String(error)}`)
      json(response, 500, { error: 'fixture failure' })
    }
  })
  return {
    state,
    origin: `http://127.0.0.1:${port}`,
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', resolveListen)
      })
    },
    async close() {
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

function renderWKWebViewFixture(fixtureOrigin, provenance) {
  return String.raw`;(()=>{
  'use strict'
  const origin=${JSON.stringify(fixtureOrigin)}
  const provenance=${JSON.stringify(provenance)}
  const agent=${JSON.stringify(AGENT)}
  const session=${JSON.stringify(SESSION)}
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))
  const post=async(payload)=>{const response=await fetch(origin+'/__modal_tracks__/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok)throw new Error('fixture report failed: '+response.status)}
  const reportError=(error)=>{const message=error instanceof Error?[error.name+': '+error.message,error.stack].filter(Boolean).join('\n'):String(error);void post({stage:'fixture-error',message,provenance}).catch(()=>{})}
  addEventListener('error',(event)=>reportError(event.error||event.message));addEventListener('unhandledrejection',(event)=>reportError(event.reason))
  localStorage.clear();sessionStorage.clear();localStorage.setItem('hc-theme','light');localStorage.setItem('hc-locale','zh-CN');localStorage.setItem('hexclaw:welcomeRedirectDone','1');sessionStorage.setItem('hexclaw:welcomeRedirectDone','1');localStorage.setItem('hexclaw_lastSessionId',session);localStorage.setItem('hexclaw_sessionAgents',JSON.stringify({[session]:agent}));localStorage.setItem('hc-k12-appearance-v1',JSON.stringify({version:1,preference:'k12',introSeen:true}))
  const callbacks=new Map();let callbackID=1;const internals=globalThis.__TAURI_INTERNALS__||{};const nativeInvoke=typeof internals.invoke==='function'?internals.invoke.bind(internals):null
  const invoke=async(command,args={})=>{if(command==='check_engine_health')return true;if(command==='plugin:event|listen')return callbackID++;if(command==='plugin:event|unlisten'||command==='plugin:event|emit'||command==='plugin:clipboard-manager|write_text')return null;return nativeInvoke?nativeInvoke(command,args):null}
  const bridge={invoke,callbacks,transformCallback:(callback)=>{const id=callbackID++;callbacks.set(id,callback);return id},unregisterCallback:(id)=>callbacks.delete(id)}
  for(const [key,value] of Object.entries(bridge)){try{Object.defineProperty(internals,key,{configurable:true,enumerable:true,writable:true,value})}catch{try{internals[key]=value}catch{}}}
  if(!globalThis.__TAURI_INTERNALS__){try{Object.defineProperty(globalThis,'__TAURI_INTERNALS__',{configurable:true,enumerable:false,writable:true,value:internals})}catch{}}
  class FixtureWebSocket extends EventTarget{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=0;onopen=null;onmessage=null;onerror=null;onclose=null;constructor(){super();queueMicrotask(()=>{this.readyState=1;const event=new Event('open');this.onopen?.(event);this.dispatchEvent(event)})}send(){}close(){this.readyState=3;const event=new CloseEvent('close');this.onclose?.(event);this.dispatchEvent(event)}}
  Object.defineProperty(globalThis,'WebSocket',{configurable:true,writable:true,value:FixtureWebSocket})
  const nativeFetch=globalThis.fetch.bind(globalThis);const wrappedFetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input),location.href);if(url.hostname==='localhost'&&url.port==='11434')return Promise.resolve(new Response(JSON.stringify({models:[],version:'fixture-only'}),{status:200,headers:{'content-type':'application/json'}}));if(!['127.0.0.1','localhost','::1'].includes(url.hostname)&&url.protocol!=='tauri:')return Promise.resolve(new Response(JSON.stringify({error:'external network blocked'}),{status:451,headers:{'content-type':'application/json'}}));return nativeFetch(input,init)};try{Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:wrappedFetch})}catch{try{globalThis.fetch=wrappedFetch}catch{}}
  const visible=(node)=>{if(!node)return false;const style=getComputedStyle(node);const rect=node.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0}
  const waitFor=async(selector,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const node=document.querySelector(selector);if(visible(node))return node;await sleep(80)}throw new Error('timed out waiting for '+selector)}
  const waitText=async(text,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const nodes=[...document.querySelectorAll('button,[role="tab"],[role="button"]')];const node=nodes.find((item)=>visible(item)&&item.textContent?.replace(/\s+/g,' ').trim()===text);if(node)return node;await sleep(80)}throw new Error('timed out waiting for text '+text)}
  const clickText=async(text)=>{(await waitText(text)).click();await sleep(200)}
  const navigate=async(path)=>{history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'));await sleep(800)}
  const round=(value)=>Number(value.toFixed(2));const rectOf=(node)=>{const rect=node.getBoundingClientRect();return{x:round(rect.x),y:round(rect.y),width:round(rect.width),height:round(rect.height),top:round(rect.top),right:round(rect.right),bottom:round(rect.bottom),left:round(rect.left)}}
  const styleOf=(node)=>{const style=getComputedStyle(node);return{display:style.display,position:style.position,width:style.width,height:style.height,minWidth:style.minWidth,maxWidth:style.maxWidth,boxSizing:style.boxSizing,gridTemplateColumns:style.gridTemplateColumns,flexDirection:style.flexDirection,gap:style.gap,overflowX:style.overflowX,overflowY:style.overflowY,padding:style.padding,border:style.border,borderRadius:style.borderRadius}}
  const inspectNode=(selector)=>{const node=document.querySelector(selector);if(!node)return{selector,found:false};const rect=node.getBoundingClientRect();const style=getComputedStyle(node);const parent=node.parentElement;const parentStyle=parent?getComputedStyle(parent):null;const parentRect=parent?.getBoundingClientRect();const parentContentWidth=parentRect&&parentStyle?parentRect.width-parseFloat(parentStyle.paddingLeft)-parseFloat(parentStyle.paddingRight)-parseFloat(parentStyle.borderLeftWidth)-parseFloat(parentStyle.borderRightWidth):null;return{selector,found:true,visible:visible(node),rect:rectOf(node),parentContentWidth:parentContentWidth===null?null:round(parentContentWidth),fillsParentTrack:parentContentWidth===null?null:Math.abs(rect.width-parentContentWidth)<=1,overflow:{clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,horizontal:node.scrollWidth>node.clientWidth+1},style:styleOf(node)}}
  const inspect=(surface)=>{const dialog=inspectNode(surface.dialog);const body=inspectNode(surface.body);const footer=inspectNode(surface.footer);const fullWidth=Object.fromEntries(Object.entries(surface.fullWidth).map(([name,selector])=>[name,inspectNode(selector)]));const dialogNode=document.querySelector(surface.dialog);const bodyNode=document.querySelector(surface.body);const footerNode=document.querySelector(surface.footer);const inside=(node)=>{if(!dialogNode||!node)return false;const a=node.getBoundingClientRect(),b=dialogNode.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1};const controls=dialogNode?[...dialogNode.querySelectorAll('input,textarea,select,button,[role="combobox"],fieldset')].filter(visible).map((node)=>({tag:node.tagName.toLowerCase(),testid:node.dataset.testid||null,text:(node.innerText||node.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim().slice(0,120)})):[];return{environment:{viewport:{width:innerWidth,height:innerHeight},devicePixelRatio,locale:navigator.language,documentLanguage:document.documentElement.lang,colorScheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'},documentOverflow:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,horizontal:document.documentElement.scrollWidth>document.documentElement.clientWidth+1},dialog,body,footer,bodyWithinDialog:inside(bodyNode),footerWithinDialog:inside(footerNode),fullWidth,visibleControls:controls}}
  const surfaces={prompt:{dialog:'[data-testid="prompt-editor-dialog"]',body:'[data-testid="prompt-editor-dialog"] .hc-modal-body',footer:'[data-testid="prompt-editor-dialog"] .hc-prompt-modal__footer',fullWidth:{body:'[data-testid="prompt-editor-dialog"] .hc-modal-body',title:'[data-testid="prompt-editor-dialog"] .hc-field:first-child input',bodyEditor:'[data-testid="prompt-editor-dialog"] .hc-body-edit'}},knowledge:{dialog:'.knowledge-add-document-modal',body:'.knowledge-add-document-modal__body',footer:'.knowledge-add-document-modal__footer',fullWidth:{body:'.knowledge-add-document-modal__body',drop:'.knowledge-add-document-modal__drop',title:'.knowledge-add-document-modal__body input',content:'.knowledge-add-document-modal__body textarea',source:'.knowledge-add-document-modal__body input:last-of-type'}},'k12-works':{dialog:'.k12cw-modal',body:'.k12cw-modal__body',footer:'.k12cw-modal__foot',fullWidth:{body:'.k12cw-modal__body',type:'.k12cw__seg',photo:'[data-testid="cw-add-photo"]',clearable:'.k12cw-modal .hc-clearable-field',draft:'[data-testid="cw-add-draft"]'}},'k12-webhook':{dialog:'[data-testid="k12-webhook-editor-dialog"] .k12wh__dialog--editor',body:'[data-testid="k12-webhook-editor-dialog"] .k12wh__editor-body',footer:'[data-testid="k12-webhook-editor-dialog"] .k12wh__editor-footer',fullWidth:{body:'[data-testid="k12-webhook-editor-dialog"] .k12wh__editor-body',name:'[data-testid="k12-webhook-name"]',events:'[data-testid="k12-webhook-editor-dialog"] fieldset',workflows:'[data-testid="k12-webhook-workflows"]'}}}
  const freeze=async()=>{const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html,body{overflow:hidden!important}';document.head.append(style);await document.fonts.ready;await new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
  const openSurface=async(id)=>{if(id==='prompt'){await navigate('/integration/prompts');await clickText('新建 Prompt');await waitFor(surfaces.prompt.dialog)}else if(id==='knowledge'){await navigate('/knowledge');await clickText('添加文档');await waitFor(surfaces.knowledge.dialog)}else if(id==='k12-works'){await navigate('/chat?role='+encodeURIComponent(agent)+'&roleTitle='+encodeURIComponent('小明的辅导助手'));await clickText('学习档案');await waitFor('[data-testid="subtab-works"]');await clickText('作品');await waitFor('[data-testid="cw-add-open"]');await clickText('添加作品');await waitFor(surfaces['k12-works'].dialog)}else{await navigate('/automation/webhooks');await waitFor('[data-testid="k12-webhook-edit-homework-hook"]');document.querySelector('[data-testid="k12-webhook-edit-homework-hook"]').click();await waitFor(surfaces['k12-webhook'].dialog)}}
  const execute=async()=>{await waitFor('.hc-app',60000);await sleep(500);const reports=[];for(const id of ['prompt','knowledge','k12-works','k12-webhook']){await openSurface(id);await freeze();const facts=inspect(surfaces[id]);const violations=[];if(facts.documentOverflow.horizontal)violations.push('document horizontal overflow');if(!facts.bodyWithinDialog)violations.push('body outside dialog');if(!facts.footerWithinDialog)violations.push('footer outside dialog');for(const [name,target] of Object.entries(facts.fullWidth)){if(!target.found||!target.visible)violations.push(name+' missing or hidden');else{if(!target.fillsParentTrack)violations.push(name+' does not fill parent track');if(target.overflow.horizontal)violations.push(name+' horizontal overflow')}}const screenshotStage='native-'+id+'-ready';await post({stage:screenshotStage,id,provenance,environment:facts.environment,facts,violations});reports.push({id,environment:facts.environment,facts,violations,status:violations.length===0?'PASS':'RED'});const close=document.querySelector(facts.dialog.selector+' button');if(close)close.click();await sleep(250)}await post({stage:'native-modal-tracks-ready',provenance,reports,environment:{runtime:'Tauri Test.app WKWebView',isTauri:globalThis.isTauri===true,hasTauriInternals:typeof globalThis.__TAURI_INTERNALS__?.invoke==='function',viewport:{width:innerWidth,height:innerHeight},devicePixelRatio,locale:navigator.language}})}
  void post({stage:'bootstrap',provenance,nativeBoundary:{internalsPresent:!!globalThis.__TAURI_INTERNALS__,invokeBridgeInstalled:internals.invoke===invoke,fetchGuardInstalled:globalThis.fetch===wrappedFetch,globalDescriptor:Object.getOwnPropertyDescriptor(globalThis,'__TAURI_INTERNALS__')||null,invokeDescriptor:Object.getOwnPropertyDescriptor(internals,'invoke')||null,fetchDescriptor:Object.getOwnPropertyDescriptor(globalThis,'fetch')||null}}).catch(reportError);void execute().catch(reportError)
})()`
}

function prepareFrontend(frontend, fixtureOrigin, provenance) {
  const fixtureName = 'bug-20260723-028-current-worktree-wkwebview-fixture.js'
  writeFileSync(join(frontend, fixtureName), renderWKWebViewFixture(fixtureOrigin, provenance), { mode: 0o600 })
  const indexPath = join(frontend, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
  const moduleEntry = index.match(/<script type="module" crossorigin src="\.\/assets\/([^"]+\.js)">/)
  assert.ok(moduleEntry, 'current package-local module entry is missing')
  const modulePath = join(frontend, 'assets', moduleEntry[1])
  let moduleSource = readFileSync(modulePath, 'utf8')
  const platformProbe = /function [A-Za-z_$][\w$]*\(\)\{return!!globalThis\.isTauri\}/g
  const matches = moduleSource.match(platformProbe) || []
  assert.equal(matches.length, 1, 'current frontend must contain one platform probe')
  assert.ok(moduleSource.includes('http://localhost:16060'), 'current frontend API base is missing')
  moduleSource = moduleSource.replace(platformProbe, (match) => match.replace('return!!globalThis.isTauri', 'return!1')).replaceAll('http://localhost:16060', fixtureOrigin)
  writeFileSync(modulePath, moduleSource, { mode: 0o600 })
  writeFileSync(indexPath, index.replace('<head>', `<head>\n<script src="./${fixtureName}"></script>`), { mode: 0o600 })
}

function writeOverlay(sandbox, frontend, sidecarPort, fixtureOrigin, snapshotSrcTauriDir) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `media-src 'self' data: blob: http://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort}`,
    `connect-src 'self' http://localhost:${sidecarPort} ws://localhost:${sidecarPort} http://127.0.0.1:${sidecarPort} ws://127.0.0.1:${sidecarPort} ${fixtureOrigin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const overlay = {
    productName,
    identifier: bundleIdentifier,
    build: { frontendDist: relative(snapshotSrcTauriDir, frontend), beforeBuildCommand: '' },
    app: {
      windows: [{ label: 'main', title: productName, width: frame.width, height: frame.height, minWidth: frame.width, minHeight: frame.height, decorations: true, titleBarStyle: 'Overlay', hiddenTitle: true, resizable: false, center: true, visible: true }],
      security: { csp },
    },
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: [`${fixtureOrigin}/updater`], dangerousInsecureTransportProtocol: true } },
  }
  const overlayPath = join(sandbox, 'tauri.modal-forms.conf.json')
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  return overlayPath
}

async function waitForReport(state, stage, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = state.reports.find((entry) => entry.stage === stage)
    if (report) return report
    const error = state.reports.find((entry) => entry.stage === 'fixture-error')
    if (error) throw new Error(`WKWebView fixture failed: ${error.message}`)
    await sleep(100)
  }
  throw new Error(`timed out waiting for WKWebView report: ${stage}`)
}

async function main() {
  assert.equal(process.platform, 'darwin', 'native WKWebView boundary is macOS-only')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  const sandbox = mkdtempSync(join(tmpdir(), 'hexclaw-modal-forms-native.'))
  chmodSync(sandbox, 0o700)
  mkdirSync(join(sandbox, '.hexclaw'), { mode: 0o700 })
  mkdirSync(join(sandbox, 'tmp'), { mode: 0o700 })
  const frontend = join(sandbox, 'frontend')
  const cargoTarget = join(srcTauriDir, 'target')
  const appBundle = join(cargoTarget, `release/bundle/macos/${productName}.app`)
  const fixturePort = await reserveLoopbackPort()
  const sidecarPort = await reserveLoopbackPort()
  assert.notEqual(fixturePort, sidecarPort)
  const fixture = createFixtureServer(fixturePort)
  const provenance = { schemaVersion: 1, buildCommand: 'pnpm build-only:package-local', sourceBefore: null, sourceSnapshot: null, sourceCaptureAfterCopy: null, sourceAfter: null, sourceStable: false, snapshotBound: false, productionFrontend: null, injectedFrontend: null, app: null, toolchain: null }
  let appProcess = null
  let appLog = null
  let status = 'NOT_PASS'
  let finalError = null
  const screenshots = {}
  const reports = {}
  try {
    await fixture.listen()
    const configPath = join(sandbox, '.hexclaw/hexclaw.yaml')
    writeFileSync(configPath, renderConfig(sandbox, sidecarPort, fixture.origin), { mode: 0o600 })
    provenance.sourceBefore = currentSourceManifest()
    const snapshot = createSourceSnapshot(sandbox, provenance.sourceBefore)
    provenance.sourceSnapshot = snapshot.manifest
    provenance.sourceCaptureAfterCopy = currentSourceManifest()
    provenance.snapshotBound = provenance.sourceSnapshot.digest === provenance.sourceBefore.digest && provenance.sourceCaptureAfterCopy.head === provenance.sourceBefore.head && provenance.sourceCaptureAfterCopy.digest === provenance.sourceBefore.digest
    assert.ok(provenance.snapshotBound, 'could not capture a stable point-in-time source snapshot')
    const snapshotSrcTauriDir = join(snapshot.root, 'src-tauri')
    provenance.toolchain = { node: process.version, pnpm: execFileSync('pnpm', ['--version'], { cwd: snapshot.root, encoding: 'utf8' }).trim(), rustc: execFileSync('rustc', ['--version'], { cwd: snapshot.root, encoding: 'utf8' }).trim(), cargo: execFileSync('cargo', ['--version'], { cwd: snapshot.root, encoding: 'utf8' }).trim() }
    const offlineEnv = { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: cargoTarget, GOENV: 'off', GOPROXY: 'off', GOSUMDB: 'off', PNPM_CONFIG_OFFLINE: 'true', npm_config_offline: 'true', HEXCLAW_PACKAGE_LOCAL_DIST_DIR: frontend }
    delete offlineEnv.GOROOT
    await runCommand('pnpm', ['build-only:package-local'], { cwd: snapshot.root, env: offlineEnv, timeoutMs: commandTimeoutMs })
    provenance.productionFrontend = treeManifest(frontend)
    prepareFrontend(frontend, fixture.origin, { head: provenance.sourceBefore.head, sourceDigest: provenance.sourceBefore.digest, productionFrontendDigest: provenance.productionFrontend.digest, buildMode: 'package-local' })
    provenance.injectedFrontend = treeManifest(frontend)
    const overlay = writeOverlay(sandbox, frontend, sidecarPort, fixture.origin, snapshotSrcTauriDir)
    await runCommand('pnpm', ['exec', 'tauri', 'build', '--config', overlay, '--bundles', 'app'], { cwd: snapshot.root, env: offlineEnv, timeoutMs: commandTimeoutMs })
    const infoPlist = join(appBundle, 'Contents/Info.plist')
    const executable = join(appBundle, 'Contents/MacOS/hexclaw-desktop')
    const sidecarExecutable = join(appBundle, 'Contents/MacOS/hexclaw')
    assert.ok(existsSync(infoPlist) && existsSync(executable) && existsSync(sidecarExecutable), 'unique Test.app is incomplete')
    const identifier = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist], { encoding: 'utf8' }).trim()
    assert.equal(identifier, bundleIdentifier)
    provenance.app = { productName, identifier, executableSHA256: sha256File(executable), sidecarSHA256: sha256File(sidecarExecutable), infoPlistSHA256: sha256File(infoPlist), realWKWebView: true }
    provenance.sourceAfter = currentSourceManifest()
    provenance.sourceStable = provenance.sourceAfter.head === provenance.sourceBefore.head && provenance.sourceAfter.digest === provenance.sourceBefore.digest
    assert.ok(provenance.sourceStable, 'source changed while building Test.app')
    assert.deepEqual(listenerPIDs(sidecarPort), [], `dedicated Sidecar port ${sidecarPort} is occupied`)
    const appLogPath = join(sandbox, 'app.log')
    appLog = createWriteStream(appLogPath, { flags: 'wx', mode: 0o600 })
    const runtimeEnv = { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', HOME: sandbox, USERPROFILE: sandbox, CFFIXED_USER_HOME: sandbox, TMPDIR: join(sandbox, 'tmp'), TEMP: join(sandbox, 'tmp'), HEXCLAW_TEST_MODE: '1', HEXCLAW_TEST_HOME: sandbox, HEXCLAW_SIDECAR_PORT: String(sidecarPort), HEXCLAW_TEST_LLM_CONFIG_MODE: 'preseeded-owner-yaml', DINGTALK_LIVE_SEND: '0', NO_PROXY: '*', no_proxy: '*' }
    appProcess = spawn(executable, [], { cwd: sandbox, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    appProcess.stdout.pipe(appLog, { end: false });appProcess.stderr.pipe(appLog, { end: false })
    await waitForHealth(sidecarPort, appProcess)
    await waitForReport(fixture.state, 'bootstrap', 60_000)
    const ready = await waitForReport(fixture.state, 'native-modal-tracks-ready', 120_000)
    for (const report of ready.reports || []) {
      reports[report.id] = report
      screenshots[report.id] = captureWindow(appProcess.pid, join(evidenceRoot, `${report.id}.png`))
      assert.equal(report.status, 'PASS', `${report.id} has modal track violations: ${JSON.stringify(report.violations)}`)
    }
    assert.deepEqual(Object.keys(reports).sort(), ['k12-webhook', 'k12-works', 'knowledge', 'prompt'])
    assert.equal(fixture.state.chatRequests, 0)
    assert.deepEqual(fixture.state.unexpectedRequests, [])
    const rawLog = readFileSync(appLogPath, 'utf8')
    // sidecar 会在隔离配置中登记本地 Provider 的显示信息，但测试沙箱仍必须禁止真实 Ollama 探测/托管。
    assert.doesNotMatch(rawLog, /检测到系统 Ollama|外部 Ollama|Ollama 已启动|Ollama 就绪|Ollama 推理探针/, 'isolated Test.app must not probe or manage user Ollama')
    writeFileSync(join(evidenceRoot, 'report.json'), `${JSON.stringify({ schemaVersion: 1, bug: 'BUG-20260723-028', status: 'PASS', scope: 'current-source Test.app WKWebView four modal full-width tracks', environment: { viewport: frame, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'forced by test-only CSS' }, reports, screenshots, app: provenance.app, provenance, isolation: { testHomeMode: '0700', configMode: '0600', uniqueBundleIdentifier: true, sidecarPort, fixturePort, applicationsDirectoryTouched: false, realHomeRead: false, externalNetworkPolicy: 'loopback-only', realModelInvocations: 0, chatRequests: fixture.state.chatRequests } }, null, 2)}\n`)
    status = 'PASS'
    process.stdout.write('\nBUG-20260723-028 native WKWebView modal track boundary PASS\n')
  } catch (error) {
    finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (appProcess && appProcess.exitCode === null) {
      try { screenshots.debug = captureWindow(appProcess.pid, join(evidenceRoot, 'debug.png')) } catch { /* no visible window */ }
    }
    throw error
  } finally {
    await stopProcess(appProcess)
    if (appLog) await new Promise((resolveEnd) => appLog.end(resolveEnd))
    try { await stopOwnedSidecar(sidecarPort, appBundle) } catch (error) { if (!finalError) finalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
    await fixture.close()
    const appLogPath = join(sandbox, 'app.log')
    if (existsSync(appLogPath)) writeFileSync(join(evidenceRoot, 'app.log'), sanitizeLog(readFileSync(appLogPath, 'utf8'), sandbox))
    writeFileSync(join(evidenceRoot, 'provenance.json'), `${JSON.stringify({ ...provenance, status, error: finalError }, null, 2)}\n`)
    rmSync(appBundle, { recursive: true, force: true })
    rmSync(sandbox, { recursive: true, force: true })
    writeFileSync(join(evidenceRoot, 'cleanup.json'), `${JSON.stringify({ status, error: finalError, appProcessStopped: !appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null, sidecarPortReleased: listenerPIDs(sidecarPort).length === 0, fixturePortReleased: listenerPIDs(fixturePort).length === 0, uniqueAppBundleRemoved: !existsSync(appBundle), sandboxRemoved: !existsSync(sandbox), reports: fixture.state.reports }, null, 2)}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
