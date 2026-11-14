/**
 * 任务看板 · Host 半。
 *
 * 职责：
 * - 持久化卡片（待办 / 进行中 / 待审核 / 已完成），数据落在 $DSH_HOME/dsh-kanban-fx/board.json
 * - 通过 ctx.webServer 暴露看板 HTTP 接口给 Client 半
 * - 「执行」：建（或复用）会话 → 把卡片正文与附件作为一条 user 消息投进去 → 立刻开跑
 * - 状态机：由会话本身的事件推导（turn/start → 进行中，turn/end → 待审核），
 *   只有「已完成」是用户手点的标记；用户在会话里再发消息会自动回到进行中
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
const STORE_VERSION = 1
const SSE_MAX_CLIENTS = 8
const SSE_HEARTBEAT_MS = 25_000
const BODY_LIMIT_BYTES = 40 * 1024 * 1024

const DEFAULTS = {
  dataDir: '',
  maxBodyChars: 200000,
  maxCardAttachmentBytes: 24 * 1024 * 1024,
}

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

/** 卡片标题：显式标题 → 正文首行 → 附件占位。 */
function deriveTitle(title, body) {
  const given = textOf(title, 80).trim()
  if (given) return given
  const firstLine = textOf(body, 4000)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstLine) return firstLine.slice(0, 42)
  return '未命名事项'
}

function statusOf(card) {
  if (card.runningSince) return STATUS.RUNNING
  if (!card.sessionId) return STATUS.TODO
  if (card.doneAt) return STATUS.DONE
  return STATUS.REVIEW
}

function normalizeSettings(config) {
  const input = config && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULTS }
  if (typeof input.dataDir === 'string' && input.dataDir.trim()) settings.dataDir = input.dataDir.trim()
  if (Number.isFinite(input.maxBodyChars) && input.maxBodyChars > 0) settings.maxBodyChars = Math.floor(input.maxBodyChars)
  if (Number.isFinite(input.maxCardAttachmentBytes) && input.maxCardAttachmentBytes > 0) {
    settings.maxCardAttachmentBytes = Math.floor(input.maxCardAttachmentBytes)
  }
  return settings
}

/** 一张卡片对外（Client）的形状：不含附件字节。 */
function viewOf(card) {
  return {
    id: card.id,
    seq: Number.isInteger(card.seq) && card.seq > 0 ? card.seq : null,
    title: card.title,
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
  return { version: STORE_VERSION, rev: 1, nextSeq: 1, lastWorkspaceId: null, cards: {} }
}

function loadStore(file) {
  if (!existsSync(file)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.cards || typeof parsed.cards !== 'object') return emptyStore()
    const cards = {}
    for (const [id, card] of Object.entries(parsed.cards)) {
      if (!card || typeof card !== 'object') continue
      cards[id] = {
        id,
        seq: null,
        title: textOf(card.title, 120) || '未命名事项',
        body: typeof card.body === 'string' ? card.body : '',
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
      version: Number(parsed.version) || STORE_VERSION,
      rev: Number(parsed.rev) || 1,
      nextSeq: Number.isInteger(storedNext) && storedNext > highest + 1 ? storedNext : highest + 1,
      lastWorkspaceId: typeof parsed.lastWorkspaceId === 'string' ? parsed.lastWorkspaceId : null,
      cards,
    }
  } catch (error) {
    console.error('[kanban-fx] 读取看板数据失败，改用空看板：', error?.message ?? error)
    return emptyStore()
  }
}

export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const dataDir = settings.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-kanban-fx')
  const storeFile = join(dataDir, 'board.json')
  const store = loadStore(storeFile)

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
      if (total > settings.maxCardAttachmentBytes) {
        throw httpError(413, `附件总大小超过上限（${Math.round(settings.maxCardAttachmentBytes / 1024 / 1024)} MB）`)
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

  /** 卡片正文 + 附件 → DSH 原生内容块（与新会话输入框产出的类型一致）。 */
  async function contentOf(card) {
    const parts = []
    const text = (card.body || '').trim()
    if (text) parts.push({ type: 'text', text })
    else if ((card.title || '').trim()) parts.push({ type: 'text', text: card.title.trim() })
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
      titles.rename(session, card.title)
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
      title: deriveTitle(input?.title, input?.body),
      body: textOf(input?.body, settings.maxBodyChars),
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
    card.title = deriveTitle(input?.title, input?.body)
    card.body = textOf(input?.body, settings.maxBodyChars)
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

  /** 用户手点「已完成」；只有待审核的卡片能点。 */
  function markDone(input) {
    const card = cardOf(input)
    if (statusOf(card) !== STATUS.REVIEW) throw httpError(409, '只有待审核的卡片可以标记完成')
    card.doneAt = Date.now()
    touch(card, 'done')
    return card
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
      if (!card.runningSince && card.lastRunEndedAt) return
      card.runningSince = null
      card.lastRunEndedAt = event.time
      card.lastRunMs = card.lastRunStartedAt ? Math.max(0, event.time - card.lastRunStartedAt) : null
      const reason = event.data && event.data.reason
      if (reason && reason.kind === 'error') {
        card.error = reason.error?.message || '运行失败'
      } else if (reason && reason.kind === 'aborted') {
        card.error = null
      }
      touch(card, 'turn-end')
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

    if (req.method === 'POST' && path === `${PREFIX}/card`) {
      const body = await readJson(req)
      const action = typeof body.action === 'string' ? body.action : ''
      let card = null
      if (action === 'create') card = await createCard(body.card, Boolean(body.run))
      // id 既接受 card.id（现在的客户端），也接受顶层 id（旧客户端 / 手工调用）
      else if (action === 'update') card = await updateCard({ ...(body.card || {}), id: body.id ?? body.card?.id })
      else if (action === 'delete') card = removeCard(body)
      else if (action === 'run') card = await runCard(cardOf(body))
      else if (action === 'done') card = markDone(body)
      else if (action === 'undone') card = markUndone(body)
      else throw httpError(400, `未知操作：${action || '(空)'}`)
      if (card) saveNow()
      sendJson(res, 200, { ...boardPayload(), card: card ? viewOf(card) : null })
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
