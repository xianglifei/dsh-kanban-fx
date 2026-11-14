/**
 * 任务看板 · Host 半。
 *
 * 职责：
 * - 持久化卡片（待办 / 进行中 / 待审核 / 已完成），数据落在 $DSH_HOME/dsh-kanban-fx/board.json
 * - 通过 ctx.webServer 暴露看板 HTTP 接口给 Client 半
 * - 「执行」：建（或复用）会话 → 把卡片内容作为一条 user 消息投进去 → 立刻开跑
 *   （首条消息 = 手写标题作第一行 + 正文原样；没写标题时只发正文）
 * - 状态机：由会话本身的事件推导（turn/start → 进行中，turn/end → 待审核）；
 *   设置「完成之后」= prompt 时，点完成先发一条收尾提示词，turn/end 正常结束自动已完成，
 *   报错 / 中止回待审核；否则「已完成」仍是用户手点的标记。用户在会话里再发消息会自动回到进行中
 * - 用户设置（完成之后 / 收尾提示词）和卡片一起存在 board.json 的 settings 里，不走 cordis 配置
 *
 * 这个插件刻意不 import 任何 @deepseek-ai/* 包：profile 里的插件按普通 ESM 解析，
 * 只依赖 node 内置模块与 ctx 上的服务。消息体按 DSH 的 UserMessage 结构就地构造
 * （{id, role:'user', content, source:{kind:'user'}}），与 createUserMessage 等价。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PREFIX = '/kanban-fx'
// v2：card.title 从「展示标题」改为「用户手写的标题」（空串 = 自动取正文首行）
const STORE_VERSION = 2
const SSE_MAX_CLIENTS = 8
const SSE_HEARTBEAT_MS = 25_000
const BODY_LIMIT_BYTES = 40 * 1024 * 1024

const CONFIG_DEFAULTS = {
  dataDir: '',
  maxBodyChars: 200000,
  maxCardAttachmentBytes: 24 * 1024 * 1024,
}

// 完成设置：点「完成」之后什么都不做，或先发一条收尾提示词、等这一轮正常跑完再自动完成。
// 存在 board.json 的顶层 settings 里，不动 cordis 配置，所以改完立即生效、不重启插件。
const COMPLETION_MODES = new Set(['none', 'prompt'])
const PROMPT_MAX_CHARS = 4000
// 收尾提示词刚投递时 agent 可能还没醒；给它比普通 run 更长的宽限，避免 reconcile 误判
const FINISH_GRACE_MS = 10_000

const PACKAGE_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '')
  } catch {
    return ''
  }
})()

const DEFAULT_COMPLETION = { mode: 'none', prompt: '' }

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 卡片的四个状态。todo 还没有会话；其余由会话事件 + doneAt 推导。 */
const STATUS = { TODO: 'todo', RUNNING: 'running', REVIEW: 'review', DONE: 'done' }

function textOf(value, limit) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? value.slice(0, limit) : value
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function cancelled(status) {
  return status >= 400 && status < 500
}

function base64ToBytes(data) {
  if (typeof data !== 'string' || data.length === 0) throw httpError(400, '附件内容是空的')
  const buffer = Buffer.from(data, 'base64')
  // 只接受规范 base64，避免把半截数据写进附件库
  if (buffer.toString('base64') !== data) throw httpError(400, '附件不是合法的 base64')
  return new Uint8Array(buffer)
}

const TITLE_MAX_CHARS = 42

/** 用户手写的标题：压成单行。空串表示「没写标题」，展示标题再按正文首行派生。 */
function titleOf(value) {
  return textOf(value, 80)
    .replace(/\s+/g, ' ')
    .trim()
}

/** 派生标题用：剥掉行首的 markdown 记号（#、列表、引用、围栏）与成对强调记号。 */
function titleLineOf(line) {
  let value = String(line ?? '').trim()
  for (let round = 0; round < 3; round += 1) {
    const before = value
    value = value
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*+>]\s+/, '')
      .replace(/^\d{1,2}[.)、]\s*/, '')
      .replace(/^```[\w-]*\s*/, '')
      .trim()
    const paired = value.match(/^(\*\*|__|`)(.+?)\1$/)
    if (paired) value = paired[2].trim()
    if (value === before) break
  }
  return value.replace(/\s+/g, ' ').trim()
}

/** 正文里第一个能当标题的行：跳过空行与 `---` / `***` 这类分隔线。 */
function firstTitleLine(body) {
  for (const line of textOf(body, 4000).split('\n')) {
    if (/^\s*[-*_=]{3,}\s*$/.test(line)) continue
    const value = titleLineOf(line)
    if (value) return value
  }
  return ''
}

/** 标题截断：优先落在句读 / 空格边界，别把一句话切成半个词。 */
function clipTitle(text, max = TITLE_MAX_CHARS) {
  const chars = Array.from(text)
  const head = chars.length > max ? chars.slice(0, max).join('') : text
  let cut = head
  if (chars.length > max) {
    let lastMark = -1
    for (const mark of ['。', '！', '？', '；', '.', '!', '?', ';']) {
      lastMark = Math.max(lastMark, head.lastIndexOf(mark))
    }
    if (lastMark >= Math.floor(max / 2)) {
      cut = head.slice(0, lastMark + 1)
    } else {
      const lastBreak = Math.max(head.lastIndexOf(' '), head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('、'))
      if (lastBreak >= Math.floor(max / 2)) cut = head.slice(0, lastBreak)
    }
  }
  return cut.replace(/[。．.!！?？;；,，、：:\s]+$/, '').trim()
}

/**
 * 卡片的展示标题：手写标题 → 正文首行 → 单个附件的文件名 → 未命名事项。
 * 只用于卡片和会话名，不参与首条消息（消息里只发用户手写的那份标题）。
 */
function deriveTitle(title, body, attachments) {
  const given = titleOf(title)
  if (given) return given
  const line = firstTitleLine(body)
  if (line) return clipTitle(line)
  const attachmentName =
    Array.isArray(attachments) && attachments.length === 1 ? textOf(attachments[0] && attachments[0].name, 80).trim() : ''
  if (attachmentName) return clipTitle(attachmentName)
  return '未命名事项'
}

/** 旧版（v1）的派生规则：迁移时用来判断某个 title 当年是不是自动取的。 */
function legacyDerivedTitle(body) {
  const firstLine = textOf(body, 4000)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? firstLine.slice(0, 42) : '未命名事项'
}

/**
 * 首条消息里的文本：手写标题作第一行（`# 标题`），正文原样跟在后面。
 * 没写标题时只发正文；正文首行已经是同一句标题时不重复。
 */
function messageTextOf(card) {
  const body = (card.body || '').trim()
  const heading = titleLineOf(card.title || '')
  if (!body) return heading
  if (!heading) return body
  const first = firstTitleLine(body)
  if (first && first.toLowerCase() === heading.toLowerCase()) return body
  return `# ${heading}\n\n${body}`
}

function statusOf(card) {
  if (card.runningSince) return STATUS.RUNNING
  if (!card.sessionId) return STATUS.TODO
  if (card.doneAt) return STATUS.DONE
  return STATUS.REVIEW
}

function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  const settings = { ...CONFIG_DEFAULTS }
  if (typeof input.dataDir === 'string' && input.dataDir.trim()) settings.dataDir = input.dataDir.trim()
  if (Number.isFinite(input.maxBodyChars) && input.maxBodyChars > 0) settings.maxBodyChars = Math.floor(input.maxBodyChars)
  if (Number.isFinite(input.maxCardAttachmentBytes) && input.maxCardAttachmentBytes > 0) {
    settings.maxCardAttachmentBytes = Math.floor(input.maxCardAttachmentBytes)
  }
  return settings
}

function defaultUserSettings() {
  return { completion: { ...DEFAULT_COMPLETION } }
}

/**
 * 读盘 / 脏数据用：只收白名单，超长截断；mode=prompt 却没有提示词时回落 none。
 * 这里不抛错——坏设置不能拖垮插件启动，接口写入另走 userSettingsFromRequest。
 */
function sanitizeUserSettings(input) {
  const completion =
    input && typeof input === 'object' && input.completion && typeof input.completion === 'object' ? input.completion : null
  const prompt = completion ? textOf(completion.prompt, PROMPT_MAX_CHARS).trim() : ''
  const mode = completion && completion.mode === 'prompt' && prompt ? 'prompt' : 'none'
  return { completion: { mode, prompt } }
}

/** 接口写入用：严格校验，非法值 400，绝不把半截设置写进 board.json。 */
function userSettingsFromRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, '设置格式不正确')
  const completion = input.completion
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) throw httpError(400, '缺少完成设置')
  if (!COMPLETION_MODES.has(completion.mode)) throw httpError(400, '完成设置的值不合法')
  const prompt = typeof completion.prompt === 'string' ? completion.prompt.trim() : ''
  if (prompt.length > PROMPT_MAX_CHARS) throw httpError(400, `收尾提示词最多 ${PROMPT_MAX_CHARS} 字符`)
  if (completion.mode === 'prompt' && !prompt) throw httpError(400, '选择发送收尾提示词时，提示词不能为空')
  return { completion: { mode: completion.mode, prompt } }
}

/** 一张卡片对外（Client）的形状：不含附件字节。 */
function viewOf(card) {
  const title = deriveTitle(card.title, card.body, card.attachments)
  return {
    id: card.id,
    seq: Number.isInteger(card.seq) && card.seq > 0 ? card.seq : null,
    // title 是展示标题（手写 → 正文首行 → 附件名），titleInput 才是用户亲手写的那份
    title,
    titleInput: card.title || '',
    titleDerived: !(card.title || '').trim(),
    body: card.body,
    workspaceId: card.workspaceId,
    attachments: card.attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      bytes: attachment.bytes,
      mediaType: attachment.mediaType,
      width: attachment.width,
      height: attachment.height,
    })),
    status: statusOf(card),
    // 「收尾中」不是第五种状态：status 仍是 running，这里只给 Client 一个派生标识
    finishing: Boolean(card.finishingSince),
    sessionId: card.sessionId,
    sessionArchived: Boolean(card.sessionArchived),
    runningSince: card.runningSince,
    lastRunStartedAt: card.lastRunStartedAt,
    lastRunEndedAt: card.lastRunEndedAt,
    lastRunMs: card.lastRunMs,
    doneAt: card.doneAt,
    error: card.error,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  }
}

function emptyStore() {
  return { version: STORE_VERSION, rev: 1, nextSeq: 1, lastWorkspaceId: null, settings: defaultUserSettings(), cards: {} }
}

function loadStore(file) {
  if (!existsSync(file)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.cards || typeof parsed.cards !== 'object') return emptyStore()
    const cards = {}
    // v1 的 title 存的是「展示标题」（可能是自动取的正文首行），v2 起只存手写标题。
    const fromVersion = Number(parsed.version) || 1
    for (const [id, card] of Object.entries(parsed.cards)) {
      if (!card || typeof card !== 'object') continue
      const body = typeof card.body === 'string' ? card.body : ''
      const storedTitle = textOf(card.title, 120).trim()
      // 老数据里 title 和老派生规则一致（或就是占位名）→ 当年没手写，迁成空串继续自动派生
      const autoTitle =
        fromVersion < STORE_VERSION &&
        (!storedTitle || storedTitle === legacyDerivedTitle(body) || storedTitle === '未命名事项')
      cards[id] = {
        id,
        seq: null,
        title: autoTitle ? '' : storedTitle,
        body,
        workspaceId: typeof card.workspaceId === 'string' && card.workspaceId ? card.workspaceId : null,
        attachments: Array.isArray(card.attachments) ? card.attachments.filter((item) => item && typeof item.id === 'string') : [],
        sessionId: typeof card.sessionId === 'string' && card.sessionId ? card.sessionId : null,
        sessionArchived: Boolean(card.sessionArchived),
        createdAt: Number(card.createdAt) || Date.now(),
        updatedAt: Number(card.updatedAt) || Date.now(),
        runningSince: Number(card.runningSince) || null,
        lastRunStartedAt: Number(card.lastRunStartedAt) || null,
        lastRunEndedAt: Number(card.lastRunEndedAt) || null,
        lastRunMs: Number(card.lastRunMs) || null,
        doneAt: Number(card.doneAt) || null,
        finishingSince: Number(card.finishingSince) || null,
        error: typeof card.error === 'string' && card.error ? card.error : null,
      }
    }
    // 卡片编号（fx-N）：先收下旧数据里已有的编号，缺的按创建时间补一轮。
    // 编号只增不复用：删掉卡片后留下的空号不会再发给下一张卡。
    const ordered = Object.values(cards).sort(
      (left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)),
    )
    const used = new Set()
    for (const card of ordered) {
      const seq = Number(parsed.cards[card.id]?.seq)
      if (Number.isInteger(seq) && seq > 0 && !used.has(seq)) {
        card.seq = seq
        used.add(seq)
      }
    }
    let highest = 0
    for (const seq of used) highest = Math.max(highest, seq)
    for (const card of ordered) {
      if (card.seq) continue
      highest += 1
      card.seq = highest
    }
    const storedNext = Number(parsed.nextSeq)
    return {
      // 迁移过的 v1 标记成 2；不把更高版本的文件降级，免得旧代码悄悄改坏新数据
      version: Math.max(fromVersion, STORE_VERSION),
      rev: Number(parsed.rev) || 1,
      nextSeq: Number.isInteger(storedNext) && storedNext > highest + 1 ? storedNext : highest + 1,
      lastWorkspaceId: typeof parsed.lastWorkspaceId === 'string' ? parsed.lastWorkspaceId : null,
      settings: sanitizeUserSettings(parsed.settings),
      cards,
    }
  } catch (error) {
    console.error('[kanban-fx] 读取看板数据失败，改用空看板：', error?.message ?? error)
    return emptyStore()
  }
}

export function apply(ctx, config) {
  const configSettings = normalizeConfig(config)
  const dataDir = configSettings.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-kanban-fx')
  const storeFile = join(dataDir, 'board.json')
  const store = loadStore(storeFile)
  // 用户设置跟看板数据走；插件配置只留 dataDir / 上限，两套东西不混。
  let userSettings = sanitizeUserSettings(store.settings)
  store.settings = userSettings

  const sseClients = new Set()
  /** response → 心跳计时器，连接断开 / 插件卸载时一起清掉。 */
  const beats = new Map()
  let saveTimer = null
  let persistPending = false
  let rev = Number(store.rev) || 1

  /** sessionId → card，用来把会话事件映射回卡片。 */
  const bySession = new Map()
  for (const card of Object.values(store.cards)) {
    if (card.sessionId) bySession.set(card.sessionId, card)
  }

  function indexCard(card) {
    if (!card.sessionId) return
    bySession.set(card.sessionId, card)
  }

  function writeStore() {
    if (persistPending) {
      persistPending = false
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
    }
    store.rev = rev
    try {
      mkdirSync(dataDir, { recursive: true })
      const tmp = `${storeFile}.tmp`
      writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
      renameSync(tmp, storeFile)
    } catch (error) {
      console.error('[kanban-fx] 保存看板数据失败：', error?.message ?? error)
    }
  }

  function saveSoon() {
    if (persistPending) return
    persistPending = true
    saveTimer = setTimeout(writeStore, 120)
  }

  function saveNow() {
    writeStore()
  }

  function sseSend(response, event, data) {
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      stopBeat(response)
      sseClients.delete(response)
    }
  }

  function stopBeat(response) {
    const timer = beats.get(response)
    if (!timer) return
    clearInterval(timer)
    beats.delete(response)
  }

  /** 有变化才推：客户端收到 rev 后自己去读 /board。 */
  function broadcast(reason) {
    rev += 1
    store.rev = rev
    const frame = { rev, reason }
    for (const client of [...sseClients]) sseSend(client, 'rev', frame)
  }

  function changed(reason) {
    saveSoon()
    broadcast(reason)
  }

  function touch(card, reason, { persist = true } = {}) {
    card.updatedAt = Date.now()
    if (persist) saveSoon()
    broadcast(reason)
  }

  function workspaceList() {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return []
    try {
      return registry.list().map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
      }))
    } catch (error) {
      console.error('[kanban-fx] 读取工作区列表失败：', error?.message ?? error)
      return []
    }
  }

  function archivedSessionIds() {
    const registry = ctx.get('workspaceRegistry')
    const ids = registry?.archivedSessionIds
    return Array.isArray(ids) ? ids : []
  }

  /** 把附件从请求里落到 DSH 附件库，返回卡片上要记的元数据。 */
  async function saveAttachments(input) {
    const attachments = ctx.get('attachments')
    if (!attachments) {
      if (Array.isArray(input) && input.length > 0) throw httpError(503, '当前 DSH 版本没有附件服务，无法保存附件')
      return []
    }
    const list = Array.isArray(input) ? input : []
    const out = []
    let total = 0
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      // 编辑已有卡片时前端回传的既有附件：原样保留（不重复落盘）
      if (typeof item.attachmentId === 'string' && item.attachmentId) {
        const kind = item.kind === 'image' ? 'image' : 'file'
        out.push({
          id: item.attachmentId,
          kind,
          name: textOf(item.name, 200) || (kind === 'image' ? 'image' : 'file'),
          bytes: Number(item.bytes) || 0,
          mediaType: kind === 'image' && IMAGE_MEDIA_TYPES.has(item.mediaType) ? item.mediaType : undefined,
          width: Number(item.width) || undefined,
          height: Number(item.height) || undefined,
        })
        continue
      }
      const bytes = base64ToBytes(item.data)
      total += bytes.length
      if (total > configSettings.maxCardAttachmentBytes) {
        throw httpError(413, `附件总大小超过上限（${Math.round(configSettings.maxCardAttachmentBytes / 1024 / 1024)} MB）`)
      }
      const name = textOf(item.name, 200)
      if (item.kind === 'image') {
        const mediaType = typeof item.mediaType === 'string' ? item.mediaType : ''
        if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw httpError(400, '图片格式不支持（PNG / JPEG / WebP / GIF）')
        let ref
        try {
          ref = await attachments.saveImage({ data: bytes, mediaType, ...(name ? { name } : {}) })
        } catch (error) {
          throw httpError(400, `图片保存失败：${error?.message ?? String(error)}`)
        }
        out.push({
          id: ref.attachmentId,
          kind: 'image',
          name: ref.name || name || 'image',
          bytes: ref.bytes,
          mediaType: ref.mediaType,
          width: ref.width,
          height: ref.height,
        })
      } else {
        let ref
        try {
          ref = await attachments.saveFile({ data: bytes, ...(name ? { name } : {}) })
        } catch (error) {
          throw httpError(400, `附件保存失败：${error?.message ?? String(error)}`)
        }
        out.push({
          id: ref.attachmentId,
          kind: 'file',
          name: ref.name || name || 'file',
          bytes: ref.bytes,
        })
      }
    }
    return out
  }

  /** 卡片内容 + 附件 → DSH 原生内容块（与新会话输入框产出的类型一致）。 */
  async function contentOf(card) {
    const parts = []
    const text = messageTextOf(card)
    if (text) parts.push({ type: 'text', text })
    for (const attachment of card.attachments) {
      if (attachment.kind === 'image' && attachment.mediaType && attachment.width && attachment.height) {
        parts.push({
          type: 'image',
          attachment: {
            attachmentId: attachment.id,
            mediaType: attachment.mediaType,
            bytes: attachment.bytes,
            width: attachment.width,
            height: attachment.height,
            ...(attachment.name ? { name: attachment.name } : {}),
          },
          encodedBytes: attachment.bytes,
        })
      } else {
        parts.push({
          type: 'file',
          attachment: {
            attachmentId: attachment.id,
            name: attachment.name || 'file',
            bytes: attachment.bytes,
          },
        })
      }
    }
    // 走附件服务的准入，沿用 DSH 自己的图片数量 / 总字节上限
    const attachments = ctx.get('attachments')
    if (attachments && typeof attachments.admitPromptContent === 'function') {
      try {
        return await attachments.admitPromptContent(parts)
      } catch (error) {
        throw httpError(400, `附件无法随消息发送：${error?.message ?? String(error)}`)
      }
    }
    return parts
  }

  function nameSession(session, card) {
    const titles = ctx.get('sessionTitle')
    if (!titles || typeof titles.rename !== 'function' || !session) return
    try {
      const current = titles.get(session)
      if (current && current.title && current.title.trim()) return
      titles.rename(session, deriveTitle(card.title, card.body, card.attachments))
    } catch (error) {
      console.error('[kanban-fx] 会话改名失败：', error?.message ?? error)
    }
  }

  async function resolveAgent(controller, sessionId) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await controller.resolveAgent(sessionId)
      if (result && result.agent) return { agent: result.agent }
      lastError = result && result.error ? result.error : null
      // 会话刚建好时可能还没就绪，稍等重试；其余错误立刻返回
      if (lastError && lastError.code !== 'session/agent-busy') break
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return { error: lastError }
  }

  /** 执行一张卡片：没有会话就建一个（挂到卡片的工作区下），再把内容投进去并开跑。 */
  async function runCard(card) {
    if (card.runningSince) throw httpError(409, '这个卡片正在运行')
    if (!(card.body || '').trim() && card.attachments.length === 0 && !(card.title || '').trim()) {
      throw httpError(400, '卡片是空的，先写点内容')
    }
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.create !== 'function') {
      throw httpError(503, '当前 DSH 版本没有会话创建服务，无法执行')
    }

    const archived = archivedSessionIds()
    if (card.sessionId && archived.includes(card.sessionId)) card.sessionId = null

    let agent = null
    if (card.sessionId) {
      const resolved = await resolveAgent(controller, card.sessionId)
      if (resolved && resolved.agent) agent = resolved.agent
      else {
        const code = resolved?.error?.code
        if (code === 'session/not-found') {
          card.sessionId = null
          card.sessionArchived = true
        } else {
          throw httpError(409, `会话无法继续：${resolved?.error?.message || '未知原因'}`)
        }
      }
    }

    if (!card.sessionId) {
      const workspaces = workspaceList()
      const fallbackWorkspaceId = store.lastWorkspaceId && workspaces.some((item) => item.id === store.lastWorkspaceId)
        ? store.lastWorkspaceId
        : (workspaces[0]?.id ?? null)
      const workspaceId = card.workspaceId || fallbackWorkspaceId
      if (workspaceId && !card.workspaceId) card.workspaceId = workspaceId
      let created
      try {
        created = await controller.create({
          sessionId: `session-${randomUUID()}`,
          ...(workspaceId ? { workspaceId } : {}),
        })
      } catch (error) {
        if (String(error?.code ?? '') === 'workspace/not-found') {
          throw httpError(409, '这张卡片的工作区不存在了，请在卡片里换一个工作区再执行')
        }
        throw httpError(500, `会话创建失败：${error?.message ?? String(error)}`)
      }
      card.sessionId = created.sessionId
      card.sessionArchived = false
      bySession.set(card.sessionId, card)
      const resolved = await resolveAgent(controller, card.sessionId)
      if (!resolved || !resolved.agent) {
        throw httpError(500, `会话已创建但没能启动：${resolved?.error?.message || '未知原因'}`)
      }
      agent = resolved.agent
    }

    const content = await contentOf(card)
    if (content.length === 0) throw httpError(400, '卡片没有可执行的内容')

    nameSession(agent.session, card)

    // 先记「进行中」：turn/start 事件到达后会覆盖成真实开始时间
    card.runningSince = Date.now()
    card.lastRunStartedAt = card.runningSince
    card.lastRunEndedAt = null
    card.doneAt = null
    card.error = null
    touch(card, 'run')

    const message = {
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'user' },
    }
    try {
      agent.followup(message)
    } catch (error) {
      card.runningSince = null
      card.error = String(error?.message ?? error)
      touch(card, 'run-failed')
      throw httpError(500, `投递失败：${card.error}`)
    }
    try {
      await ctx.sessions?.flush?.(agent.session)
    } catch (error) {
      console.error('[kanban-fx] 会话落盘确认失败（不影响运行）：', error?.message ?? error)
    }
    return card
  }

  /** 给新卡片分配短编号（对用户显示为 fx-N）。只增不减，删卡不回收。 */
  function allocateSeq() {
    const seq = Number.isInteger(store.nextSeq) && store.nextSeq > 0 ? store.nextSeq : 1
    store.nextSeq = seq + 1
    return seq
  }

  async function createCard(input, run) {
    const attachments = await saveAttachments(input?.attachments)
    const card = {
      id: `card-${randomUUID()}`,
      seq: allocateSeq(),
      title: titleOf(input?.title),
      body: textOf(input?.body, configSettings.maxBodyChars),
      workspaceId: typeof input?.workspaceId === 'string' && input.workspaceId ? input.workspaceId : null,
      attachments,
      sessionId: null,
      sessionArchived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runningSince: null,
      lastRunStartedAt: null,
      lastRunEndedAt: null,
      lastRunMs: null,
      doneAt: null,
      finishingSince: null,
      error: null,
    }
    store.cards[card.id] = card
    if (card.workspaceId) store.lastWorkspaceId = card.workspaceId
    touch(card, 'create', { persist: true })
    saveNow()
    if (run) await runCard(card)
    return card
  }

  async function updateCard(input) {
    const card = store.cards[String(input?.id ?? '')]
    if (!card) throw httpError(404, '卡片不存在')
    if (card.sessionId) throw httpError(409, '已经执行过的卡片不能再改内容（去会话里继续）')
    const attachments = await saveAttachments(input?.attachments)
    card.title = titleOf(input?.title)
    card.body = textOf(input?.body, configSettings.maxBodyChars)
    card.workspaceId = typeof input?.workspaceId === 'string' && input.workspaceId ? input.workspaceId : null
    card.attachments = attachments
    if (card.workspaceId) store.lastWorkspaceId = card.workspaceId
    touch(card, 'update')
    return card
  }

  function cardOf(input) {
    const card = store.cards[String(input?.id ?? '')]
    if (!card) throw httpError(404, '卡片不存在')
    return card
  }

  /**
   * 会话 id → 卡片。必须核对 card.sessionId 本身，不能只看 bySession：
   * 卡片「重新执行」后，旧会话在 bySession 里仍指向同一张卡，但卡已经换了会话，
   * 从旧会话点「完成」应该找不到卡片（返回 null），而不是标到新会话那张卡上。
   */
  function cardBySession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (!id) return null
    for (const card of Object.values(store.cards)) {
      if (card.sessionId === id) return card
    }
    return null
  }

  /**
   * 用户手点「完成」；只有待审核的卡片能点。看板传 id，会话页标题栏传 sessionId。
   *
   * mode = none：和以前一样，立刻 doneAt。
   * mode = prompt：先把收尾提示词作为一条普通 user 消息投给当前会话，卡片进入
   * 「进行中 + finishingSince」；turn/end 正常结束时才自动 doneAt。
   * 会话已归档 / 找不到时不再瞎试，直接完成并回一个 fallback 警告。
   */
  async function markDone(input) {
    const card = input?.id ? cardOf(input) : cardBySession(input?.sessionId)
    if (!card) {
      throw httpError(404, input?.sessionId ? '这个会话没有关联的看板卡片' : '卡片不存在')
    }
    if (statusOf(card) !== STATUS.REVIEW) throw httpError(409, '只有待审核的卡片可以标记完成')

    const completion = userSettings.completion
    // 脏数据 / 空提示词按「什么都不做」处理，别让一次点完成变成无法完成的错误
    if (completion.mode !== 'prompt' || !completion.prompt) {
      card.doneAt = Date.now()
      card.finishingSince = null
      touch(card, 'done')
      return { card, completionResult: 'done', completionWarning: null }
    }

    const sessionId = card.sessionId
    const sessionArchived = Boolean(card.sessionArchived || (sessionId && archivedSessionIds().includes(sessionId)))
    if (!sessionId || sessionArchived) {
      if (sessionArchived) card.sessionArchived = true
      card.doneAt = Date.now()
      card.finishingSince = null
      touch(card, 'done')
      return {
        card,
        completionResult: 'fallback-done',
        completionWarning: sessionArchived ? 'session-archived' : 'session-missing',
      }
    }

    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') {
      throw httpError(503, '当前 DSH 版本没有会话服务，无法发送收尾提示词')
    }
    const resolved = await resolveAgent(controller, sessionId)
    if (!resolved || !resolved.agent) {
      if (resolved?.error?.code === 'session/not-found') {
        card.sessionArchived = true
        card.doneAt = Date.now()
        card.finishingSince = null
        touch(card, 'done')
        return { card, completionResult: 'fallback-done', completionWarning: 'session-missing' }
      }
      throw httpError(409, `会话无法继续：${resolved?.error?.message || '未知原因'}`)
    }

    // 先记「收尾中」再投递：客户端立刻能看到卡片动，重复点击也会被 statusOf 挡住。
    const previous = {
      runningSince: card.runningSince,
      lastRunStartedAt: card.lastRunStartedAt,
      lastRunEndedAt: card.lastRunEndedAt,
      doneAt: card.doneAt,
      error: card.error,
      finishingSince: card.finishingSince,
    }
    const startedAt = Date.now()
    card.runningSince = startedAt
    card.lastRunStartedAt = startedAt
    card.lastRunEndedAt = null
    card.doneAt = null
    card.error = null
    card.finishingSince = startedAt
    touch(card, 'finishing')

    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: completion.prompt }],
      source: { kind: 'user' },
    }
    try {
      resolved.agent.followup(message)
    } catch (error) {
      // 投递失败就回到点之前的样子；不要留下一个永远「收尾中」的卡
      Object.assign(card, previous)
      touch(card, 'finishing-failed')
      throw httpError(409, `收尾提示词发送失败：${error?.message ?? String(error)}`)
    }
    return { card, completionResult: 'sent', completionWarning: null }
  }

  function markUndone(input) {
    const card = cardOf(input)
    card.doneAt = null
    touch(card, 'undone')
    return card
  }

  function removeCard(input) {
    const card = cardOf(input)
    if (card.runningSince) throw httpError(409, '正在运行的卡片不能删除')
    delete store.cards[card.id]
    if (card.sessionId) bySession.delete(card.sessionId)
    changed('delete')
    saveNow()
    return card
  }

  /** 卡片状态与会话实况对齐：只修正在运行的卡片，避免误伤已完成。 */
  function reconcile() {
    const agents = ctx.get('agents')
    const archived = archivedSessionIds()
    const now = Date.now()
    let dirty = false
    for (const card of Object.values(store.cards)) {
      if (card.sessionId && archived.includes(card.sessionId) && !card.sessionArchived) {
        card.sessionArchived = true
        dirty = true
      }
      // 收尾中：给足 10s 让 agent 醒过来；确认它没在跑就回待审核，绝不猜成功。
      if (card.finishingSince) {
        if (now - card.finishingSince < FINISH_GRACE_MS) continue
        const finishingAgent = card.sessionId ? agents?.get?.(card.sessionId) : undefined
        if (finishingAgent && finishingAgent.status === 'running') continue
        card.finishingSince = null
        card.runningSince = null
        card.lastRunEndedAt = now
        // 不收尾轮的时长覆盖原任务用时：完成/待审核卡片仍显示最后一次任务运行的时间
        card.error = card.error || '收尾没有跑起来，请再点一次完成'
        dirty = true
        continue
      }
      if (!card.runningSince) continue
      // 刚投递的几毫秒里 agent 可能还没被唤醒，留一点余量再判「其实已经停了」
      if (now - card.runningSince < 3000) continue
      const agent = card.sessionId ? agents?.get?.(card.sessionId) : undefined
      if (agent && agent.status === 'running') continue
      // 事件漏了也能自愈：agent 不在、或已经 idle，就当作这一轮结束，落到待审核
      card.runningSince = null
      card.lastRunEndedAt = now
      card.lastRunMs = card.lastRunStartedAt ? Math.max(0, now - card.lastRunStartedAt) : null
      dirty = true
    }
    if (dirty) {
      saveSoon()
      broadcast('reconcile')
    }
  }

  // ---- 会话事件 → 卡片状态 ------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const card = bySession.get(session.id)
    if (!card) return
    if (event.type === 'turn/start') {
      card.runningSince = event.time
      card.lastRunStartedAt = event.time
      card.lastRunEndedAt = null
      card.doneAt = null
      card.error = null
      touch(card, 'turn-start')
      return
    }
    if (event.type === 'turn/end') {
      const finishing = Boolean(card.finishingSince)
      if (!card.runningSince && card.lastRunEndedAt && !finishing) return
      const reason = event.data && event.data.reason
      card.runningSince = null
      card.lastRunEndedAt = event.time
      // 收尾轮不覆盖原任务的用时：完成卡片仍显示最后一次任务运行了多久
      if (!finishing) {
        card.lastRunMs = card.lastRunStartedAt ? Math.max(0, event.time - card.lastRunStartedAt) : null
      }
      if (reason && reason.kind === 'error') {
        card.error = reason.error?.message || '运行失败'
      } else if (reason && reason.kind === 'aborted') {
        card.error = null
      }
      if (finishing) {
        card.finishingSince = null
        const failed = Boolean(reason && (reason.kind === 'error' || reason.kind === 'aborted'))
        // 只有正常结束才自动完成；报错 / 中止一律回待审核
        card.doneAt = failed ? null : event.time
      }
      touch(card, finishing ? 'turn-end-finishing' : 'turn-end')
    }
  })

  ctx.on('agent/error', (payload) => {
    const card = payload && payload.agent ? bySession.get(payload.agent.id) : undefined
    if (!card) return
    card.error = String(payload.error?.message ?? payload.error ?? '运行失败')
    touch(card, 'agent-error')
  })

  // ---- HTTP ---------------------------------------------------------------
  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        const error = httpError(413, '请求体过大')
        throw error
      }
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      throw httpError(400, '请求体不是合法 JSON')
    }
  }

  function boardPayload() {
    const workspaces = workspaceList()
    const defaultWorkspaceId = store.lastWorkspaceId && workspaces.some((item) => item.id === store.lastWorkspaceId)
      ? store.lastWorkspaceId
      : (workspaces[0]?.id ?? null)
    return {
      ok: true,
      rev,
      serverNow: Date.now(),
      cards: Object.values(store.cards).sort((a, b) => a.createdAt - b.createdAt).map(viewOf),
      workspaces,
      defaultWorkspaceId,
      settings: { completion: { ...userSettings.completion } },
      advanced: {
        version: PACKAGE_VERSION,
        dataDir,
        storeFile,
        storeVersion: STORE_VERSION,
        limits: {
          maxBodyChars: configSettings.maxBodyChars,
          maxCardAttachmentBytes: configSettings.maxCardAttachmentBytes,
        },
      },
    }
  }

  async function serveAttachment(req, res, url) {
    const attachments = ctx.get('attachments')
    if (!attachments) return sendJson(res, 503, { ok: false, error: '没有附件服务' })
    const id = url.searchParams.get('id') || ''
    const card = Object.values(store.cards).find((item) => item.attachments.some((attachment) => attachment.id === id))
    const attachment = card && card.attachments.find((item) => item.id === id)
    if (!attachment) return sendJson(res, 404, { ok: false, error: '附件不存在' })
    try {
      if (attachment.kind === 'image') {
        const stored = await attachments.readImage({
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          bytes: attachment.bytes,
          width: attachment.width,
          height: attachment.height,
          ...(attachment.name ? { name: attachment.name } : {}),
        })
        const buffer = Buffer.from(stored.data)
        res.writeHead(200, {
          'content-type': stored.ref.mediaType,
          'cache-control': 'private, max-age=300',
          'content-length': buffer.length,
        })
        res.end(buffer)
        return
      }
      const buffer = []
      for await (const chunk of attachments.readFileStream({
        attachmentId: attachment.id,
        name: attachment.name || 'file',
        bytes: attachment.bytes,
      })) {
        buffer.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(buffer)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name || 'file')}`,
        'cache-control': 'private, max-age=300',
        'content-length': body.length,
      })
      res.end(body)
    } catch (error) {
      console.error('[kanban-fx] 读取附件失败：', error?.message ?? error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: '附件读取失败' })
      else res.end()
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? PREFIX, 'http://127.0.0.1')
    const path = url.pathname
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false

    // 非 /api 前缀的路由不会自动过 DSH 的信任校验，这里自己补上
    const connection = ctx.get('connection')
    if (connection && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return true
      }
    } else {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('kanban-fx: DSH connection service unavailable')
      return true
    }

    if (req.method === 'GET' && path === `${PREFIX}/board`) {
      reconcile()
      sendJson(res, 200, boardPayload())
      return true
    }

    // 会话页标题栏用：这个会话对应哪张卡片（不是看板卡片就返回 null）。
    // 只回一张卡，避免每开一个会话都把整块看板传一遍。
    if (req.method === 'GET' && path === `${PREFIX}/card`) {
      const sessionId = url.searchParams.get('sessionId') || ''
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        return true
      }
      reconcile()
      const card = cardBySession(sessionId)
      // completionMode 只给会话标题栏判断 tooltip 用；看板卡片自己从 settings 里读
      const view = card ? { ...viewOf(card), completionMode: userSettings.completion.mode } : null
      sendJson(res, 200, { ok: true, card: view })
      return true
    }

    if (req.method === 'GET' && path === `${PREFIX}/events`) {
      if (sseClients.size >= SSE_MAX_CLIENTS) {
        sendJson(res, 429, { ok: false, error: '订阅连接过多' })
        return true
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      sseClients.add(res)
      sseSend(res, 'rev', { rev, reason: 'hello' })
      const drop = () => {
        stopBeat(res)
        sseClients.delete(res)
        try {
          res.end()
        } catch {}
      }
      // 心跳：让客户端能区分「真的没变化」和「连接其实已经死了」。
      // EventSource 在 429 / 非 200 之后按规范不再重连，只看 onerror 是发现不了的。
      beats.set(
        res,
        setInterval(() => {
          if (res.writableEnded) return drop()
          sseSend(res, 'beat', { at: Date.now() })
        }, SSE_HEARTBEAT_MS),
      )
      req.on('close', drop)
      req.on('error', drop)
      res.on('close', drop)
      res.on('error', drop)
      return true
    }

    if (req.method === 'GET' && path === `${PREFIX}/attachment`) {
      await serveAttachment(req, res, url)
      return true
    }

    if (req.method === 'POST' && path === `${PREFIX}/settings`) {
      const body = await readJson(req)
      const next = userSettingsFromRequest(body.settings)
      userSettings = next
      store.settings = next
      broadcast('settings')
      saveNow()
      sendJson(res, 200, boardPayload())
      return true
    }

    if (req.method === 'POST' && path === `${PREFIX}/card`) {
      const body = await readJson(req)
      const action = typeof body.action === 'string' ? body.action : ''
      let card = null
      let completionResult = null
      let completionWarning = null
      if (action === 'create') card = await createCard(body.card, Boolean(body.run))
      // id 既接受 card.id（现在的客户端），也接受顶层 id（旧客户端 / 手工调用）
      else if (action === 'update') card = await updateCard({ ...(body.card || {}), id: body.id ?? body.card?.id })
      else if (action === 'delete') card = removeCard(body)
      else if (action === 'run') card = await runCard(cardOf(body))
      else if (action === 'done') {
        const result = await markDone(body)
        card = result.card
        completionResult = result.completionResult
        completionWarning = result.completionWarning
      } else if (action === 'undone') card = markUndone(body)
      else throw httpError(400, `未知操作：${action || '(空)'}`)
      if (card) saveNow()
      const payload = { ...boardPayload(), card: card ? viewOf(card) : null }
      if (completionResult) {
        payload.completionResult = completionResult
        if (completionWarning) payload.completionWarning = completionWarning
      }
      sendJson(res, 200, payload)
      return true
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' })
    return true
  }

  const route = {
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      try {
        const handled = await handle(req, res)
        if (handled === false) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
        }
      } catch (error) {
        const status = Number(error?.status) || 500
        if (!cancelled(status)) console.error('[kanban-fx]', path2(req), error?.message ?? error)
        if (!res.headersSent) {
          sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
        } else {
          try {
            res.end()
          } catch {}
        }
      }
    },
  }

  function path2(req) {
    try {
      return new URL(req.url ?? PREFIX, 'http://127.0.0.1').pathname
    } catch {
      return PREFIX
    }
  }

  // webServer 可能比本插件晚激活：用 inject 等它上桌
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const server = webCtx.get('webServer')
      if (!server || typeof server.register !== 'function') {
        console.error('[kanban-fx] webServer 不可用，看板接口没有注册')
        return () => {}
      }
      try {
        return server.register(route)
      } catch (error) {
        console.error('[kanban-fx] 注册看板路由失败：', error?.message ?? error)
        return () => {}
      }
    })
  })

  // 启动后对齐一次状态，长挂时每 30 秒兜底一次
  ctx.effect(() => {
    const boot = setTimeout(reconcile, 3000)
    const timer = setInterval(reconcile, 30_000)
    return () => {
      clearTimeout(boot)
      clearInterval(timer)
      for (const client of sseClients) {
        stopBeat(client)
        try {
          client.end()
        } catch {}
      }
      sseClients.clear()
      if (saveTimer) clearTimeout(saveTimer)
      writeStore()
    }
  })

  ctx.effect(() => () => {
    for (const client of sseClients) {
      stopBeat(client)
      try {
        client.end()
      } catch {}
    }
    sseClients.clear()
  })

  console.log('[kanban-fx] 任务看板已启动，数据目录：', dataDir)
}
