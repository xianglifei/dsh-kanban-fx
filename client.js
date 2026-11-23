/**
 * 任务看板 · Client 半。
 *
 * 侧边栏入口 + 主面板：四列看板（待办 / 进行中 / 待审核 / 已完成），以及顶栏齿轮里的设置页。
 * 数据全部来自 Host 半的 /kanban-fx 接口；这里只负责渲染、计时和交互。
 */
window.__ModuleLoader__.load({
  id: 'dsh-kanban-fx',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    let pluginCtx = null

    const API = '/kanban-fx'
    // 兜底值：真实上限以 Host 随 /board 下发的 advanced.limits 为准（Editor 里优先用它）
    const MAX_CARD_BYTES = 24 * 1024 * 1024
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    // 自动保存：停手 1.2 秒先存一次，连续打字时再每 8 秒兜底存一次
    const AUTOSAVE_IDLE_MS = 1200
    // 会话标题栏的卡片状态没有推送通道：这一轮在跑时每 4 秒问一次 Host，
    // 问句一出现就换「等你回答」，回答之后也能及时回到「进行中」。
    const HEADER_CARD_POLL_MS = 4000
    const AUTOSAVE_INTERVAL_MS = 8000
    // 设置页：收尾提示词上限跟 Host 保持一致；停手 600ms 自动保存
    const PROMPT_MAX_CHARS = 4000
    const SETTINGS_SAVE_IDLE_MS = 600
    // 看板默认停在「某个工作区」，也可以停在「全部工作区」。视图工作区记在浏览器本地：
    // 优先级 localStorage → defaultWorkspaceId（= 校验过的 lastWorkspaceId）→ 工作区列表第一个。
    const VIEW_WORKSPACE_KEY = 'dsh-kanban-fx.view-workspace'
    // 「全部工作区」不是真实工作区，只是浏览器本地的一个视图值：只有存在两个以上工作区时才给这个
    // 选项（只有一个时它和那个工作区完全等价），不写进服务端的 lastWorkspaceId。
    const BUCKET_ALL = 'all'
    // 不属于任何现存工作区的卡片（历史数据 / 工作区被删）用这两个抽屉兜住，平时不出现
    const BUCKET_NONE = 'none'
    const BUCKET_MISSING = 'missing'

    function readViewWorkspace() {
      try {
        return String(window.localStorage.getItem(VIEW_WORKSPACE_KEY) || '')
      } catch {
        return ''
      }
    }

    function persistViewWorkspace(workspaceId) {
      try {
        window.localStorage.setItem(VIEW_WORKSPACE_KEY, workspaceId)
      } catch {}
    }

    // 看板已经挂在这一页上时，selectPanel('kanban-fx') 是幂等的：面板不会重挂，
    // 只写 localStorage 读不到。工作区「…」菜单和会话页「完成」都从这里切工作区，
    // 由面板自己订阅，两种状态（刚挂载 / 已经在看板上）都能落到同一个筛选值。
    const viewWorkspaceListeners = new Set()

    function requestViewWorkspace(workspaceId) {
      if (!workspaceId) return
      persistViewWorkspace(workspaceId)
      for (const listener of [...viewWorkspaceListeners]) {
        try {
          listener(workspaceId)
        } catch (failure) {
          console.error('[kanban-fx] 通知看板切换工作区失败：', failure)
        }
      }
    }

    /** 打开看板并停在指定工作区；工作区「…」菜单与会话页「✓ 完成」共用。 */
    function openBoardPanel(workspaceId) {
      const layout = pluginCtx?.get('layout')
      if (!layout || typeof layout.selectPanel !== 'function') {
        throw new Error(t('当前 DSH 版本无法打开任务看板', 'This DSH version cannot open the task board'))
      }
      requestViewWorkspace(workspaceId)
      layout.selectPanel('kanban-fx')
    }

    // 视图（看板 / 列表）和列表排序也只写浏览器本地；默认看板，不打断现有用户。
    const VIEW_MODE_KEY = 'dsh-kanban-fx.view'
    const SORT_STATE_KEY = 'dsh-kanban-fx.sort'
    const VIEW_MODES = ['board', 'list']

    // 列表的列。key 同时是排序键；actions 只是占位，不参与排序。
    const LIST_COLUMNS = [
      { key: 'status', zh: '状态', en: 'Status', cls: 'c-status', dir: 'asc', sortable: true },
      { key: 'seq', zh: '编号', en: 'No.', cls: 'c-seq', dir: 'asc', sortable: true },
      { key: 'title', zh: '任务', en: 'Task', cls: 'c-task', dir: 'asc', sortable: true },
      { key: 'duration', zh: '用时', en: 'Duration', cls: 'c-dur', dir: 'desc', sortable: true, align: 'right' },
      { key: 'updated', zh: '更新', en: 'Updated', cls: 'c-upd', dir: 'desc', sortable: true, align: 'right' },
      { key: 'actions', zh: '操作', en: 'Actions', cls: 'c-acts', sortable: false, align: 'right' },
    ]
    const STATUS_RANK = { todo: 0, running: 1, review: 2, done: 3 }
    // 用户定的默认：按第一列状态、流程顺序，待办在最上面。
    const DEFAULT_SORT = { key: 'status', dir: 'asc' }

    function readViewMode() {
      try {
        const value = String(window.localStorage.getItem(VIEW_MODE_KEY) || '')
        return VIEW_MODES.includes(value) ? value : 'board'
      } catch {
        return 'board'
      }
    }

    function persistViewMode(mode) {
      try {
        window.localStorage.setItem(VIEW_MODE_KEY, mode)
      } catch {}
    }

    function readSortState() {
      try {
        const [key, dir] = String(window.localStorage.getItem(SORT_STATE_KEY) || '').split(':')
        const column = LIST_COLUMNS.find((item) => item.key === key && item.sortable)
        if (column && (dir === 'asc' || dir === 'desc')) return { key, dir }
      } catch {}
      return { ...DEFAULT_SORT }
    }

    function persistSortState(sort) {
      try {
        window.localStorage.setItem(SORT_STATE_KEY, `${sort.key}:${sort.dir}`)
      } catch {}
    }

    const COLUMNS = [
      {
        id: 'todo',
        zh: '待办',
        en: 'To do',
        hintZh: '还没有待办。点下面的「+ 新建待办」，先把想法和附件都存进来。',
        hintEn: 'No cards yet. Use “+ New card” below to park ideas and files here.',
      },
      {
        id: 'running',
        zh: '进行中',
        en: 'Running',
        hintZh: '在执行中的卡片会出现在这里，右上角显示本轮已经跑了多久。助手暂停等你回话时，卡片会亮起「等你回答」并排到最前。',
        hintEn: 'Cards that are running show up here with a live timer. When the agent waits for your answer, the card shows “waiting” and moves to the top.',
      },
      {
        id: 'review',
        zh: '待审核',
        en: 'Review',
        hintZh: '跑完的卡片会落到这里。点开进会话看结果，看板上或会话标题栏都能点「完成」。',
        hintEn: 'Finished runs land here. Open the conversation to review, then mark done from the card or the session header.',
      },
      {
        id: 'done',
        zh: '已完成',
        en: 'Done',
        hintZh: '你亲手点过完成的卡片，默认折成一行标题；点标题展开详情。之后在会话里继续聊，它会自动回到进行中。',
        hintEn: 'Cards you marked done, folded to a title line by default. Click a title to expand. Continuing the conversation moves them back.',
      },
    ]

    // 上次读到的答案只在 locale 服务读不出来时兜底用：语言运行中被切换要能跟着换，
    // 不能起步时缓存一次就定死（getSnapshot 是快照读，每次调用开销很小）
    let zhFallback = true
    function isZh() {
      try {
        const snapshot = pluginCtx?.get('locale')?.getSnapshot?.()
        const value = String(snapshot?.locale ?? snapshot?.id ?? snapshot?.current ?? 'zh')
        zhFallback = value.toLowerCase().startsWith('zh')
        return zhFallback
      } catch {
        return zhFallback
      }
    }
    const t = (cn, en) => (isZh() ? cn : en)

    /** 状态 → 看板列的中文 / 英文名；列表和看板共用一套叫法。 */
    function statusLabelOf(status) {
      const column = COLUMNS.find((item) => item.id === status)
      return column ? t(column.zh, column.en) : String(status || '')
    }

    /**
     * 视图停在哪个工作区：本地上次的选择 → 服务端默认（校验过的 lastWorkspaceId）
     * → 「未指定工作区」抽屉 → 「工作区不可用」抽屉。
     * 「全部工作区」只在有两个以上工作区时才算合法落点（只有一个时它和那个工作区等价，
     * 多一个状态只是噪音）；工作区被删到只剩一个时，这里会自动把它收掉。
     * 抽成纯函数是为了能单独验：这是全看板最容易「静默挑错工作区」的一段。
     */
    function resolveViewWorkspace({ picked, workspaceIds, fallbackId, hasOrphan, hasMissing }) {
      const selectable = (id) =>
        Boolean(id) &&
        (workspaceIds.includes(id) ||
          (id === BUCKET_ALL && workspaceIds.length >= 2) ||
          (id === BUCKET_NONE && hasOrphan) ||
          (id === BUCKET_MISSING && hasMissing))
      if (selectable(picked)) return picked
      if (fallbackId) return fallbackId
      if (hasOrphan) return BUCKET_NONE
      if (hasMissing) return BUCKET_MISSING
      return null
    }

    /**
     * 当前视图里该显示哪些卡。
     * 「全部工作区」只收归属明确、工作区还在的卡：孤儿 / 工作区已被删的卡留在各自的抽屉里，
     * 那些是「要修的数据」，混进全局视图只会稀释信号。
     */
    function filterVisibleCards({ cards, workspaceId, workspaceIds }) {
      return cards.filter((card) => {
        if (workspaceId === BUCKET_ALL) return Boolean(card.workspaceId) && workspaceIds.includes(card.workspaceId)
        if (workspaceId === BUCKET_NONE) return !card.workspaceId
        if (workspaceId === BUCKET_MISSING) return Boolean(card.workspaceId) && !workspaceIds.includes(card.workspaceId)
        if (!workspaceId) return true
        return card.workspaceId === workspaceId
      })
    }

    /**
     * 关侧栏时该做什么。单独抽出来是因为这里最容易出「手滑丢内容」：
     * blocked = 在「全部工作区」里新建、还没选工作区——这张卡从来没落过库，关掉就等于丢掉输入。
     * 返回：'warn' 只提示不关 / 'arm' 点亮 ✕ 的二次确认 / 'close' 直接关 / 'flush' 先补存再关。
     */
    function closeIntentOf({ blocked, hasContent, dirty, source, discardArmed }) {
      if (blocked && hasContent) {
        // Esc / 点背景永远不关：连按两下不该被当成「确认放弃」
        if (source !== 'x') return 'warn'
        return discardArmed ? 'close' : 'arm'
      }
      return dirty && hasContent ? 'flush' : 'close'
    }

    // ------------------------------------------- session header (card status)
    // 会话 → 卡片的探测结果：命中先画、再后台刷新，切回会话时标题栏不会闪一下空。
    // 只留最近 HEADER_CACHE_MAX 条：webview 长挂时无上限的缓存会一直涨。
    const HEADER_CACHE_MAX = 50
    const headerCardCache = new Map()

    /** 记一条探测结果（null 也是有效结论：这个会话不是看板卡片）；超出上限时丢最旧的。 */
    function rememberHeaderCard(sessionId, card) {
      headerCardCache.delete(sessionId)
      headerCardCache.set(sessionId, card)
      if (headerCardCache.size > HEADER_CACHE_MAX) {
        headerCardCache.delete(headerCardCache.keys().next().value)
      }
    }
    // 从会话标题栏点「完成」跳回看板时，交接给看板面板的一条提示。
    // outcome: done（带撤销）/ finishing（提示词已发出，没有可撤销的）/ fallback-done（会话不可用但已完成）
    let pendingBoardNotice = null

    /** 一个 POST /kanban-fx/card 的薄封装：解析、校验、抛错，不碰看板状态。 */
    async function postCardAction(action, payload) {
      const response = await fetch(`${API}/card`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload || {}) }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body || body.ok !== true) {
        const failure = new Error((body && body.error) || t(`操作失败（${response.status}）`, `Action failed (${response.status})`))
        failure.status = response.status
        throw failure
      }
      return body
    }

    /** 问 Host：这个会话对应哪张卡片；不是看板卡片就返回 null。 */
    async function fetchSessionCard(sessionId) {
      const response = await fetch(`${API}/card?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      const body = await response.json().catch(() => null)
      if (!response.ok || !body || body.ok !== true) {
        throw new Error((body && body.error) || t(`状态读取失败（${response.status}）`, `Could not read the card (${response.status})`))
      }
      // mergeState 是设置开关：关了就不该在标题栏里拿旧结论弹提醒
      return { card: body.card || null, mergeState: body.mergeState !== false }
    }

    // ---------------------------------------------------------------- styles
    const CSS = `
.fxk-root {
  --fxk-bg: var(--dsw-alias-bg-base, #ffffff);
  --fxk-canvas: var(--dsw-alias-bg-base, #ffffff);
  --fxk-surface: var(--dsw-alias-bg-layer-1, #fbfbfc);
  --fxk-card: var(--dsw-alias-bg-layer-2, #ffffff);
  --fxk-border: var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
  --fxk-border-soft: var(--dsw-alias-border-l1, rgba(0, 0, 0, .05));
  --fxk-text: var(--dsw-alias-label-primary, #0f1115);
  --fxk-text-2: var(--dsw-alias-label-secondary, #61666b);
  --fxk-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --fxk-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
  --fxk-active: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, .1));
  --fxk-brand: var(--dsw-alias-brand-primary, #0f1115);
  /* 主按钮（▶ 立即执行）的填充与文字：不跟 brand-primary 走。
     brand-primary 在部分主题 / 深色模式下会和底色撞在一起（黑底黑字），
     而 label-primary 与 bg-base 这对「墨 / 纸」在浅色、深色下必然互为反色。 */
  --fxk-cta: var(--dsw-alias-label-primary, #0f1115);
  --fxk-cta-ink: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base, #ffffff));
  --fxk-cta-hover: color-mix(in srgb, var(--fxk-cta) 82%, var(--fxk-cta-ink));
  --fxk-link: var(--dsw-alias-link, #4176e6);
  --fxk-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --fxk-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --fxk-err: var(--dsw-alias-state-error-primary, #ec1313);
  --fxk-idle: var(--dsw-alias-state-idle-primary, #8b9096);
  --fxk-ok-ink: color-mix(in srgb, var(--fxk-ok) 60%, var(--fxk-text));
  --fxk-brand-ink: color-mix(in srgb, var(--fxk-brand) 82%, var(--fxk-text));
  --fxk-dot: color-mix(in srgb, var(--fxk-text) 14%, transparent);
  --fxk-shadow:
    0 1px 2px rgba(15, 23, 42, .05),
    0 12px 26px -14px rgba(15, 23, 42, .18),
    0 30px 60px -30px rgba(15, 23, 42, .22),
    inset 0 1px 0 rgba(255, 255, 255, .38);
  --fxk-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace);
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background-color: var(--fxk-canvas);
  background-image: radial-gradient(circle, var(--fxk-dot) 1px, transparent 1.15px);
  background-size: 22px 22px;
  background-position: 11px 11px;
  color: var(--fxk-text);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 20px;
  container-type: inline-size;
}
.fxk-root *, .fxk-root *::before, .fxk-root *::after { box-sizing: border-box; }
.fxk-root button { font: inherit; }
.fxk-root :focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 2px; }

/* ---------------------------------------------------------------- header */
.fxk-head {
  flex: none;
  width: 100%;
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 62px;
  padding: 10px 20px 8px;
}
.fxk-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.fxk-brand-mark {
  width: 28px; height: 28px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--fxk-brand) 10%, transparent);
  color: var(--fxk-brand-ink);
}
.fxk-brand-title { font-size: 15px; line-height: 22px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fxk-head-spacer { flex: 1; min-width: 4px; }
/* 右上角是「看板的工作区」切换器，不是筛选器：给个显式标签，免得和侧边栏混淆 */
.fxk-filter { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
/* 比下拉里的字大半级（12.5 vs 12）+ 字重 560 + 二级色：11.5px 的三级灰贴着 30px 高的下拉，
   会被读成一条注脚而不是字段名。 */
.fxk-filter-label { font-size: 12.5px; line-height: 20px; font-weight: 560; color: var(--fxk-text-2); white-space: nowrap; }
/* 侧栏里的撑杆不复用 header 的，因为窄屏会隐藏 header 的那一个 */
.fxk-sheet-spacer { flex: 1; min-width: 4px; }
.fxk-select {
  appearance: none; -webkit-appearance: none;
  height: 30px; padding: 0 26px 0 10px;
  border: 1px solid var(--fxk-border); border-radius: 8px;
  background: var(--fxk-surface) no-repeat right 8px center;
  background-image: linear-gradient(45deg, transparent 50%, var(--fxk-text-3) 50%), linear-gradient(135deg, var(--fxk-text-3) 50%, transparent 50%);
  background-size: 5px 5px, 5px 5px;
  background-position: calc(100% - 12px) 13px, calc(100% - 8px) 13px;
  color: var(--fxk-text); font-size: 12px;
  max-width: 200px; text-overflow: ellipsis;
}
.fxk-select:hover { border-color: color-mix(in srgb, var(--fxk-border) 60%, var(--fxk-text-3)); }
.fxk-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px;
  border: 1px solid var(--fxk-border); border-radius: 8px;
  background: var(--fxk-surface); color: var(--fxk-text);
  font-size: 12px; line-height: 1; cursor: pointer;
  transition: background 140ms, border-color 140ms, color 140ms;
  white-space: nowrap;
}
.fxk-btn:hover { background: var(--fxk-hover); }
.fxk-btn:active { background: var(--fxk-active); }
.fxk-btn[disabled] { opacity: .5; cursor: default; }
.fxk-btn-primary { background: var(--fxk-cta); border-color: var(--fxk-cta); color: var(--fxk-cta-ink); font-weight: 560; }
.fxk-btn-primary:hover { background: var(--fxk-cta-hover); border-color: var(--fxk-cta-hover); color: var(--fxk-cta-ink); }
.fxk-btn-primary:active { background: color-mix(in srgb, var(--fxk-cta) 72%, var(--fxk-cta-ink)); }
/* 点完成时的确认：比编辑抽屉轻，居中一张小卡 */
.fxk-overlay[data-align="center"] { align-items: center; justify-content: center; padding: 24px; }
.fxk-confirm {
  position: relative;
  width: min(440px, 100%);
  display: flex; flex-direction: column; gap: 10px;
  padding: 18px;
  border: 1px solid var(--fxk-border); border-radius: 14px;
  background: var(--fxk-card); box-shadow: var(--fxk-shadow);
  animation: fxk-pop 140ms ease-out;
}
/* 取消不是第三个决定，只是关掉：做成右上角那颗 ✕（点外面 / Esc 也一样） */
.fxk-confirm-close {
  position: absolute; top: 10px; right: 10px;
  width: 22px; height: 22px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: transparent;
  color: var(--fxk-text-3); font-size: 13px; line-height: 1; cursor: pointer;
}
.fxk-confirm-close:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-confirm-close:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 1px; }
@keyframes fxk-pop { from { transform: translateY(6px); opacity: .7; } to { transform: none; opacity: 1; } }
.fxk-confirm-title { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--fxk-text); }
.fxk-confirm-text { font-size: 12.5px; line-height: 20px; color: var(--fxk-text-2); }
.fxk-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.fxk-btn[data-tone="warn"] {
  border-color: color-mix(in srgb, var(--fxk-warn) 40%, var(--fxk-border));
  color: color-mix(in srgb, var(--fxk-warn) 45%, var(--fxk-text));
}
.fxk-btn[data-tone="warn"]:hover { background: color-mix(in srgb, var(--fxk-warn) 12%, transparent); }
.fxk-btn-danger { color: var(--fxk-err); }
.fxk-btn-danger:hover { background: color-mix(in srgb, var(--fxk-err) 10%, transparent); }
.fxk-btn-icon { width: 30px; padding: 0; }

/* 视图切换：紧跟着页面标题，属于「这页是什么」，不和右侧的工作区 / 新建混在一组。
   两段轻标签：没有轨道 / 白卡 / 阴影，当前项只靠 7% 软填充 + 600 字重；
   非当前项用二级灰而不是三级灰，12px 下保住可读性。
   窄到 360px 以下只剩图标（aria-label 仍在）。 */
.fxk-viewswitch {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  height: 28px; margin-left: 8px; padding: 0;
}
.fxk-viewswitch button {
  height: 26px; padding: 0 8px; border: 0; border-radius: 6px;
  background: transparent; color: var(--fxk-text-2);
  font-size: 12px; line-height: 1; font-weight: 500;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
  cursor: pointer;
  transition: color 120ms, background 120ms;
}
.fxk-viewswitch button:hover:not([data-active="true"]) {
  color: var(--fxk-text);
  background: color-mix(in srgb, var(--fxk-text) 4%, var(--fxk-canvas));
}
.fxk-viewswitch button[data-active="true"] {
  background: color-mix(in srgb, var(--fxk-text) 7%, var(--fxk-canvas));
  color: var(--fxk-text); font-weight: 600;
}
.fxk-viewswitch button:focus-visible { outline-offset: 1px; }
.fxk-viewswitch svg {
  display: block; width: 13px; height: 13px;
  opacity: .7; transition: opacity 120ms;
}
.fxk-viewswitch button[data-active="true"] svg { opacity: 1; }
.fxk-viewswitch-label { display: inline-block; }

/* ----------------------------------------------------------------- board */
.fxk-board {
  flex: 1; min-height: 0;
  width: 100%; max-width: 1400px; margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 22px;
  padding: 0 20px 20px;
}
.fxk-col {
  display: flex; flex-direction: column; min-height: 0;
  background: var(--fxk-surface);
  border: 1px solid var(--fxk-border);
  border-radius: 14px;
  box-shadow: var(--fxk-shadow);
  overflow: hidden;
}
.fxk-col-head {
  flex: none;
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--fxk-border-soft);
  /* 列被挤窄时只留「数字变琥珀」，文案收起（卡片自己会写明「等你回答」） */
  container-type: inline-size;
}
.fxk-col-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--fxk-idle); flex: none; }
.fxk-col[data-state="todo"] .fxk-col-dot { background: var(--fxk-idle); }
.fxk-col[data-state="running"] .fxk-col-dot { background: var(--fxk-brand); }
.fxk-col[data-state="review"] .fxk-col-dot { background: var(--fxk-warn); }
.fxk-col[data-state="done"] .fxk-col-dot { background: var(--fxk-ok); }
.fxk-col-name { font-size: 13px; line-height: 19px; font-weight: 560; color: var(--fxk-text); }
.fxk-col-count {
  margin-left: auto; min-width: 20px; height: 20px; padding: 0 6px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 999px; background: var(--fxk-hover); color: var(--fxk-text-2);
  font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums;
}
/* 有卡片在等你回答：计数本身变成琥珀色的提示 */
.fxk-col-count.is-await {
  background: color-mix(in srgb, var(--fxk-warn) 16%, transparent);
  color: color-mix(in srgb, var(--fxk-warn) 42%, var(--fxk-text));
  font-weight: 600;
}
.fxk-col-await {
  height: 20px; padding: 0 7px; border-radius: 999px;
  display: inline-flex; align-items: center;
  background: color-mix(in srgb, var(--fxk-warn) 14%, transparent);
  color: color-mix(in srgb, var(--fxk-warn) 42%, var(--fxk-text));
  font-size: 11px; line-height: 1; font-weight: 560; white-space: nowrap;
}
@container (max-width: 210px) {
  .fxk-col-await { display: none; }
}
/* 已完成列头：还有几张卡的分支没合并。和「1 张等你回答」同一套做法 */
.fxk-col-merge {
  margin-left: auto; height: 20px; padding: 0 7px; border-radius: 999px;
  display: inline-flex; align-items: center;
  background: color-mix(in srgb, var(--fxk-warn) 14%, transparent);
  color: color-mix(in srgb, var(--fxk-warn) 42%, var(--fxk-text));
  font-size: 11px; line-height: 1; font-weight: 560; white-space: nowrap;
}
.fxk-col-merge + .fxk-col-count { margin-left: 6px; }
@container (max-width: 150px) {
  .fxk-col-merge { display: none; }
  .fxk-col-merge + .fxk-col-count { margin-left: auto; }
}
.fxk-col-body {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px 10px 12px;
}
.fxk-col-body::-webkit-scrollbar { width: 8px; }
.fxk-col-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fxk-text) 16%, transparent); border-radius: 8px; }
/* 待办列尾的整行入口 */
.fxk-col-new {
  flex: none;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 34px; padding: 0 10px;
  border: 1px dashed var(--fxk-border); border-radius: 10px;
  background: transparent; color: var(--fxk-text-2);
  font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.fxk-col-new:hover { border-color: color-mix(in srgb, var(--fxk-text-3) 55%, var(--fxk-border)); background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-empty {
  margin: 6px 4px;
  padding: 14px 12px;
  border: 1px dashed var(--fxk-border);
  border-radius: 12px;
  color: var(--fxk-text-2);
  font-size: 12px; line-height: 19px;
}

/* ------------------------------------------------------------------ card */
.fxk-card {
  position: relative;
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 11px 11px;
  border: 1px solid var(--fxk-border);
  border-radius: 12px;
  background: var(--fxk-card);
  cursor: pointer;
  text-align: left;
  transition: border-color 140ms, transform 140ms, box-shadow 140ms;
}
.fxk-card:hover { border-color: color-mix(in srgb, var(--fxk-border) 45%, var(--fxk-text-3)); transform: translateY(-1px); }
.fxk-card:active { transform: translateY(0); }
.fxk-card[data-state="done"] { opacity: .82; }
/* 已完成列的折叠态：只留一行标题，点开才展开成完整卡片 */
.fxk-card-folded {
  flex-direction: row; align-items: center; gap: 9px;
  min-height: 32px; padding: 6px 10px;
  /* 折叠行自己是容器：挤窄时先收状态词、再收整枚结论 */
  container-type: inline-size;
}
.fxk-card-folded[data-state="done"]:hover { opacity: .96; }
.fxk-card-title-folded {
  display: block; flex: 1 1 auto; min-width: 0;
  font-size: 12.5px; line-height: 17px; font-weight: 520;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  -webkit-line-clamp: unset; word-break: normal;
}
.fxk-caret {
  flex: none; width: 6px; height: 6px;
  border-right: 1.5px solid var(--fxk-text-3);
  border-bottom: 1.5px solid var(--fxk-text-3);
  transform: rotate(-45deg);
  transition: transform 140ms ease, border-color 120ms ease;
}
.fxk-caret-open { transform: rotate(45deg); }
.fxk-card-folded:hover .fxk-caret { border-color: var(--fxk-text-2); }
/* 折叠行挤窄时：先只留图标，再整枚收起（和列头那句「N 张等你回答」同样的取舍） */
@container (max-width: 140px) {
  .fxk-wt-folded .fxk-wt-folded-text { display: none; }
}
@container (max-width: 105px) {
  .fxk-wt-folded { display: none; }
}
/* 展开态的折叠控件：标题行右侧的小箭头 */
.fxk-card-title-row { display: flex; align-items: flex-start; gap: 6px; }
.fxk-card-title-row .fxk-card-title { flex: 1 1 auto; min-width: 0; }
.fxk-card-collapse {
  flex: none; width: 20px; height: 20px; margin: -2px -3px 0 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 6px; background: transparent;
  color: var(--fxk-text-3); cursor: pointer;
}
.fxk-card-collapse:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-card-title {
  font-size: 13.5px; line-height: 19px; font-weight: 560; color: var(--fxk-text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  word-break: break-word;
}
.fxk-card-excerpt {
  font-size: 12px; line-height: 18px; color: var(--fxk-text-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  white-space: pre-wrap; word-break: break-word;
}
/* 这一行始终占住一枚 chip 的高度（18px），哪怕一个 chip 都没有：
   卡片高度因此不随 chip 增减变化，切到「全部工作区」多出工作区胶囊时也不会跳。 */
.fxk-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 18px; font-size: 11px; line-height: 16px; color: var(--fxk-text-2); }
.fxk-chip {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 150px; height: 18px; padding: 0 6px;
  border-radius: 6px; background: var(--fxk-hover); color: var(--fxk-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fxk-chip-warn { background: color-mix(in srgb, var(--fxk-warn) 14%, transparent); color: color-mix(in srgb, var(--fxk-warn) 40%, var(--fxk-text)); }
.fxk-chip-err { background: color-mix(in srgb, var(--fxk-err) 12%, transparent); color: color-mix(in srgb, var(--fxk-err) 55%, var(--fxk-text)); }
.fxk-chip-branch { background: color-mix(in srgb, var(--fxk-brand) 10%, transparent); color: color-mix(in srgb, var(--fxk-brand) 55%, var(--fxk-text)); font-family: var(--fxk-mono); }
/* 分支 chip 的结构：图标 + 分支名（可收缩）+ 合并状态（不收缩）。
   合并状态只陈述 Git 事实，不参与卡片状态机；分支删了给名字加删除线。 */
.fxk-chip-branch { gap: 4px; }
/* 工作区 chip：只在「全部工作区」里出现，而且本身就是按钮（点一下只看这个工作区）。
   外观沿用普通 chip，只补按钮的默认边框和 hover——它不该比旁边的分支 chip 更抢眼。 */
.fxk-chip-ws { border: 0; cursor: pointer; }
.fxk-chip-ws:hover { background: color-mix(in srgb, var(--fxk-text-3) 16%, transparent); color: var(--fxk-text); }
/* 卡片编号 chip：它是卡片的身份，不是状态——所以等宽小字、默认无底色，安静地排在这行最前面。
   本身就是按钮，点一下复制，方便在会话里直接说「处理 fx-12」。 */
.fxk-chip-seq {
  flex: none; max-width: none; padding: 0 5px;
  border: 0; background: transparent; color: var(--fxk-text-3);
  font-family: var(--fxk-mono); font-size: 10.5px; line-height: 16px;
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
  cursor: copy;
}
.fxk-chip-seq:hover { background: var(--fxk-hover); color: var(--fxk-text-2); }
.fxk-chip-seq:focus-visible { outline: 1.5px solid color-mix(in srgb, var(--fxk-link) 60%, transparent); outline-offset: 1px; }
/* 已完成折叠行里的编号：只有一行，编号排在标题前、不抢宽度 */
.fxk-folded-seq {
  flex: none; font-family: var(--fxk-mono); font-size: 10px; line-height: 16px;
  font-variant-numeric: tabular-nums; letter-spacing: .02em; color: var(--fxk-text-3);
}
/* 已完成折叠行里的那一枚：行很窄，先收名字、再整枚收起（和右侧合并结论同一套取舍） */
.fxk-ws-folded { flex: none; max-width: 96px; }
@container (max-width: 220px) {
  .fxk-ws-folded { display: none; }
}
.fxk-chip-branch > svg { flex: none; display: block; }
.fxk-wt-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fxk-wt-name.is-gone { text-decoration: line-through; opacity: .72; }
.fxk-chip-merge { max-width: 210px; }
.fxk-chip-merge .fxk-wt-state { flex: none; }
/* chip 里的「复制命令」小按钮：只改光标，不抢 chip 的观感 */
.fxk-wt-copy {
  flex: none; width: 14px; height: 14px; margin: 0 -2px 0 0; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 4px; background: transparent; color: inherit;
  opacity: .6; cursor: pointer;
}
.fxk-wt-copy:hover { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }
.fxk-wt-copy:focus-visible { opacity: 1; outline: 1.5px solid currentColor; outline-offset: 1px; }
/* 已完成折叠行右侧的结论：只留状态词，详情在 tooltip 和展开后的 chip 里 */
.fxk-wt-folded {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  height: 18px; padding: 0 6px; border-radius: 6px;
  font-size: 11px; line-height: 1; white-space: nowrap;
  font-family: var(--fxk-mono);
  background: var(--fxk-hover); color: var(--fxk-text-2);
}
.fxk-wt-folded > svg { flex: none; display: block; }
/* 同一套 tone：展开的 chip 和折叠行的结论共用 */
.fxk-chip-merge[data-merge="unmerged"],
.fxk-chip-merge[data-merge="uncommitted"],
.fxk-wt-folded[data-merge="unmerged"],
.fxk-wt-folded[data-merge="uncommitted"] {
  background: color-mix(in srgb, var(--fxk-warn) 14%, transparent);
  color: color-mix(in srgb, var(--fxk-warn) 42%, var(--fxk-text));
}
.fxk-chip-merge[data-merge="lost"],
.fxk-wt-folded[data-merge="lost"] {
  background: color-mix(in srgb, var(--fxk-err) 12%, transparent);
  color: color-mix(in srgb, var(--fxk-err) 55%, var(--fxk-text));
}
.fxk-chip-merge[data-merge="merged"],
.fxk-wt-folded[data-merge="merged"] {
  background: color-mix(in srgb, var(--fxk-ok) 13%, transparent);
  color: color-mix(in srgb, var(--fxk-ok) 40%, var(--fxk-text));
}
.fxk-chip-merge[data-merge="merged-gone"],
.fxk-chip-merge[data-merge="empty"],
.fxk-chip-merge[data-merge="empty-gone"],
.fxk-chip-merge[data-merge="unknown-gone"],
.fxk-wt-folded[data-merge="merged-gone"],
.fxk-wt-folded[data-merge="empty"],
.fxk-wt-folded[data-merge="empty-gone"],
.fxk-wt-folded[data-merge="unknown-gone"] { background: var(--fxk-hover); color: var(--fxk-text-3); }
/* 脚部自己是一层容器：列多窄就查多窄，收起 / 缩短只看这一行还剩多少位置，
   和整个面板的宽度无关（单列窄屏时列其实是整屏宽）。
   文字块一律不折行：提示、计时、按钮谁也不许被压成两行；一行放不下就整组换到下一行（按钮靠右），
   卡片高一点，总比「运行中」被压成竖排好看。 */
.fxk-card-foot { display: flex; align-items: center; gap: 8px; min-height: 24px; flex-wrap: wrap; container-type: inline-size; }
.fxk-card-foot > .fxk-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fxk-card-foot > .fxk-mini { flex: none; }
/* 不用占位 span（它自己换行时会多出一条空行）：靠右交给自动外边距 ——
   按钮组由第一个按钮顶到右边，只剩下「计时 + 开始于」时由最后那个提示顶到右边。 */
.fxk-card-foot > .fxk-mini:first-of-type { margin-left: auto; }
.fxk-card-foot > .fxk-hint:last-child { margin-left: auto; }
.fxk-mini {
  height: 24px; padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--fxk-border); background: transparent;
  font-size: 11.5px; line-height: 1; color: var(--fxk-text-2); cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  white-space: nowrap;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.fxk-mini:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-mini-ok { color: var(--fxk-ok-ink); border-color: color-mix(in srgb, var(--fxk-ok) 40%, var(--fxk-border)); }
.fxk-mini-ok:hover { background: color-mix(in srgb, var(--fxk-ok) 12%, transparent); color: var(--fxk-ok-ink); }
.fxk-mini-run { color: var(--fxk-text); border-color: color-mix(in srgb, var(--fxk-brand) 26%, var(--fxk-border)); }
.fxk-mini-run:hover { background: color-mix(in srgb, var(--fxk-brand) 10%, transparent); }
/* 计时 + 状态文案是一整块：white-space: nowrap 让「运行中 / 收尾中」的最小宽度等于整词宽度，
   flex 就不会把它压成每行一个字（CJK 的 min-content 是一个字）。 */
.fxk-timer { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--fxk-text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.fxk-timer b { font-weight: 600; color: var(--fxk-text); font-family: var(--fxk-mono); font-size: 12px; }
.fxk-finishing-label { color: var(--fxk-text); font-weight: 560; }
/* 「开始于 月日 时:分」是次要信息：位置不够就整段收起来，优先保住状态文案一行。
   阈值 = 计时（1:03:07 这种也留了位置）+ 两侧 8px 间距 + 这段文字的实际宽度上限；
   中英文宽度差得多（wrapping up 比「运行中」宽 35px），所以英文单独一个更高的阈值。
   阈值是照着真实字体量出来的，超出阈值还没收起的极窄区间里留 ellipsis 兜底。 */
@container (max-width: 230px) {
  .fxk-foot-since { display: none; }
}
@container (max-width: 260px) {
  .fxk-foot-since[data-locale="en"] { display: none; }
}
/* 待审核的「用时」和已完成的「完成于」在窄列只留一个单位（用时 3 分 20 秒 → 用时 3 分；
   完成于 11/14 09:20 → 完成于 11/14）。190px = 最长的「完成于 12/31 23:59」+ 间距 +「↩ 撤销」
   还能排成一行的宽度，所以缩短之前不会换行。 */
.fxk-dual-short { display: none; }
@container (max-width: 190px) {
  .fxk-card-foot .fxk-dual-full { display: none; }
  .fxk-card-foot .fxk-dual-short { display: inline; }
}
/* 比整行还窄的极端情况（英文 wrapping up 在四列并排的下限）：
   状态词允许收成省略号，宁可让位也不让文字溢出卡片。中文「运行中」在任何布局下都放得下，
   看不到这个省略号。 */
.fxk-card-foot .fxk-timer { min-width: 0; }
.fxk-card-foot .fxk-timer > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fxk-pulse {
  width: 6px; height: 6px; border-radius: 999px; flex: none;
  background: var(--fxk-brand);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--fxk-brand) 55%, transparent);
  animation: fxk-pulse 1.8s ease-out infinite;
}
@keyframes fxk-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--fxk-brand) 45%, transparent); }
  70% { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
/* 「等你回答」的计时：不闪 —— 它不是进度，是球在用户这边。
   琥珀点的常态标记和「运行中」的 ink 脉冲，扫一眼就能分开。 */
.fxk-await-dot {
  width: 6px; height: 6px; border-radius: 999px; flex: none;
  background: var(--fxk-warn);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--fxk-warn) 22%, transparent);
}
.fxk-timer-awaiting { color: color-mix(in srgb, var(--fxk-warn) 45%, var(--fxk-text)); }
.fxk-timer-awaiting b { color: var(--fxk-text); }
.fxk-awaiting-label { font-weight: 560; }

/* ----------------------------------------------------------------- list */
/* 平铺表格：一张随内容伸缩的面板，表头 sticky；状态是行内字段，不是分组。 */
.fxk-listwrap {
  flex: 1; min-height: 0;
  width: 100%; max-width: 1400px; margin: 0 auto;
  display: flex; align-items: flex-start;
  padding: 0 20px 20px;
}
.fxk-tablepanel {
  width: 100%; height: auto; max-height: 100%;
  display: flex; flex-direction: column; min-width: 0;
  background: var(--fxk-card);
  border: 1px solid var(--fxk-border);
  border-radius: 14px;
  box-shadow: var(--fxk-shadow);
  overflow: hidden;
}
.fxk-tablescroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.fxk-tablescroll::-webkit-scrollbar { width: 8px; }
.fxk-tablescroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fxk-text) 16%, transparent); border-radius: 8px; }
.fxk-table {
  width: 100%; table-layout: fixed;
  border-collapse: separate; border-spacing: 0;
}
.fxk-table thead th.c-status { width: 116px; }
.fxk-table thead th.c-seq { width: 82px; }
.fxk-table thead th.c-dur { width: 112px; }
.fxk-table thead th.c-upd { width: 136px; }
.fxk-table thead th.c-acts { width: 112px; }

/* 表头：整格可点，th 上带 aria-sort；sticky 只在这一块里生效 */
.fxk-table thead th {
  position: sticky; top: 0; z-index: 2;
  height: 36px; padding: 0 8px;
  background: color-mix(in srgb, var(--fxk-card) 86%, var(--fxk-surface));
  border-bottom: 1px solid var(--fxk-border);
  font-size: 11.5px; line-height: 1; font-weight: 500;
  color: var(--fxk-text-2); text-align: left; white-space: nowrap;
}
.fxk-table thead th:first-child { padding-left: 16px; }
.fxk-table thead th:last-child { padding-right: 16px; }
.fxk-table thead th.is-right { text-align: right; }
.fxk-thbtn {
  width: 100%; height: 100%; padding: 0; border: 0; border-radius: 6px;
  display: inline-flex; align-items: center; gap: 4px;
  background: transparent; color: inherit;
  font-size: 11.5px; line-height: 1; font-weight: 500;
  text-align: left; white-space: nowrap; cursor: pointer;
}
.fxk-thbtn.is-right { justify-content: flex-end; }
.fxk-thbtn:hover { color: var(--fxk-text); }
.fxk-thbtn[data-active="true"] { color: var(--fxk-text); font-weight: 560; }
.fxk-sort { display: inline-flex; opacity: .55; transition: opacity 120ms; }
.fxk-thbtn:hover .fxk-sort { opacity: .85; }
.fxk-thbtn[data-active="true"] .fxk-sort { opacity: 1; }
/* 「任务」表头里的留白：和行内一样先让出状态点 / 编号的位置。
   .fxk-thbtn 的 gap 是 4px，这里各补 4px，合成和 .fxk-task 相同的 8px 间距。
   状态点只是占位，不能真画出来。 */
.fxk-thbtn > .fxk-mob-dot, .fxk-thbtn > .fxk-task-seq { margin-right: 4px; }
.fxk-thbtn > .fxk-mob-dot { visibility: hidden; }

/* 行：单行标题，列宽固定，只有文字省略，不换行 */
.fxk-table tbody td {
  height: 50px; padding: 0 8px;
  border-bottom: 1px solid var(--fxk-border-soft);
  font-size: 13px; color: var(--fxk-text);
  background: transparent;
}
.fxk-table tbody td:first-child { padding-left: 16px; }
.fxk-table tbody td:last-child { padding-right: 16px; }
.fxk-table tbody tr:last-child td { border-bottom: 0; }
.fxk-table tbody tr { cursor: pointer; }
.fxk-table tbody tr:hover td { background: var(--fxk-hover); }
.fxk-table tbody tr:focus-within td { background: color-mix(in srgb, var(--fxk-link) 6%, transparent); }
.fxk-td-seq { font-family: var(--fxk-mono); font-size: 10.5px; line-height: 16px; letter-spacing: .02em; color: var(--fxk-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 只有手机版（≤700px）才收起「编号」列，编号改在任务标题前用等宽小字给出；
   701px 以上有独立的编号列，这里就不重复显示（两者二选一）。
   槽位宽度写死：表头在同一位置放一段同样宽的留白，「任务」才会落在标题正上方，
   而不是压在 fx-N 上被读成编号列的表头。10px 下到 fx-999 都放得下，
   再长只会吃掉后面 8px 的间距，不会把标题顶开。 */
.fxk-task-seq {
  display: none; flex: none;
  width: 38px;
  font-family: var(--fxk-mono); font-size: 10px; line-height: 16px;
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
  color: var(--fxk-text-3); opacity: .7; white-space: nowrap;
}
.fxk-td-task { overflow: hidden; }
.fxk-task { display: flex; align-items: center; gap: 8px; min-width: 0; }
.fxk-title {
  flex: 0 1 auto; min-width: 0; max-width: 100%;
  padding: 0; border: 0; border-radius: 4px; background: transparent;
  font-size: 13.5px; line-height: 19px; font-weight: 560; color: var(--fxk-text);
  text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer;
}
.fxk-title:focus-visible { outline-offset: 1px; }
.fxk-att { flex: none; font-size: 11px; line-height: 16px; color: var(--fxk-text-3); white-space: nowrap; }
.fxk-td-dur { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fxk-dur-text { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-2); }
.fxk-dur-empty { font-size: 11.5px; color: var(--fxk-text-3); }
.fxk-td-dur .fxk-timer { justify-content: flex-end; }
.fxk-td-upd { text-align: right; font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.fxk-td-acts { text-align: right; white-space: nowrap; }
.fxk-acts { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.fxk-act {
  height: 26px; padding: 0 8px; border: 0; border-radius: 6px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  background: transparent; color: var(--fxk-text-2);
  font-size: 11.5px; line-height: 1; white-space: nowrap; cursor: pointer;
  transition: background 120ms, color 120ms;
}
.fxk-act:hover { background: var(--fxk-active); color: var(--fxk-text); }
.fxk-act[disabled] { opacity: .45; cursor: default; }
.fxk-act-run { color: var(--fxk-text); }
.fxk-act-ok { color: var(--fxk-ok-ink); }
.fxk-act-ok:hover { background: color-mix(in srgb, var(--fxk-ok) 12%, transparent); color: var(--fxk-ok-ink); }
.fxk-act-icon { width: 26px; padding: 0; font-size: 13px; color: var(--fxk-text-3); }
.fxk-act-icon:hover { color: var(--fxk-text); }
.fxk-td-acts .fxk-timer { font-size: 11.5px; }
.fxk-td-acts .fxk-timer b { font-size: 11.5px; }

/* 状态 pill：状态是普通字段，每行重复出现 */
.fxk-state {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 8px 0 7px; border-radius: 6px;
  background: var(--fxk-hover); color: var(--fxk-text-2);
  font-size: 11.5px; line-height: 1; white-space: nowrap;
}
.fxk-state-dot { width: 6px; height: 6px; border-radius: 999px; flex: none; background: var(--fxk-idle); }
.fxk-state[data-state="running"] { background: color-mix(in srgb, var(--fxk-brand) 8%, transparent); color: var(--fxk-text); }
.fxk-state[data-state="running"] .fxk-state-dot { background: var(--fxk-brand); }
.fxk-state[data-state="awaiting"] { background: color-mix(in srgb, var(--fxk-warn) 12%, transparent); color: color-mix(in srgb, var(--fxk-warn) 45%, var(--fxk-text)); }
.fxk-state[data-state="awaiting"] .fxk-state-dot { background: var(--fxk-warn); }
.fxk-state[data-state="review"] { background: color-mix(in srgb, var(--fxk-warn) 13%, transparent); color: color-mix(in srgb, var(--fxk-warn) 45%, var(--fxk-text)); }
.fxk-state[data-state="review"] .fxk-state-dot { background: var(--fxk-warn); }
.fxk-state[data-state="done"] { background: color-mix(in srgb, var(--fxk-ok) 11%, transparent); color: color-mix(in srgb, var(--fxk-ok) 50%, var(--fxk-text)); }
.fxk-state[data-state="done"] .fxk-state-dot { background: var(--fxk-ok); }

/* 表尾的整行新建入口：排序后不再代表「下一张卡的位置」，但仍是最顺手的入口 */
.fxk-addrow {
  width: 100%; height: 40px; padding: 0 16px;
  display: flex; align-items: center; gap: 7px;
  border: 0; border-top: 1px dashed var(--fxk-border);
  background: transparent; color: var(--fxk-text-2);
  font-size: 12px; line-height: 1; font-weight: 500; text-align: left;
  cursor: pointer; transition: background 120ms, color 120ms;
}
.fxk-addrow:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-tablefoot {
  flex: none; min-height: 34px; padding: 0 16px;
  display: flex; align-items: center; gap: 8px;
  border-top: 1px solid var(--fxk-border-soft);
  background: color-mix(in srgb, var(--fxk-card) 88%, var(--fxk-surface));
  font-size: 11.5px; line-height: 16px; color: var(--fxk-text-3);
  font-variant-numeric: tabular-nums;
}
.fxk-foot-short { display: none; }
.fxk-empty-cell { height: 120px; text-align: center; color: var(--fxk-text-2); font-size: 12.5px; }
.fxk-skeleton-cell { height: 50px; }
.fxk-skeleton-bar { display: block; width: 42%; height: 11px; border-radius: 6px; background: color-mix(in srgb, var(--fxk-text) 5%, transparent); animation: fxk-breathe 1.4s ease-in-out infinite; }
.fxk-mob-dot { display: none; }
.fxk-mob-timer { display: none; }
.fxk-sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* ------------------------------------------------------------ status bar */
.fxk-errorbar {
  flex: none;
  width: 100%; max-width: 1400px; margin: 0 auto 8px;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--fxk-err) 35%, var(--fxk-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--fxk-err) 8%, var(--fxk-card));
  color: color-mix(in srgb, var(--fxk-err) 82%, var(--fxk-text));
  font-size: 12px;
}
.fxk-errorbar span { flex: 1; min-width: 0; word-break: break-word; }
.fxk-skeleton { height: 62px; border-radius: 12px; border: 1px solid var(--fxk-border-soft); background: color-mix(in srgb, var(--fxk-text) 5%, transparent); animation: fxk-breathe 1.4s ease-in-out infinite; }
@keyframes fxk-breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }

/* ---------------------------------------------------------------- sheet */
.fxk-overlay {
  position: absolute; inset: 0; z-index: 20;
  display: flex; align-items: stretch; justify-content: flex-end;
  background: color-mix(in srgb, var(--fxk-text) 18%, transparent);
  animation: fxk-fade 120ms ease-out;
}
@keyframes fxk-fade { from { opacity: 0; } to { opacity: 1; } }
.fxk-sheet {
  width: min(560px, 100%);
  height: 100%;
  display: flex; flex-direction: column; min-height: 0;
  background: var(--fxk-card);
  border-left: 1px solid var(--fxk-border);
  box-shadow: 0 18px 60px -18px rgba(15, 23, 42, .35);
  animation: fxk-slide 160ms ease-out;
}
@keyframes fxk-slide { from { transform: translateX(18px); opacity: .6; } to { transform: none; opacity: 1; } }
.fxk-sheet-head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--fxk-border-soft);
}
.fxk-sheet-title { font-size: 15px; line-height: 22px; font-weight: 600; }
/* 卡片编号：安静地跟在标题后面，像个文件编号；点一下复制 */
.fxk-sheet-seq {
  flex: none; align-self: center;
  margin: -1px 0 0 -4px; padding: 1px 4px;
  border: 0; border-radius: 5px; background: transparent;
  font-family: var(--fxk-mono); font-size: 10.5px; line-height: 16px;
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
  color: var(--fxk-text-3); cursor: copy; user-select: none;
  transition: color 120ms, background 120ms;
}
.fxk-sheet-seq:hover { color: var(--fxk-text-2); background: var(--fxk-hover); }
.fxk-sheet-seq:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-link) 45%, transparent); outline-offset: 1px; }
.fxk-sheet-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px 18px; display: flex; flex-direction: column; gap: 12px; }
.fxk-sheet-foot {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--fxk-border-soft);
  background: color-mix(in srgb, var(--fxk-card) 88%, var(--fxk-surface));
}
.fxk-autosave {
  display: inline-flex; align-items: center; gap: 5px;
  min-width: 0; margin-right: 2px;
  font-size: 11.5px; line-height: 16px; color: var(--fxk-text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fxk-autosave::before {
  content: ''; flex: none;
  width: 5px; height: 5px; border-radius: 999px;
  background: currentColor; opacity: .55;
}
.fxk-autosave[data-kind="dirty"] { color: var(--fxk-text-2); }
.fxk-autosave[data-kind="saving"] { color: var(--fxk-text-2); }
.fxk-autosave[data-kind="error"] { color: color-mix(in srgb, var(--fxk-err) 80%, var(--fxk-text)); }
/* 「还没选工作区所以没存」：这是待办，不是失败也不该被忽略，用琥珀提醒 */
.fxk-autosave[data-kind="blocked"] { color: color-mix(in srgb, var(--fxk-warn) 70%, var(--fxk-text)); }
.fxk-field { display: flex; flex-direction: column; gap: 6px; }
.fxk-label { font-size: 12px; line-height: 18px; color: var(--fxk-text-2); }
.fxk-input, .fxk-textarea {
  width: 100%;
  border: 1px solid var(--fxk-border); border-radius: 10px;
  background: var(--fxk-surface); color: var(--fxk-text);
  font: inherit; font-size: 13px; line-height: 20px;
  padding: 8px 10px;
}
.fxk-input { height: 34px; }
.fxk-textarea { min-height: 180px; resize: vertical; }
.fxk-input:focus, .fxk-textarea:focus { outline: none; border-color: color-mix(in srgb, var(--fxk-link) 55%, var(--fxk-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fxk-link) 14%, transparent); }
.fxk-drop { border-radius: 12px; border: 1px dashed transparent; transition: border-color 120ms, background 120ms; }
.fxk-drop.fxk-dragging { border-color: color-mix(in srgb, var(--fxk-link) 55%, var(--fxk-border)); background: color-mix(in srgb, var(--fxk-link) 6%, transparent); }
.fxk-attach { display: flex; flex-wrap: wrap; gap: 8px; }
.fxk-attach-item {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 220px; height: 26px; padding: 0 8px;
  border: 1px solid var(--fxk-border); border-radius: 7px;
  background: var(--fxk-surface); color: var(--fxk-text-2); font-size: 11.5px;
}
.fxk-attach-item img { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; flex: none; }
.fxk-attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fxk-attach-x { border: 0; background: transparent; color: var(--fxk-text-2); cursor: pointer; padding: 0 2px; font-size: 13px; line-height: 1; }
.fxk-attach-x:hover { color: var(--fxk-err); }
.fxk-hint { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-2); }
.fxk-err { font-size: 12px; line-height: 18px; color: color-mix(in srgb, var(--fxk-err) 85%, var(--fxk-text)); }

/* ---------------------------------------------------------------- settings */
.fxk-gear { flex: none; color: var(--fxk-text-2); }
.fxk-gear:hover { color: var(--fxk-text); }
.fxk-settings { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; width: 100%; }
.fxk-settings-head {
  flex: none; width: calc(100% - 40px); max-width: 760px; margin: 0 auto;
  display: flex; align-items: center; gap: 10px;
  min-height: 62px; padding: 10px 0 8px;
}
.fxk-back {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 10px 0 8px;
  border: 1px solid var(--fxk-border); border-radius: 8px;
  background: var(--fxk-surface); color: var(--fxk-text-2);
  font-size: 12px; line-height: 1; cursor: pointer;
}
.fxk-back:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-back-arrow { font-size: 14px; line-height: 1; }
.fxk-settings-title {
  margin: 0; font-size: 15px; line-height: 22px; font-weight: 600;
  letter-spacing: .01em; color: var(--fxk-text);
}
.fxk-settings-title:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 4px; border-radius: 4px; }
.fxk-settings-sub { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); white-space: nowrap; }
.fxk-settings-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 20px 24px; }
.fxk-settings-body { width: 100%; max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.fxk-settings-card {
  padding: 18px 20px 16px;
  border: 1px solid var(--fxk-border); border-radius: 14px;
  background: var(--fxk-card); box-shadow: var(--fxk-shadow);
}
.fxk-settings-card h2 { margin: 0 0 4px; font-size: 13.5px; line-height: 20px; font-weight: 600; color: var(--fxk-text); }
.fxk-settings-desc { margin: 0 0 14px; font-size: 12px; line-height: 18px; color: var(--fxk-text-2); }
.fxk-settings-fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 8px; }
.fxk-radio {
  position: relative; display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--fxk-border-soft); border-radius: 10px;
  cursor: pointer; transition: border-color 120ms, background 120ms;
}
.fxk-radio:hover { background: var(--fxk-hover); }
.fxk-radio[data-checked="true"] {
  border-color: color-mix(in srgb, var(--fxk-brand) 34%, var(--fxk-border));
  background: color-mix(in srgb, var(--fxk-brand) 5%, transparent);
}
.fxk-radio:focus-within { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 2px; }
.fxk-radio input { position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; opacity: 0; pointer-events: none; }
.fxk-radio-dot {
  flex: none; width: 16px; height: 16px; margin-top: 2px;
  border: 1.5px solid var(--fxk-border); border-radius: 999px;
  background: var(--fxk-card);
  display: inline-flex; align-items: center; justify-content: center;
}
.fxk-radio[data-checked="true"] .fxk-radio-dot { border-color: var(--fxk-brand); }
.fxk-radio[data-checked="true"] .fxk-radio-dot::after {
  content: ""; width: 8px; height: 8px; border-radius: 999px; background: var(--fxk-brand);
}
.fxk-radio-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fxk-radio-title { font-size: 12.5px; line-height: 18px; font-weight: 560; color: var(--fxk-text); }
.fxk-radio-desc { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-2); }
.fxk-settings-field { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.fxk-settings-label { font-size: 12px; line-height: 18px; font-weight: 560; color: var(--fxk-text); }
.fxk-settings-textarea {
  width: 100%; min-height: 104px; resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--fxk-border); border-radius: 10px;
  background: var(--fxk-surface); color: var(--fxk-text);
  font: inherit; font-size: 12.5px; line-height: 19px;
}
.fxk-settings-textarea:focus { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 1px; }
.fxk-settings-textarea[aria-invalid="true"] { border-color: var(--fxk-err); }
.fxk-settings-textarea[disabled] { opacity: .6; }
.fxk-settings-field-foot { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.fxk-settings-hint { flex: 1; font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); }
.fxk-settings-count { flex: none; font-size: 11px; line-height: 17px; color: var(--fxk-text-3); font-variant-numeric: tabular-nums; }
.fxk-settings-count[data-over="true"] { color: var(--fxk-err); }
.fxk-settings-error { margin: 2px 0 0; font-size: 11.5px; line-height: 17px; color: color-mix(in srgb, var(--fxk-err) 85%, var(--fxk-text)); }
.fxk-settings-note { margin: 12px 0 0; font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); }
.fxk-check {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 10px 11px;
  border: 1px solid var(--fxk-border); border-radius: 10px;
  background: var(--fxk-surface);
  cursor: pointer;
  transition: border-color 120ms, background 120ms;
}
.fxk-check:hover { border-color: color-mix(in srgb, var(--fxk-brand) 30%, var(--fxk-border)); }
.fxk-check[data-checked="true"] { border-color: color-mix(in srgb, var(--fxk-brand) 42%, var(--fxk-border)); background: color-mix(in srgb, var(--fxk-brand) 5%, var(--fxk-surface)); }
.fxk-check[data-disabled="true"] { cursor: not-allowed; }
.fxk-check[data-disabled="true"]:hover { border-color: var(--fxk-border); }
.fxk-check[data-disabled="true"][data-checked="true"] { border-color: var(--fxk-border); background: var(--fxk-surface); }
.fxk-check[data-disabled="true"] input,
.fxk-check[data-disabled="true"] .fxk-check-title,
.fxk-check[data-disabled="true"] .fxk-check-desc,
.fxk-check[data-disabled="true"] .fxk-check-hint { opacity: .6; }
.fxk-check:focus-within { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 2px; }
.fxk-check input { flex: none; width: 15px; height: 15px; margin: 1px 0 0; accent-color: var(--fxk-brand); cursor: inherit; }
.fxk-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fxk-check-title-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.fxk-check-title { font-size: 12.5px; line-height: 18px; font-weight: 560; color: var(--fxk-text); }
.fxk-check-desc { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-2); }
.fxk-check-hint { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); }
.fxk-settings-group-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 16px 0 8px; }
.fxk-settings-group-head .fxk-settings-subhead { margin: 0; }
.fxk-settings-group-note { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); }
.fxk-link {
  border: 0; background: none; padding: 0;
  font: inherit; color: var(--fxk-link); cursor: pointer;
  text-decoration: underline; text-underline-offset: 2px;
}
.fxk-link:hover { text-decoration-thickness: 2px; }
.fxk-link:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-link) 70%, transparent); outline-offset: 2px; border-radius: 3px; }
.fxk-settings-subhead { margin: 16px 0 2px; font-size: 11.5px; line-height: 17px; font-weight: 560; color: var(--fxk-text-2); }
.fxk-advanced { display: flex; flex-direction: column; }
.fxk-advanced-row { display: flex; align-items: center; gap: 16px; padding: 8px 0; border-top: 1px solid var(--fxk-border-soft); font-size: 12px; line-height: 18px; }
.fxk-advanced-row:first-child { border-top: 0; }
.fxk-advanced-key { flex: none; width: 150px; color: var(--fxk-text-2); }
.fxk-advanced-val { flex: 1 1 auto; min-width: 0; color: var(--fxk-text); word-break: break-word; }
.fxk-advanced-path { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fxk-path { font-family: var(--fxk-mono); font-size: 11px; line-height: 17px; color: var(--fxk-text-2); word-break: break-all; }
.fxk-settings-actions {
  flex: none;
  width: calc(100% - 40px); max-width: 760px; margin: 0 auto;
  display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
  padding: 10px 0 14px;
  border-top: 1px solid var(--fxk-border-soft);
  background: var(--fxk-canvas);
}
.fxk-settings-status-wrap { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.fxk-settings-status { font-size: 11.5px; line-height: 17px; color: var(--fxk-text-3); }
.fxk-settings-save { min-width: 96px; }
.fxk-settings-errorbar {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--fxk-err) 28%, var(--fxk-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--fxk-err) 7%, var(--fxk-card));
  color: color-mix(in srgb, var(--fxk-err) 75%, var(--fxk-text));
  font-size: 12px; line-height: 18px;
}
.fxk-settings-errorbar span { flex: 1; min-width: 0; }
.fxk-settings-skeleton-gap { height: 14px; }

/* ---------------------------------------------------------------- toast */
.fxk-toast {
  position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%);
  z-index: 30;
  display: flex; align-items: center; gap: 12px;
  max-width: min(560px, calc(100% - 40px));
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid var(--fxk-border);
  background: var(--fxk-card);
  box-shadow: 0 12px 32px -14px rgba(15, 23, 42, .4);
  font-size: 12px; line-height: 18px;
  animation: fxk-rise 140ms ease-out;
}
@keyframes fxk-rise { from { transform: translate(-50%, 8px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
.fxk-toast-text { flex: 1; min-width: 0; word-break: break-word; }
.fxk-toast button { border: 0; background: transparent; color: var(--fxk-link); font-size: 12px; cursor: pointer; padding: 0 2px; }

/* ------------------------------------------------------------ narrow view */
.fxk-tabs { display: none; }

@container (max-width: 700px) {
  .fxk-head { min-height: 56px; padding: 8px 14px 6px; flex-wrap: wrap; gap: 8px; row-gap: 6px; }
  .fxk-settings-head { width: calc(100% - 28px); min-height: 56px; padding: 8px 0 6px; }
  .fxk-settings-scroll { padding: 0 14px 20px; }
  .fxk-settings-card { padding: 14px; border-radius: 12px; }
  .fxk-settings-sub { display: none; }
  .fxk-advanced-row { flex-direction: column; align-items: flex-start; gap: 2px; }
  .fxk-advanced-key { width: auto; }
  .fxk-settings-actions { width: calc(100% - 28px); flex-direction: column; align-items: stretch; padding: 8px 0 12px; }
  .fxk-settings-save { width: 100%; }
  .fxk-brand { flex: 1 1 auto; min-width: 0; }
  .fxk-head-spacer { display: none; }
  .fxk-head .fxk-filter { order: 3; flex: 1 1 100%; width: 100%; }
  .fxk-head .fxk-filter .fxk-select { flex: 1 1 auto; width: auto; max-width: none; }
  .fxk-col { min-width: 0; }
  .fxk-board { display: flex; flex-direction: column; gap: 12px; padding: 0 14px 14px; }
  .fxk-tabs { display: flex; gap: 6px; padding: 0 14px 10px; flex: none; overflow-x: auto; }
  .fxk-tab {
    height: 28px; padding: 0 10px; border-radius: 999px;
    border: 1px solid var(--fxk-border); background: var(--fxk-surface);
    color: var(--fxk-text-2); font-size: 12px; cursor: pointer; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .fxk-tab[data-active="true"] { background: color-mix(in srgb, var(--fxk-brand) 12%, var(--fxk-surface)); border-color: color-mix(in srgb, var(--fxk-brand) 30%, var(--fxk-border)); color: var(--fxk-text); }
  .fxk-col { display: none; }
  .fxk-root[data-narrow="todo"] .fxk-col[data-state="todo"],
  .fxk-root[data-narrow="running"] .fxk-col[data-state="running"],
  .fxk-root[data-narrow="review"] .fxk-col[data-state="review"],
  .fxk-root[data-narrow="done"] .fxk-col[data-state="done"] { display: flex; flex: 1; }
  .fxk-sheet { width: 100%; border-left: 0; }
  .fxk-sheet-foot { flex-wrap: wrap; gap: 6px; }
  .fxk-autosave { order: -1; flex: 1 1 100%; margin-right: 0; }

  /* 列表窄屏：只留任务 / 操作；状态收成标题前的色点，更新 / 用时收进表尾提示 */
  .fxk-listwrap { padding: 0 14px 14px; }
  .fxk-table th.c-status, .fxk-table th.c-seq, .fxk-table th.c-dur, .fxk-table th.c-upd,
  .fxk-table td.c-status, .fxk-table td.c-seq, .fxk-table td.c-dur, .fxk-table td.c-upd { display: none; }
  .fxk-table thead th.c-acts { width: 96px; }
  /* 和 td.c-task 用同一条左内边距；色点 + 编号的留白由表头里的占位元素补，
     不再靠 27px 这种手算值把「任务」硬推到数字上方。 */
  .fxk-table thead th.c-task { padding-left: 12px; }
  .fxk-table tbody td.c-task { padding-left: 12px; }
  .fxk-table tbody td { height: 52px; }
  .fxk-table tbody td.c-acts { padding-right: 12px; }
  .fxk-mob-dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; flex: none; background: var(--fxk-idle); }
  .fxk-mob-dot[data-state="running"] { background: var(--fxk-brand); }
  .fxk-mob-dot[data-state="awaiting"] { background: var(--fxk-warn); }
  .fxk-mob-dot[data-state="review"] { background: var(--fxk-warn); }
  .fxk-mob-dot[data-state="done"] { background: var(--fxk-ok); }
  .fxk-mob-timer { display: inline-flex; }
  /* 手机版收掉「编号」列，编号改到标题前，所以这里才需要行内编号 */
  .fxk-table .fxk-task-seq { display: inline-block; }
  .fxk-att, .fxk-table .fxk-chip { display: none; }
  .fxk-tablefoot { padding: 0 12px; }
  .fxk-foot-full { display: none; }
  .fxk-foot-short { display: inline; }
  .fxk-addrow { padding: 0 12px; font-size: 11.5px; }
}

/* 中等宽度（分屏 / 平板）：六个表头一个都不收。收起会让表头少一格、
   编号只剩行内前缀，看起来像表头缺了一块；这里只把固定列压窄，给标题留出空间。
   960px 以上保持和宽屏完全一样，不做任何调整。 */
@container (min-width: 701px) and (max-width: 960px) {
  .fxk-table thead th.c-status { width: 96px; }
  .fxk-table thead th.c-seq { width: 70px; }
  .fxk-table thead th.c-dur { width: 88px; }
  .fxk-table thead th.c-upd { width: 112px; }
  .fxk-table thead th.c-acts { width: 96px; }
  .fxk-foot-full { display: none; }
  .fxk-foot-short { display: inline; }
}

/* 手机上先把标题行收紧一档，保住「看板 / 列表」两个文字标签 */
@container (max-width: 430px) {
  .fxk-head { gap: 6px; }
  .fxk-settings-head { gap: 6px; }
  .fxk-back { width: 30px; padding: 0; justify-content: center; }
  .fxk-back-label { display: none; }
  .fxk-viewswitch { margin-left: 4px; }
  /* 保住「看板 / 列表」两个标签：顶部新建收成 +（表尾那条带文字的新建还在） */
  .fxk-head .fxk-btn { width: 30px; padding: 0; }
  .fxk-new-label { display: none; }
}

/* 再窄就只留图标，aria-label / title 还在 */
@container (max-width: 360px) {
  .fxk-viewswitch button { padding: 0 6px; }
  .fxk-viewswitch svg { width: 14px; height: 14px; }
  .fxk-viewswitch-label {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fxk-pulse { animation: none; }
  .fxk-skeleton { animation: none; }
  .fxk-overlay, .fxk-sheet, .fxk-toast { animation: none; }
  .fxk-card:hover { transform: none; }
  .fxk-caret { transition: none; }
}

/* ------------------------------------------- session header (outside .fxk-root) */
/* 标题栏挂在 .fxk-root 之外，拿不到 --fxk-*，这里自带一份 token 映射。
   约定：圆点是状态，✓ 是动作——所以状态标不加底色，唯一的实心控件是「✓ 完成」。 */
.fxk-hd {
  --fxk-hd-text: var(--dsw-alias-label-primary, #0f1115);
  --fxk-hd-text-2: var(--dsw-alias-label-secondary, #61666b);
  --fxk-hd-text-3: var(--dsw-alias-label-tertiary, #81858c);
  --fxk-hd-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
  --fxk-hd-border: var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
  --fxk-hd-run: var(--dsw-alias-brand-primary, #0f1115);
  --fxk-hd-review: var(--dsw-alias-state-warn-primary, #f59e0b);
  --fxk-hd-done: var(--dsw-alias-state-success-primary, #22c55e);
  --fxk-hd-err: var(--dsw-alias-state-error-primary, #ec1313);
  /* 元数据底色：和标题栏里的预设标签（Standard）同一个 token，不让它看起来像按钮 */
  --fxk-hd-fill: var(--dsw-alias-fill-tsp-secondary, rgba(38, 49, 72, .06));
  --fxk-hd-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}
.fxk-hd-state {
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 2px;
  font-size: 12px; line-height: 22px;
  color: var(--fxk-hd-text-3);
  white-space: nowrap;
}
.fxk-hd-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--fxk-hd-text-3); flex: none; }
.fxk-hd-state[data-state="running"] .fxk-hd-dot { background: var(--fxk-hd-run); }
.fxk-hd-state[data-state="finishing"] .fxk-hd-dot { background: var(--fxk-hd-run); }
.fxk-hd-state[data-state="awaiting"] .fxk-hd-dot { background: var(--fxk-hd-review); }
.fxk-hd-state[data-state="review"] .fxk-hd-dot { background: var(--fxk-hd-review); }
.fxk-hd-state[data-state="done"] .fxk-hd-dot { background: var(--fxk-hd-done); }
/* 卡片编号：标题栏里最安静的身份标——不加圆点、不描边，只在 hover 时浮起一层底色。
   点一下复制，复制成功后短暂换成「✓ 已复制」，比只改 tooltip 更确定。 */
.fxk-hd-seq {
  display: inline-flex; align-items: center; gap: 4px;
  height: 22px; padding: 0 5px;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent;
  color: var(--fxk-hd-text-3);
  font-family: var(--fxk-hd-mono); font-size: 11px; line-height: 1; font-weight: 500;
  letter-spacing: .02em; white-space: nowrap;
  cursor: copy;
  -webkit-app-region: no-drag;
  transition: background .12s ease, color .12s ease;
}
.fxk-hd-seq:hover { background: var(--fxk-hd-fill); color: var(--fxk-hd-text-2); }
.fxk-hd-seq:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-hd-run) 45%, transparent); outline-offset: 1px; }
.fxk-hd-seq[data-copied="ok"] { background: var(--fxk-hd-fill); color: var(--fxk-hd-text-2); cursor: default; }
.fxk-hd-seq[data-copied="fail"] {
  background: color-mix(in srgb, var(--fxk-hd-err) 10%, transparent);
  color: color-mix(in srgb, var(--fxk-hd-err) 70%, var(--fxk-hd-text));
  cursor: default;
}
/* 工作树位置：卡片勾了独立 worktree，会话就在 .agents/worktrees/ 的检出里跑，
   项目目录看不到这些改动。这枚分支标常驻标题栏：宽标题栏写分支名，窄标题栏只留图标；
   分支 / 目录 / 合并提醒都放进 tooltip。
   它不抢「圆点是状态、✓ 是动作」的约定：只用预设标签那种元数据底色，不加圆点、不描边，
   唯一的实心控件仍然是「✓ 完成」。 */
.fxk-hd-wt {
  position: relative;
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 168px; height: 22px; padding: 0 7px;
  /* 常态是透明边框：勾了还没建时换成虚线，宽度不跳 */
  border: 1px dashed transparent;
  border-radius: 6px;
  background: var(--fxk-hd-fill);
  color: var(--fxk-hd-text-2);
  font-size: 12px; line-height: 22px;
  white-space: nowrap; overflow: hidden;
  -webkit-app-region: no-drag;
}
.fxk-hd-wt > svg { flex: none; display: block; }
.fxk-hd-wt-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--fxk-hd-mono); }
/* 勾了但还没建：虚线、降一档文字色，别让人把它当成真的分支名 */
.fxk-hd-wt[data-phase="preparing"] {
  border-color: var(--fxk-hd-border);
  background: transparent;
  color: var(--fxk-hd-text-3);
}
/* 建树失败：只剩红字，不填色（不当按钮），原因在 tooltip 里 */
.fxk-hd-wt[data-tone="error"] {
  background: transparent;
  color: var(--fxk-hd-err);
}
.fxk-hd-wt-sr {
  position: absolute; width: 1px; height: 1px;
  margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0;
}
.fxk-hd-btn {
  display: inline-flex; align-items: center; gap: 4px;
  height: 22px; padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--fxk-hd-done) 40%, var(--fxk-hd-border));
  border-radius: 6px;
  background: transparent;
  color: color-mix(in srgb, var(--fxk-hd-done) 60%, var(--fxk-hd-text));
  font: inherit; font-size: 12px; line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background .12s ease, border-color .12s ease;
}
.fxk-hd-btn:hover { background: color-mix(in srgb, var(--fxk-hd-done) 12%, transparent); }
.fxk-hd-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-hd-done) 45%, transparent); outline-offset: 1px; }
.fxk-hd-btn[disabled] { cursor: default; opacity: .72; }
.fxk-hd-btn[data-tone="error"] {
  border-color: color-mix(in srgb, var(--fxk-hd-err) 40%, var(--fxk-hd-border));
  color: color-mix(in srgb, var(--fxk-hd-err) 70%, var(--fxk-hd-text));
}
.fxk-hd-btn[data-tone="error"]:hover { background: color-mix(in srgb, var(--fxk-hd-err) 10%, transparent); }
.fxk-hd-btn[data-tone="board"] { border-color: var(--fxk-hd-border); color: var(--fxk-hd-text-2); }
.fxk-hd-btn[data-tone="board"]:hover { background: var(--fxk-hd-hover); color: var(--fxk-hd-text); }
.fxk-hd-btn[data-tone="warn"] {
  border-color: color-mix(in srgb, var(--fxk-hd-review) 45%, var(--fxk-hd-border));
  color: color-mix(in srgb, var(--fxk-hd-review) 65%, var(--fxk-hd-text));
}
.fxk-hd-btn[data-tone="warn"]:hover { background: color-mix(in srgb, var(--fxk-hd-review) 12%, transparent); }

/* 窄标题栏：状态只留圆点。文字不 display:none，而是收成 1px 的屏读文本，
   这样读屏仍然能读到「进行中 / 待审核 / 已完成」，按钮优先保留。
   工作树分支标同理：分支名收成屏读文本，只留图标，tooltip 照旧。 */
@container (max-width: 620px) {
  .fxk-hd-label {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  .fxk-hd-state { padding: 0; }
  .fxk-hd-wt-name {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  .fxk-hd-wt { gap: 0; padding: 0 6px; }
}
`

    function ensureStyles() {
      // 插件被关掉再打开时页面不会重建，旧 <style> 还挂在 head 上；
      // 这里每次都覆盖内容，避免新 class 拿不到样式退化成浏览器原生按钮。
      const id = 'dsh-kanban-fx-styles'
      let style = document.getElementById(id)
      if (!style) {
        style = document.createElement('style')
        style.id = id
        document.head.appendChild(style)
      }
      if (style.textContent !== CSS) style.textContent = CSS
    }

    // ----------------------------------------------------------------- icon
    function IconKanban(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2.6, y: 3.6, width: 3.1, height: 12.8, rx: 1.4, fill: 'currentColor', opacity: active ? 1 : 0.92 }),
        h('rect', { x: 7.0, y: 3.6, width: 3.1, height: 8.6, rx: 1.4, fill: 'currentColor', opacity: active ? 0.92 : 0.72 }),
        h('rect', { x: 11.4, y: 3.6, width: 3.1, height: 5.4, rx: 1.4, fill: 'currentColor', opacity: active ? 0.8 : 0.56 }),
        h('rect', { x: 15.8, y: 3.6, width: 1.6, height: 3.4, rx: 0.8, fill: 'currentColor', opacity: active ? 0.7 : 0.4 }),
      )
    }

    /** 工作区「…」菜单里的看板图标：菜单行的图标位是 16px，侧边栏入口那颗 18px 会顶出来。 */
    function KanbanMenuIcon() {
      return h(IconKanban, { size: 16 })
    }

    /** 复制命令的小图标：两张叠起来的纸。 */
    function IconCopy(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 10
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { d: 'M5 15V5a2 2 0 0 1 2-2h8' }),
      )
    }

    /**
     * 工作树的分支图标。⎇ 字形在 12px 下像个小对勾，窄标题栏里容易和
     * 旁边的「✓ 完成」混，所以画一颗真的分支（卡片 chip 和标题栏共用）。
     */
    function IconBranch(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 12
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          // React 只认 camelCase 的 SVG 属性：写成 stroke-width 会被忽略，线会细成 1px
          strokeWidth: 2.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('line', { x1: 6, y1: 3.2, x2: 6, y2: 16 }),
        h('circle', { cx: 18, cy: 6, r: 3 }),
        h('circle', { cx: 6, cy: 18, r: 3 }),
        h('path', { d: 'M18 9a9 9 0 0 1-9 9' }),
      )
    }

    /** 列表视图图标：三条带点的行，和看板的竖条图标是一对。 */
    function IconList(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        [4.3, 10, 15.7].map((y, index) =>
          h(
            'g',
            { key: index },
            h('circle', { cx: 3.3, cy: y, r: 1.05, fill: 'currentColor' }),
            h('rect', { x: 6.4, y: y - 0.7, width: 10.4, height: 1.4, rx: 0.7, fill: 'currentColor' }),
          ),
        ),
      )
    }

    /** 表头排序箭头：未排序列是淡的双向箭头，当前列只亮其中一边。 */
    function IconSort(props) {
      const active = Boolean(props && props.active)
      const dir = props && props.dir === 'asc' ? 'asc' : 'desc'
      return h(
        'svg',
        { width: 10, height: 14, viewBox: '0 0 10 14', fill: 'none', 'aria-hidden': true, className: 'fxk-sort' },
        h('path', { d: 'M5 1.4 7.7 4.8H2.3L5 1.4Z', fill: 'currentColor', opacity: active ? (dir === 'asc' ? 1 : 0.18) : 0.5 }),
        h('path', { d: 'M5 12.6 2.3 9.2h5.4L5 12.6Z', fill: 'currentColor', opacity: active ? (dir === 'desc' ? 1 : 0.18) : 0.5 }),
      )
    }

    /** 设置齿轮：一颗安静的小 cog，放在顶栏最右侧。 */
    function IconGear(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 12, cy: 12, r: 3.1 }),
        h('path', {
          d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.03a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.03a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.97Z',
        }),
      )
    }

    // ---------------------------------------------------------------- utils
    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      const pad = (value) => String(value).padStart(2, '0')
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`)
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`)
      const hours = Math.floor(minutes / 60)
      return t(`${hours} 小时 ${minutes % 60} 分`, `${hours}h ${minutes % 60}m`)
    }

    /** 窄列只放得下一个单位：3 分 20 秒 → 3 分，1 小时 12 分 → 1 小时。 */
    function formatDurationShort(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`)
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t(`${minutes} 分`, `${minutes}m`)
      return t(`${Math.floor(minutes / 60)} 小时`, `${Math.floor(minutes / 60)}h`)
    }

    function clockOf(ms) {
      try {
        return new Date(ms).toLocaleTimeString(isZh() ? 'zh-CN' : 'en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function formatClock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      try {
        return new Date(ms).toLocaleString(isZh() ? 'zh-CN' : 'en-US', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** 只有月日的时钟（窄列用）：11/14。 */
    function formatClockShort(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      try {
        return new Date(ms).toLocaleDateString(isZh() ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric' })
      } catch {
        return ''
      }
    }

    /** 列表「更新」列：今天 / 昨天给时刻，更早给月日；跨年补年份。 */
    function formatWhen(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const date = new Date(value)
      const clock = clockOf(value)
      if (value >= start) return t(`今天 ${clock}`, `Today ${clock}`)
      if (value >= start - 86400000) return t(`昨天 ${clock}`, `Yesterday ${clock}`)
      const stamp = `${date.getMonth() + 1}/${date.getDate()} ${clock}`
      return date.getFullYear() === now.getFullYear() ? stamp : `${date.getFullYear()}/${stamp}`
    }

    /**
     * 列表的用时：进行中算当前这一轮；等你回答时给已等时长（和单元格里显示的一致）；
     * 其余用上一次跑完的用时。排序和展示共用，避免「按用时排序」和看到的数字对不上。
     */
    function durationOf(card, now, skew) {
      if (card.status === 'running' && card.awaitingSince) return Math.max(0, now - skew - card.awaitingSince)
      if (card.status === 'running' && card.runningSince) return Math.max(0, now - skew - card.runningSince)
      return Number(card.lastRunMs) || 0
    }

    function compareListCards(left, right, sort, now, skew) {
      let primary = 0
      if (sort.key === 'status') primary = (STATUS_RANK[left.status] ?? 99) - (STATUS_RANK[right.status] ?? 99)
      else if (sort.key === 'seq') primary = (Number(left.seq) || 0) - (Number(right.seq) || 0)
      else if (sort.key === 'duration') primary = durationOf(left, now, skew) - durationOf(right, now, skew)
      else if (sort.key === 'updated') primary = (Number(left.updatedAt) || Number(left.createdAt) || 0) - (Number(right.updatedAt) || Number(right.createdAt) || 0)
      else if (sort.key === 'title') {
        try {
          primary = String(left.title || '').localeCompare(String(right.title || ''), isZh() ? 'zh-Hans-CN' : 'en', { numeric: true, sensitivity: 'base' })
        } catch {
          primary = String(left.title || '').localeCompare(String(right.title || ''))
        }
      }
      // 同值永远按编号升序兜底：排序稳定，同状态内也保持创建顺序。
      if (primary === 0) return (Number(left.seq) || 0) - (Number(right.seq) || 0)
      return sort.dir === 'desc' ? -primary : primary
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
      return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function excerptOf(body) {
      const text = String(body || '').replace(/\r\n/g, '\n').trim()
      if (!text) return ''
      return text.length > 220 ? `${text.slice(0, 220)}…` : text
    }

    /**
     * 标题留空时，「会话名会是什么」的实时预览。
     * 规则和 Host 的 deriveTitle 保持一致（正文首行 → 单个附件的文件名）；
     * 真正的展示标题始终以 Host 落库的为准，这里只是侧栏里的一句提示。
     */
    function titlePreviewOf(body, attachmentNames) {
      const clean = (line) => {
        let value = String(line || '').trim()
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
      const clip = (value) => {
        const chars = Array.from(value)
        if (chars.length <= 42) return value.replace(/[。．.!！?？;；,，、：:\s]+$/, '').trim()
        const head = chars.slice(0, 42).join('')
        let lastMark = -1
        for (const mark of ['。', '！', '？', '；', '.', '!', '?', ';']) {
          lastMark = Math.max(lastMark, head.lastIndexOf(mark))
        }
        let cut = head
        if (lastMark >= 21) {
          cut = head.slice(0, lastMark + 1)
        } else {
          const lastBreak = Math.max(head.lastIndexOf(' '), head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('、'))
          if (lastBreak >= 21) cut = head.slice(0, lastBreak)
        }
        return cut.replace(/[。．.!！?？;；,，、：:\s]+$/, '').trim()
      }
      for (const line of String(body || '').slice(0, 4000).split('\n')) {
        if (/^\s*[-*_=]{3,}\s*$/.test(line)) continue
        const value = clean(line)
        if (value) return clip(value)
      }
      const names = Array.isArray(attachmentNames) ? attachmentNames : []
      if (names.length === 1) return clip(String(names[0] || ''))
      return ''
    }

    /** 卡片编号：对用户显示成 fx-1、fx-2……；还没落库的草稿没有编号。 */
    function cardSeqLabel(card) {
      const seq = Number(card && card.seq)
      return Number.isInteger(seq) && seq > 0 ? `fx-${seq}` : ''
    }

    /**
     * 同一句话的两个长度：宽列说全（用时 3 分 20 秒），窄列只留一个单位（用时 3 分）。
     * 切换交给脚部的容器查询，不靠 JS 量宽度，所以每秒重绘也不会跳动。
     */
    function shortOrFull(full, short) {
      return [
        h('span', { key: 'full', className: 'fxk-dual-full' }, full),
        h('span', { key: 'short', className: 'fxk-dual-short' }, short),
      ]
    }

    /**
     * 合并状态的颜色 / 文案。状态只陈述观测到的 Git 事实，不参与卡片状态机：
     * 卡片状态仍然是列和圆点，chip 回到「元数据」的位置。
     */
    const MERGE_LABELS = {
      unmerged: { zh: '未合并', en: 'Unmerged' },
      lost: { zh: '未合并，已删', en: 'Unmerged, deleted' },
      merged: { zh: '已合并', en: 'Merged' },
      'merged-gone': { zh: '已合并，已删', en: 'Merged, deleted' },
      empty: { zh: '无改动', en: 'No commits' },
      uncommitted: { zh: '未提交', en: 'Uncommitted' },
      'empty-gone': { zh: '无改动，已删', en: 'No commits, deleted' },
      'unknown-gone': { zh: '已删除，待确认', en: 'Deleted, unknown' },
    }

    /** 持久化的 merge → 展示用的 tone；没有可说的状态就返回 null（退回普通分支 chip）。 */
    function mergeToneOf(merge) {
      if (!merge || typeof merge !== 'object') return null
      const gone = merge.gone === true
      if (merge.state === 'unmerged') return gone ? 'lost' : 'unmerged'
      if (merge.state === 'merged') return gone ? 'merged-gone' : 'merged'
      if (merge.state === 'empty') {
        if (gone) return 'empty-gone'
        // 分支上没有提交，但检出里还有没提交的改动：这才是「无改动」的例外
        return merge.dirty === true ? 'uncommitted' : 'empty'
      }
      if (merge.state === 'unknown' && gone) return 'unknown-gone'
      return null
    }

    /** 点完成前要不要拦一下：分支上还有没合回去的提交，或者检出里还有没提交的改动。 */
    function mergeNeedsAttention(card) {
      const merge = card && card.worktree ? card.worktree.merge : null
      if (!merge || merge.gone === true) return false
      return merge.state === 'unmerged' || merge.dirty === true
    }

    /** 「检出里还有 N 个未提交的改动」；没有计数就退回一句。 */
    function dirtyPhraseOf(merge) {
      const count = Number.isFinite(merge.dirtyCount) && merge.dirtyCount > 0 ? merge.dirtyCount : null
      return count
        ? t(`检出里还有 ${count} 个未提交的改动`, `The checkout has ${count} uncommitted change(s)`)
        : t('检出里还有未提交的改动', 'The checkout has uncommitted changes')
    }

    /** 一句话说清「为什么拦你一下」：用在点完成的确认里。 */
    function mergeSummaryOf(card) {
      const merge = card.worktree.merge
      const branch = card.worktree.branch || t('工作树', 'Worktree')
      const ahead = Number.isFinite(merge.ahead) && merge.ahead > 0 ? merge.ahead : null
      const lines = []
      if (merge.state === 'unmerged') {
        lines.push(
          ahead
            ? t(`分支 ${branch} 上有 ${ahead} 个提交没被任何本地 / 远端分支包含。`, `Branch ${branch} has ${ahead} commit(s) not contained by any local or remote branch.`)
            : t(`分支 ${branch} 的提交没被任何本地 / 远端分支包含。`, `Branch ${branch} has commits not contained by any local or remote branch.`),
        )
      }
      if (merge.dirty === true) {
        lines.push(t(`${dirtyPhraseOf(merge)}——它们不在任何分支上，合并带不过去。`, `${dirtyPhraseOf(merge)} — they are not on any branch and will not be merged.`))
      }
      if (lines.length === 0) {
        lines.push(t(`分支 ${branch} 上的改动还没有合回去。`, `The changes on ${branch} are not merged back yet.`))
      }
      return lines.join(' ')
    }

    /** 复制用的合并命令：只写「在目标分支上执行」，不猜目标分支。 */
    function mergeCommandOf(card) {
      const worktree = card.worktree
      if (!worktree || !worktree.repositoryRoot || !worktree.branch) return ''
      return [
        '# 在项目目录的目标分支上执行（先确认 git status 干净）',
        `git -C ${worktree.repositoryRoot} merge --no-ff ${worktree.branch}`,
      ].join('\n')
    }

    /** 复制用的清理命令：先移除检出（或归档让 DSH 清），再删分支。 */
    function cleanupCommandOf(card) {
      const worktree = card.worktree
      if (!worktree || !worktree.repositoryRoot || !worktree.branch) return ''
      return [
        '# 归档会话会让 DSH 清掉检出；也可以手动移除，然后删分支',
        worktree.path ? `git -C ${worktree.repositoryRoot} worktree remove ${worktree.path}` : null,
        `git -C ${worktree.repositoryRoot} branch -d ${worktree.branch}`,
      ].filter(Boolean).join('\n')
    }

    /** 那枚复制按钮复制哪一段：未合并给合并命令，已合并 / 无提交给清理命令。 */
    function copyCommandKindOf(tone) {
      if (tone === 'unmerged') return 'merge'
      if (tone === 'merged' || tone === 'empty') return 'cleanup'
      return null
    }

    /** chip / 折叠行的 tooltip：分支、合并到哪、有几个提交、什么时候看的、下一步做什么。 */
    function mergeTitleOf(card, merge) {
      const worktree = card.worktree
      const branch = worktree.branch || t('工作树', 'Worktree')
      const lines = [`${t('分支', 'Branch')}：${branch}`]
      const ahead = Number.isFinite(merge.ahead) && merge.ahead > 0 ? merge.ahead : null
      if (merge.state === 'unmerged' && merge.gone) {
        lines.push(
          ahead
            ? t(`分支已删除；最后一次看到它时有 ${ahead} 个提交没被别的分支包含（${formatClock(merge.observedAt)}）。`, `The branch is gone; it last had ${ahead} commit(s) not contained by any other branch (${formatClock(merge.observedAt)}).`)
            : t('分支已删除，最后一次看到它时还没合并。', 'The branch is gone and was last seen unmerged.'),
        )
        lines.push(t('改动可能丢了：在 git reflog、Forge 或 PR 里找找。', 'The changes may be lost — check git reflog, Forge or the PR.'))
      } else if (merge.state === 'unmerged') {
        lines.push(
          ahead
            ? t(`有 ${ahead} 个提交没被任何本地 / 远端分支包含。`, `${ahead} commit(s) are not contained by any local or remote branch.`)
            : t('这个分支的提交没被任何本地 / 远端分支包含。', 'This branch’s commits are not contained by any local or remote branch.'),
        )
        lines.push(t(`合并：在项目目录 git merge ${branch}`, `Merge it: git merge ${branch} in the project root`))
        lines.push(t('提示：squash / rebase 合并可能认不出来。', 'Note: squash or rebase merges may not be detected.'))
      } else if (merge.state === 'merged') {
        lines.push(merge.into ? t(`已并入 ${merge.into}。`, `Already merged into ${merge.into}.`) : t('已经被别的分支包含。', 'Already contained by another branch.'))
        if (merge.gone) lines.push(t('分支已经删除。', 'The branch has been deleted.'))
        else lines.push(t(`可以删掉分支了：git branch -d ${branch}`, `You can delete the branch now: git branch -d ${branch}`))
      } else if (merge.state === 'empty') {
        if (merge.gone) {
          lines.push(t('分支已删除；它本来就没有提交，什么都没丢。', 'The branch is gone; it had no commits, so nothing was lost.'))
        } else {
          lines.push(t('这个分支上没有提交（tip 就是建树时的那个提交）。', 'No commits on this branch — its tip is the commit it was created from.'))
          if (merge.dirty === true) {
            lines.push(t(`${dirtyPhraseOf(merge)}：先提交或复制出来，再删分支。`, `${dirtyPhraseOf(merge)} — commit or copy them before deleting the branch.`))
          } else {
            lines.push(t(`删掉不会丢东西：git branch -d ${branch}`, `Deleting it loses nothing: git branch -d ${branch}`))
          }
        }
      } else {
        lines.push(t('分支已经不在了，看板也没有它合并与否的记录。', 'The branch is gone and the board has no record of a merge.'))
        lines.push(t('分支名不在提交里，删掉之后无从倒推。', 'A branch name is not stored in commits, so it cannot be recovered after deletion.'))
      }
      if (merge.dirty === true && !merge.gone && !(merge.state === 'empty' && !merge.gone)) {
        lines.push(t(`${dirtyPhraseOf(merge)}——它们不在任何分支上，合并带不过去。`, `${dirtyPhraseOf(merge)} — not on any branch, so a merge will not include them.`))
      }
      if (merge.gone) {
        lines.push(t('检出归 DSH 管：归档会话时会清掉检出。', 'The checkout is DSH’s: archiving the conversation removes it.'))
      }
      if (merge.observedAt) lines.push(t(`记录于 ${formatClock(merge.observedAt)}`, `recorded ${formatClock(merge.observedAt)}`))
      const probe = worktree.probe
      if (probe && probe.error) lines.push(t(`暂时检测不到（${probe.error}），显示的是上次结论。`, `Cannot check right now (${probe.error}) — showing the last known state.`))
      return lines.join('\n')
    }

    /**
     * 卡片 / 列表里的工作树 chip：分支图标 + 分支名，有合并观测时补一个状态词。
     * 分支名可以省略，状态词不行（窄）——所以只有名字那一段是可收缩的。
     */
    function worktreeChipOf(card, mergeOn, onCopy) {
      const worktree = card && card.worktree ? card.worktree : null
      if (!worktree) return null
      if (!worktree.path) {
        return worktree.error
          ? h('span', { className: 'fxk-chip fxk-chip-err', title: worktree.error }, t('工作树失败', 'Worktree failed'))
          : null
      }
      const name = worktree.branch || t('工作树', 'Worktree')
      // 只在「已完成」里给结论：待审核的「未合并」是常态，标成琥珀只会让人习惯性忽略
      const tone = mergeOn && card.status === 'done' ? mergeToneOf(worktree.merge) : null
      if (!tone) {
        const title = [worktree.branch, worktree.path].filter(Boolean).join('\n')
        const probe = worktree.probe
        return h(
          'span',
          {
            className: 'fxk-chip fxk-chip-branch',
            title: probe && probe.error ? `${title}\n${t('暂时检测不到合并状态。', 'Merge state is unavailable right now.')}` : title,
          },
          h(IconBranch, { size: 10 }),
          h('span', { className: 'fxk-wt-name' }, name),
        )
      }
      const label = MERGE_LABELS[tone]
      const copyKind = copyCommandKindOf(tone)
      return h(
        'span',
        {
          className: 'fxk-chip fxk-chip-branch fxk-chip-merge',
          'data-merge': tone,
          title: mergeTitleOf(card, worktree.merge),
        },
        h(IconBranch, { size: 10 }),
        h('span', { className: `fxk-wt-name${worktree.merge.gone ? ' is-gone' : ''}` }, name),
        h('span', { className: 'fxk-wt-state' }, `· ${t(label.zh, label.en)}`),
        copyKind && onCopy
          ? h(
              'button',
              {
                type: 'button',
                className: 'fxk-wt-copy',
                title:
                  copyKind === 'merge'
                    ? t('复制合并命令', 'Copy the merge command')
                    : t('复制清理命令（先确认合并完成）', 'Copy the cleanup command (merge first)'),
                'aria-label':
                  copyKind === 'merge'
                    ? t(`复制合并 ${name} 的命令`, `Copy the command that merges ${name}`)
                    : t(`复制清理 ${name} 的命令`, `Copy the command that cleans up ${name}`),
                onClick: (event) => {
                  event.stopPropagation()
                  onCopy(copyKind, card)
                },
              },
              h(IconCopy, { size: 9 }),
            )
          : null,
      )
    }

    function readAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          const index = result.indexOf(',')
          resolve(index >= 0 ? result.slice(index + 1) : result)
        }
        reader.onerror = () => reject(new Error(t('读取文件失败', 'Could not read the file')))
        reader.readAsDataURL(file)
      })
    }

    /** 复制一段短文本：优先异步剪贴板，不行就退回选中复制；都失败返回 false。 */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {}
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    // ----------------------------------------------------------------- panel
    /**
     * 设置页：主体只做一件可编辑的事——点「完成」之后做什么；下面是只读高级信息。
     *
     * 草稿只活在这个组件里；停手 600ms 自动保存，页脚另有显式「保存」。
     * 数据来自 /board 的 settings / advanced，保存走 POST /kanban-fx/settings，
     * 不回写 cordis 配置，所以改完立即生效、不重启插件。
     */
    function SettingsPage(props) {
      const settings = props.settings
      const advanced = props.advanced
      const loading = Boolean(props.loading)
      const error = props.error || ''
      const initial = settings && settings.completion ? settings.completion : { mode: 'none', prompt: '' }
      const [mode, setMode] = useState(initial.mode === 'prompt' ? 'prompt' : 'none')
      const [prompt, setPrompt] = useState(typeof initial.prompt === 'string' ? initial.prompt : '')
      const [phase, setPhase] = useState('idle')
      const [failure, setFailure] = useState('')
      const [savedAt, setSavedAt] = useState(null)
      const modeRef = useRef(mode)
      const promptRef = useRef(prompt)
      const dirtyRef = useRef(false)
      const savingRef = useRef(false)
      const inflightRef = useRef('')
      const queuedRef = useRef(false)
      const timerRef = useRef(null)
      const mountedRef = useRef(true)
      const disabledRef = useRef(false)
      const titleRef = useRef(null)
      const saveRef = useRef(null)

      const promptChars = prompt.trim().length
      const promptError =
        promptChars > PROMPT_MAX_CHARS
          ? t(`提示词最多 ${PROMPT_MAX_CHARS} 字符`, `The prompt is limited to ${PROMPT_MAX_CHARS} characters`)
          : mode === 'prompt' && promptChars === 0
            ? t('写一条提示词后再保存', 'Write a prompt before saving')
            : ''
      const invalid = Boolean(promptError)
      const disabled = Boolean(error)
      disabledRef.current = disabled

      useEffect(() => {
        mountedRef.current = true
        titleRef.current?.focus?.()
        return () => {
          mountedRef.current = false
          if (timerRef.current) clearTimeout(timerRef.current)
          // 切面板 / 关页面时补存一次：合法且有未保存改动才发；失败静默，下次进来还能改。
          const draftMode = modeRef.current
          const draftPrompt = promptRef.current
          const valid =
            draftPrompt.trim().length <= PROMPT_MAX_CHARS &&
            (draftMode !== 'prompt' || Boolean(draftPrompt.trim()))
          if (dirtyRef.current && valid && !disabledRef.current && !savingRef.current) {
            void props.onSave({ mode: draftMode, prompt: draftPrompt.trim() }).catch(() => {})
          }
        }
      }, [])

      // 别的标签页改了设置，或自己保存后的服务端回写：没有本地草稿时静默同步
      useEffect(() => {
        if (dirtyRef.current || savingRef.current) return
        const next = settings && settings.completion ? settings.completion : { mode: 'none', prompt: '' }
        const nextMode = next.mode === 'prompt' ? 'prompt' : 'none'
        const nextPrompt = typeof next.prompt === 'string' ? next.prompt : ''
        if (nextMode === modeRef.current && nextPrompt === promptRef.current) return
        modeRef.current = nextMode
        promptRef.current = nextPrompt
        setMode(nextMode)
        setPrompt(nextPrompt)
        setPhase('idle')
        setFailure('')
      }, [settings])

      const save = async (silent) => {
        if (!mountedRef.current) return false
        const draftMode = modeRef.current
        const draftPrompt = promptRef.current
        // 同一份草稿只允许一个请求在飞：失焦补存 + 点保存常常会前后脚触发
        const draftKey = `${draftMode}\u0000${draftPrompt}`
        if (savingRef.current) {
          if (inflightRef.current !== draftKey) queuedRef.current = true
          return false
        }
        const trimmed = draftPrompt.trim()
        if (trimmed.length > PROMPT_MAX_CHARS) {
          setPhase('invalid')
          setFailure(t(`提示词最多 ${PROMPT_MAX_CHARS} 字符`, `The prompt is limited to ${PROMPT_MAX_CHARS} characters`))
          return false
        }
        if (draftMode === 'prompt' && !trimmed) {
          setPhase('invalid')
          setFailure(t('写一条提示词后再保存', 'Write a prompt before saving'))
          return false
        }
        if (disabled) {
          setPhase('error')
          setFailure(t('看板数据读取失败，暂时不能保存', 'The board could not be loaded, so settings cannot be saved'))
          return false
        }
        savingRef.current = true
        inflightRef.current = draftKey
        if (!silent) setPhase('saving')
        setFailure('')
        try {
          await props.onSave({ mode: draftMode, prompt: trimmed })
          if (modeRef.current === draftMode && promptRef.current === draftPrompt) {
            dirtyRef.current = false
            if (mountedRef.current) {
              setPhase('saved')
              setSavedAt(Date.now())
            }
          }
          return true
        } catch (saveFailure) {
          if (mountedRef.current) {
            setPhase('error')
            setFailure(String(saveFailure?.message ?? saveFailure))
          }
          return false
        } finally {
          savingRef.current = false
          inflightRef.current = ''
          if (queuedRef.current) {
            queuedRef.current = false
            void saveRef.current?.(true)
          }
        }
      }
      saveRef.current = save

      const schedule = () => {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          // 已经通过「保存」落库的草稿不必再自动保存一次
          if (dirtyRef.current) void saveRef.current?.(true)
        }, SETTINGS_SAVE_IDLE_MS)
      }

      const touchDraft = () => {
        dirtyRef.current = true
        setPhase('dirty')
        schedule()
      }

      const changeMode = (next) => {
        const value = next === 'prompt' ? 'prompt' : 'none'
        if (value === modeRef.current) return
        modeRef.current = value
        setMode(value)
        touchDraft()
      }

      const changePrompt = (next) => {
        promptRef.current = next
        setPrompt(next)
        touchDraft()
      }

      const leave = async () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        // 有合法草稿且没有请求在飞：先存，失败就留在设置页看错误，不静默丢内容。
        // 不合法 / 看板读取失败 / 失焦补存已经在飞时允许直接返回，服务端保留上一次有效设置。
        if (dirtyRef.current && !invalid && !disabled && !savingRef.current) {
          const saved = await saveRef.current?.(true)
          if (!saved) return
        }
        props.onBack()
      }

      const copy = async (value) => {
        if (!value) return
        const ok = await copyText(value)
        props.notify?.({ text: ok ? t('已复制', 'Copied') : t('复制失败', 'Copy failed') })
      }

      // 工作树：服务在不在由 DSH 的插件决定，看板只能「提供入口」或「不提供」
      const worktreeAvailable = Boolean(props.capabilities && props.capabilities.worktrees)
      const worktreeOffer = Boolean(settings && settings.worktree && settings.worktree.offer)
      // 没写过这个字段的老设置按「开」算，和 Host 的默认值一致
      const mergeStateOn = !(settings && settings.worktree && settings.worktree.mergeState === false)
      const [worktreeSaving, setWorktreeSaving] = useState(false)
      const [worktreeFailure, setWorktreeFailure] = useState('')
      const [mergeSaving, setMergeSaving] = useState(false)
      const [mergeFailure, setMergeFailure] = useState('')

      // 插件页是全局面板（id 由 ui-plugin-manager 注册，默认组合里一定有）；
      // 用 layout 服务直接切过去，等于侧边栏点「插件」。失败时退回一句人话，不留死链接。
      const openPluginsPage = () => {
        const layout = pluginCtx?.get('layout')
        if (layout && typeof layout.selectPanel === 'function') {
          try {
            layout.selectPanel('plugins')
            return
          } catch (failure) {
            console.error('[kanban-fx] 打开插件页失败：', failure)
          }
        }
        props.notify?.({ text: t('打不开插件页，请从侧边栏的「插件」进入', 'Could not open the plugin page — use “Plugins” in the sidebar') })
      }

      const toggleWorktree = async (next) => {
        setWorktreeSaving(true)
        setWorktreeFailure('')
        try {
          await props.onSaveWorktree({ offer: next })
        } catch (saveFailure) {
          setWorktreeFailure(String(saveFailure?.message ?? saveFailure))
        } finally {
          setWorktreeSaving(false)
        }
      }

      const toggleMergeState = async (next) => {
        setMergeSaving(true)
        setMergeFailure('')
        try {
          await props.onSaveWorktree({ mergeState: next })
        } catch (saveFailure) {
          setMergeFailure(String(saveFailure?.message ?? saveFailure))
        } finally {
          setMergeSaving(false)
        }
      }

      const statusText = disabled
        ? t('看板读取失败，设置暂不可用', 'The board could not be loaded — settings are unavailable')
        : phase === 'saving'
          ? t('保存中…', 'Saving…')
          : phase === 'error'
            ? t('保存失败', 'Save failed')
            : dirtyRef.current
              ? t('有未保存的改动', 'Unsaved changes')
              : savedAt
                ? t(`已保存 ${clockOf(savedAt)}`, `Saved ${clockOf(savedAt)}`)
                : t('自动保存已开启', 'Autosave is on')

      const radio = (value, title, description) =>
        h(
          'label',
          { className: 'fxk-radio', 'data-checked': String(mode === value) },
          h('input', {
            type: 'radio',
            name: 'fxk-completion-mode',
            value,
            checked: mode === value,
            disabled,
            onChange: () => changeMode(value),
          }),
          h('span', { className: 'fxk-radio-dot', 'aria-hidden': 'true' }),
          h(
            'span',
            { className: 'fxk-radio-text' },
            h('span', { className: 'fxk-radio-title' }, title),
            h('span', { className: 'fxk-radio-desc' }, description),
          ),
        )

      const copyButton = (value) =>
        h(
          'button',
          {
            type: 'button',
            className: 'fxk-mini',
            disabled: !value,
            title: t('复制路径', 'Copy path'),
            onClick: () => void copy(value),
          },
          t('复制', 'Copy'),
        )

      const advancedRow = (key, value) =>
        h(
          'div',
          { className: 'fxk-advanced-row' },
          h('span', { className: 'fxk-advanced-key' }, key),
          h('div', { className: 'fxk-advanced-val' }, value),
        )

      const viewLabel = props.view === 'list' ? t('列表', 'List') : t('看板', 'Board')
      const sortColumn = LIST_COLUMNS.find((item) => item.key === props.sort?.key) || LIST_COLUMNS[0]
      const sortLabel = `${t(sortColumn.zh, sortColumn.en)} ${props.sort?.dir === 'desc' ? '↓' : '↑'}`
      const limits = advanced && advanced.limits ? advanced.limits : null
      const showForm = Boolean(settings) || (!loading && !error)

      const settingsTitle = h(
        'h1',
        { className: 'fxk-settings-title', tabIndex: -1, ref: titleRef },
        t('设置', 'Settings'),
      )

      const body = h(
        'div',
        { className: 'fxk-settings-scroll' },
        h(
          'div',
          { className: 'fxk-settings-body' },
          error
            ? h(
                'div',
                { className: 'fxk-settings-errorbar', role: 'alert' },
                h('span', null, error),
                h('button', { type: 'button', className: 'fxk-btn', onClick: props.onRetry }, t('重试', 'Retry')),
              )
            : null,
          loading && !settings
            ? h(
                'section',
                { className: 'fxk-settings-card' },
                h('span', { className: 'fxk-skeleton-bar' }),
                h('div', { className: 'fxk-settings-skeleton-gap' }),
                h('span', { className: 'fxk-skeleton-bar' }),
              )
            : showForm
              ? [
                  h(
                    'section',
                    { key: 'completion', className: 'fxk-settings-card' },
                    h('h2', null, t('完成之后', 'After marking done')),
                    h(
                      'p',
                      { className: 'fxk-settings-desc' },
                      t(
                        '设置点「完成」之后发生什么。对整个看板生效，不分工作区。',
                        'Choose what happens after you mark a card done. Applies to the whole board, across workspaces.',
                      ),
                    ),
                    h(
                      'fieldset',
                      { className: 'fxk-settings-fieldset' },
                      h('legend', { className: 'fxk-sr-only' }, t('点完成之后', 'After marking done')),
                      radio(
                        'none',
                        t('什么都不做（默认）', 'Do nothing (default)'),
                        t('点「完成」立即移入已完成，和现在一样。', 'Moves the card to Done immediately, as before.'),
                      ),
                      radio(
                        'prompt',
                        t('发送一条收尾提示词，跑完自动完成', 'Send a wrap-up prompt, then complete automatically'),
                        t(
                          '先把提示词发给这张卡片的会话；这一轮正常跑完就自动移入已完成。',
                          'Sends the prompt to this card’s conversation first; the card moves to Done when that turn finishes normally.',
                        ),
                      ),
                    ),
                    mode === 'prompt'
                      ? h(
                          'div',
                          { className: 'fxk-settings-field' },
                          h(
                            'label',
                            { className: 'fxk-settings-label', htmlFor: 'fxk-wrap-prompt' },
                            t('收尾提示词', 'Wrap-up prompt'),
                          ),
                          h('textarea', {
                            id: 'fxk-wrap-prompt',
                            className: 'fxk-settings-textarea',
                            value: prompt,
                            rows: 4,
                            disabled,
                            placeholder: t(
                              '例如：把这轮改动补进 CHANGELOG.md，写清改了什么、为什么，然后提交。',
                              'e.g. Add this change to CHANGELOG.md, explain what changed and why, then commit.',
                            ),
                            'aria-invalid': promptError ? 'true' : undefined,
                            'aria-describedby': promptError ? 'fxk-wrap-help fxk-wrap-count fxk-wrap-error' : 'fxk-wrap-help fxk-wrap-count',
                            onChange: (event) => changePrompt(event.target.value),
                            onBlur: () => {
                              if (dirtyRef.current) void saveRef.current?.(true)
                            },
                          }),
                          h(
                            'div',
                            { className: 'fxk-settings-field-foot' },
                            h(
                              'span',
                              { id: 'fxk-wrap-help', className: 'fxk-settings-hint' },
                              t(
                                '会作为一条普通用户消息发进会话，不加前缀。建议写成能一次做完的指令。',
                                'Sent as a normal user message with no prefix. Write it as a single, self-contained instruction.',
                              ),
                            ),
                            h(
                              'span',
                              {
                                id: 'fxk-wrap-count',
                                className: 'fxk-settings-count',
                                'data-over': String(promptChars > PROMPT_MAX_CHARS),
                              },
                              `${promptChars} / ${PROMPT_MAX_CHARS}`,
                            ),
                          ),
                          promptError
                            ? h(
                                'p',
                                { id: 'fxk-wrap-error', className: 'fxk-settings-error', role: 'alert' },
                                promptError,
                              )
                            : null,
                        )
                      : null,
                    h(
                      'p',
                      { className: 'fxk-settings-note' },
                      t(
                        '如果这一轮报错或被中止，卡片会回到待审核，不会标成已完成。',
                        'If the turn fails or is aborted, the card returns to Review instead of being marked done.',
                      ),
                    ),
                  ),
                  h(
                    'section',
                    { key: 'worktree', className: 'fxk-settings-card' },
                    h('h2', null, t('实验功能', 'Experimental')),
                    h(
                      'div',
                      { className: 'fxk-settings-group-head' },
                      h('h3', { className: 'fxk-settings-subhead' }, t('独立工作树入口', 'Worktree entry')),
                      worktreeAvailable
                        ? null
                        : h(
                            'span',
                            { className: 'fxk-settings-group-note' },
                            t('去「', 'Enable “Change requests & worktrees” in '),
                            h(
                              'button',
                              { type: 'button', className: 'fxk-link', onClick: openPluginsPage },
                              t('设置 → 插件', 'Settings → Plugins'),
                            ),
                            t('」启用「变更请求与工作树」', ''),
                          ),
                    ),
                    h(
                      'label',
                      {
                        className: 'fxk-check',
                        'data-checked': String(worktreeOffer),
                        'data-disabled': String(!worktreeAvailable || disabled),
                        title: worktreeAvailable
                          ? undefined
                          : t('先在「设置 → 插件」启用「变更请求与工作树」', 'Enable “Change requests & worktrees” under Settings → Plugins first'),
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: worktreeOffer,
                        disabled: !worktreeAvailable || disabled || worktreeSaving,
                        'aria-labelledby': 'fxk-worktree-offer-title',
                        'aria-describedby': 'fxk-worktree-offer-desc',
                        onChange: (event) => void toggleWorktree(event.target.checked),
                      }),
                      h(
                        'span',
                        { className: 'fxk-check-text' },
                        h(
                          'span',
                          { className: 'fxk-check-title-row' },
                          h(
                            'span',
                            { id: 'fxk-worktree-offer-title', className: 'fxk-check-title' },
                            worktreeSaving
                              ? t('正在保存…', 'Saving…')
                              : t('在卡片上提供「独立工作树」', 'Offer an isolated worktree on cards'),
                          ),
                          worktreeAvailable
                            ? null
                            : h('span', { className: 'fxk-chip fxk-chip-warn' }, t('服务未启用', 'Service not enabled')),
                        ),
                        h(
                          'span',
                          { id: 'fxk-worktree-offer-desc', className: 'fxk-check-desc' },
                          t(
                            '打开后，新建或编辑卡片可以勾选「在独立 worktree 中运行」；创建工作树（分支与检出，在仓库 .agents/worktrees/ 下）、切目录与归档清理都由 DSH 的工作树服务完成。卡片默认不勾。',
                            'When on, new or edited cards can tick “Run in an isolated worktree”; creating the worktree (a branch and checkout under .agents/worktrees/), switching directories, and archive cleanup are all handled by DSH’s worktree service. Cards stay unchecked by default.',
                          ),
                        ),
                      ),
                    ),
                    h('h3', { className: 'fxk-settings-subhead' }, t('工作树卡片的合并状态', 'Merge state for worktree cards')),
                    h(
                      'label',
                      {
                        className: 'fxk-check',
                        'data-checked': String(mergeStateOn),
                        'data-disabled': String(disabled),
                        title: t(
                          '用只读 Git 查分支有没有合并，不 fetch、不改仓库',
                          'Checks merges with read-only Git — no fetch, no repository changes',
                        ),
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: mergeStateOn,
                        disabled: disabled || mergeSaving,
                        'aria-labelledby': 'fxk-merge-state-title',
                        'aria-describedby': 'fxk-merge-state-desc',
                        onChange: (event) => void toggleMergeState(event.target.checked),
                      }),
                      h(
                        'span',
                        { className: 'fxk-check-text' },
                        h(
                          'span',
                          { id: 'fxk-merge-state-title', className: 'fxk-check-title' },
                          mergeSaving
                            ? t('正在保存…', 'Saving…')
                            : t('在已完成列标出分支合并状态', 'Show branch merge state on done cards'),
                        ),
                        h(
                          'span',
                          { id: 'fxk-merge-state-desc', className: 'fxk-check-desc' },
                          t(
                            '每 60 秒用只读 Git 查一次：未合并 / 已合并 / 已合并，已删 / 无改动，折叠行右侧就能看到；只对已经建过工作树的卡片生效，一张都没有时它什么也不做。入口关着或服务未启用也照常工作。squash、rebase 合并可能认不出来。',
                            'Checks once a minute with read-only Git: unmerged / merged / merged-deleted / no commits, shown on the folded done rows. It only affects cards that already have a worktree and does nothing when there are none; it keeps working when the entry is off or the service is not enabled. Squash and rebase merges may not be detected.',
                          ),
                        ),
                        h(
                          'span',
                          { className: 'fxk-check-hint' },
                          t(
                            '↳ 打开时，点「完成」如果这条分支还没合并，会先提醒你一次（「仍然完成 / 先去合并」）；不想被提醒就关掉这个开关。',
                            '↳ When on, marking a card done with an unmerged branch gives one reminder (“Mark done anyway / Merge first”); turn this switch off to skip it.',
                          ),
                        ),
                      ),
                    ),
                    mergeFailure ? h('p', { className: 'fxk-settings-error', role: 'alert' }, mergeFailure) : null,
                    worktreeFailure
                      ? h('p', { className: 'fxk-settings-error', role: 'alert' }, worktreeFailure)
                      : null,
                  ),
                  h(
                    'section',
                    { key: 'advanced', className: 'fxk-settings-card' },
                    h('h2', null, t('高级', 'Advanced')),
                    h(
                      'p',
                      { className: 'fxk-settings-desc' },
                      t('诊断信息与本地界面偏好，只读；不会改动卡片数据。', 'Diagnostics and local interface preferences. Read-only — card data is untouched.'),
                    ),
                    h(
                      'div',
                      { className: 'fxk-advanced' },
                      advancedRow(
                        t('数据目录', 'Data directory'),
                        h(
                          'div',
                          { className: 'fxk-advanced-path' },
                          h('code', { className: 'fxk-path' }, advanced?.dataDir || '—'),
                          copyButton(advanced?.dataDir),
                        ),
                      ),
                      advancedRow(
                        t('数据文件', 'Data file'),
                        h(
                          'div',
                          { className: 'fxk-advanced-path' },
                          h('code', { className: 'fxk-path' }, advanced?.storeFile || '—'),
                          copyButton(advanced?.storeFile),
                        ),
                      ),
                      advancedRow(t('存储版本', 'Storage version'), String(advanced?.storeVersion ?? '—')),
                      advancedRow(
                        t('工作树服务', 'Worktree service'),
                        worktreeAvailable ? t('可用', 'Available') : t('未启用', 'Not enabled'),
                      ),
                      advancedRow(t('卡片总数', 'Cards'), String(props.cardCount ?? 0)),
                      advancedRow(
                        t('正文字符上限', 'Body limit'),
                        limits ? t(`${Number(limits.maxBodyChars).toLocaleString()} 字符`, `${Number(limits.maxBodyChars).toLocaleString()} characters`) : '—',
                      ),
                      advancedRow(
                        t('附件大小上限', 'Attachment limit'),
                        limits ? formatBytes(limits.maxCardAttachmentBytes) : '—',
                      ),
                    ),
                    h(
                      'p',
                      { className: 'fxk-settings-note' },
                      t(
                        '上限与数据目录在 cordis.patch.yml 中修改，重启后生效；这里只显示当前值。',
                        'Limits and the data directory live in cordis.patch.yml and apply after a restart; this page only shows the current values.',
                      ),
                    ),
                    h('div', { className: 'fxk-settings-subhead' }, t('界面偏好（本机）', 'Interface preferences (this browser)')),
                    h(
                      'div',
                      { className: 'fxk-advanced' },
                      advancedRow(t('默认视图', 'Default view'), viewLabel),
                      advancedRow(t('列表排序', 'List sort'), sortLabel),
                      advancedRow(
                        t('恢复默认', 'Reset'),
                        h(
                          'button',
                          { type: 'button', className: 'fxk-mini', onClick: props.onResetView },
                          t('恢复视图与排序默认值', 'Reset view and sort'),
                        ),
                      ),
                    ),
                    h('div', { className: 'fxk-settings-subhead' }, t('关于', 'About')),
                    h(
                      'div',
                      { className: 'fxk-advanced' },
                      advancedRow(t('插件版本', 'Plugin version'), advanced?.version || '—'),
                      advancedRow(t('数据格式版本', 'Data format'), String(advanced?.storeVersion ?? '—')),
                      advancedRow(t('接口前缀', 'API prefix'), h('code', { className: 'fxk-path' }, API)),
                    ),
                  ),
                ]
              : null,
        ),
      )

      // 保存状态 / 按钮固定在页脚，不跟着 advanced 一起滚到屏幕外
      const actions = showForm
        ? h(
            'div',
            { className: 'fxk-settings-actions' },
            h(
              'div',
              { className: 'fxk-settings-status-wrap' },
              h('span', { className: 'fxk-settings-status', role: 'status', 'aria-live': 'polite' }, statusText),
              phase === 'error' && failure
                ? h('p', { className: 'fxk-settings-error', role: 'alert' }, failure)
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'fxk-btn fxk-btn-primary fxk-settings-save',
                disabled: disabled || invalid || phase === 'saving' || !dirtyRef.current,
                onClick: () => void saveRef.current?.(),
              },
              phase === 'saving' ? t('保存中…', 'Saving…') : t('保存', 'Save'),
            ),
          )
        : null

      return h(
        'div',
        { className: 'fxk-settings' },
        h(
          'header',
          { className: 'fxk-settings-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'fxk-back',
              'aria-label': t('返回任务看板', 'Back to the task board'),
              title: t('返回任务看板', 'Back to the task board'),
              onClick: () => void leave(),
            },
            h('span', { className: 'fxk-back-arrow', 'aria-hidden': 'true' }, '←'),
            h('span', { className: 'fxk-back-label' }, t('返回', 'Back')),
          ),
          settingsTitle,
          h('span', { className: 'fxk-head-spacer' }),
          h('span', { className: 'fxk-settings-sub' }, t('任务看板', 'Task board')),
        ),
        body,
        actions,
      )
    }

    function Panel() {
      const [board, setBoard] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [pickedWorkspaceId, setPickedWorkspaceId] = useState(readViewWorkspace)
      const [narrowCol, setNarrowCol] = useState('todo')
      const [view, setView] = useState(readViewMode)
      const [sort, setSort] = useState(readSortState)
      const [modal, setModal] = useState(null)
      const [busy, setBusy] = useState('')
      const [toast, setToast] = useState(null)
      // 设置页是面板里的第三块内容，不写 localStorage：刷新后回到看板 / 列表
      const [settingsOpen, setSettingsOpen] = useState(false)
      // 「已完成」列默认折叠成标题行；只有用户点开的那几张会展开，状态只活在这个面板里。
      const [expandedDone, setExpandedDone] = useState(() => new Set())
      // 点完成时的「这条分支还没合并」确认：{ card }
      const [doneConfirm, setDoneConfirm] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const skewRef = useRef(0)

      const applyBoard = useCallback((payload) => {
        if (!payload || payload.ok !== true) return
        skewRef.current = Date.now() - Number(payload.serverNow || Date.now())
        setBoard({
          cards: Array.isArray(payload.cards) ? payload.cards : [],
          workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
          defaultWorkspaceId: payload.defaultWorkspaceId || null,
          // 设置跟着看板一起读：SSE 一推 rev，设置页和卡片 tooltip 都自动同步
          settings: payload.settings && payload.settings.completion ? payload.settings : null,
          advanced: payload.advanced && typeof payload.advanced === 'object' ? payload.advanced : null,
        })
        setError('')
      }, [])

      const load = useCallback(
        async (options) => {
          try {
            const response = await fetch(`${API}/board`, { cache: 'no-store' })
            if (!response.ok) throw new Error(t(`看板读取失败（${response.status}）`, `Could not read the board (${response.status})`))
            const payload = await response.json()
            if (!payload || payload.ok !== true) throw new Error(payload?.error || t('看板读取失败', 'Could not read the board'))
            applyBoard(payload)
            if (options && options.quiet !== true) setError('')
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setLoading(false)
          }
        },
        [applyBoard],
      )

      const post = useCallback(
        async (action, payload, options) => {
          const body = await postCardAction(action, payload)
          applyBoard(body)
          if (!(options && options.silent)) setError('')
          return body
        },
        [applyBoard],
      )

      /** 保存「完成之后」。响应是完整看板载荷，复用 applyBoard，所有标签页跟着 rev 同步。 */
      const saveSettings = useCallback(
        async (completion) => {
          const response = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: { completion } }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error(
              (payload && payload.error) ||
                t(`设置保存失败（${response.status}）`, `Could not save settings (${response.status})`),
            )
          }
          applyBoard(payload)
          setError('')
          return payload
        },
        [applyBoard],
      )

      /** 保存「实验功能」里的工作树入口开关；只发这一段，服务端按当前值合并。 */
      const saveWorktree = useCallback(
        async (patch) => {
          // 只发这一段，服务端按当前值合并；开关之间互不覆盖
          const worktree = {}
          if (patch && typeof patch.offer === 'boolean') worktree.offer = patch.offer
          if (patch && typeof patch.mergeState === 'boolean') worktree.mergeState = patch.mergeState
          const response = await fetch(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: { worktree } }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok !== true) {
            throw new Error(
              (payload && payload.error) ||
                t(`设置保存失败（${response.status}）`, `Could not save settings (${response.status})`),
            )
          }
          applyBoard(payload)
          setError('')
          return payload
        },
        [applyBoard],
      )

      // 首屏 + 变化推送
      useEffect(() => {
        void load()
        let source = null
        let lastFrameAt = Date.now()
        let disposed = false
        /** 重建订阅：网络断开 EventSource 会自己重连，但 429 / 非 200 之后按规范不再重连。 */
        const connect = () => {
          try {
            source = new EventSource(`${API}/events`)
          } catch (failure) {
            source = null
            console.error('[kanban-fx] 变化订阅不可用：', failure)
            return
          }
          source.addEventListener('rev', () => {
            lastFrameAt = Date.now()
            void load({ quiet: true })
          })
          // 心跳帧只说明通道还活着，不改任何状态
          source.addEventListener('beat', () => {
            lastFrameAt = Date.now()
          })
        }
        connect()
        // 看门狗：心跳 25 秒一次，70 秒一帧都没有就当通道已经半死，重建订阅并补读一次
        const watchdog = setInterval(() => {
          if (disposed || Date.now() - lastFrameAt < 70_000) return
          lastFrameAt = Date.now()
          try {
            if (source) source.close()
          } catch {}
          connect()
          void load({ quiet: true })
        }, 15_000)
        const fallback = setInterval(() => void load({ quiet: true }), 15_000)
        // 回到前台就读一次。focus 在切标签页 / iframe 里不一定触发，用 visibilitychange 兜住；
        // 手动刷新按钮去掉后，这两条就是「回到页面立刻看到新数据」的兜底。
        const onFocus = () => void load({ quiet: true })
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load({ quiet: true })
        }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          disposed = true
          try {
            if (source) source.close()
          } catch {}
          clearInterval(watchdog)
          clearInterval(fallback)
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      const cards = board ? board.cards : []
      const workspaces = board ? board.workspaces : []
      // 「完成」按钮的 tooltip 跟着设置走：prompt 模式下它先发提示词，不是立刻完成
      const completionMode = board && board.settings && board.settings.completion ? board.settings.completion.mode : 'none'
      // 合并状态开关：关掉后卡片只显示分支名（Host 也不再探测）
      const mergeStateOn = Boolean(
        board && board.settings && board.settings.worktree && board.settings.worktree.mergeState !== false,
      )

      /** 已完成折叠行右侧的结论：没有可说的状态就不出现，别让 Done 列挂满灰 chip。 */
      const foldedMergeOf = (card) => {
        if (!mergeStateOn) return null
        const merge = card.worktree ? card.worktree.merge : null
        const tone = mergeToneOf(merge)
        if (!tone) return null
        const label = MERGE_LABELS[tone]
        return h(
          'span',
          {
            className: 'fxk-wt-folded',
            'data-merge': tone,
            title: mergeTitleOf(card, merge),
          },
          h(IconBranch, { size: 10 }),
          h('span', { className: 'fxk-wt-folded-text' }, t(label.zh, label.en)),
        )
      }
      const workspaceIds = workspaces.map((workspace) => workspace.id)
      const orphanCards = cards.filter((card) => !card.workspaceId)
      const missingCards = cards.filter((card) => card.workspaceId && !workspaceIds.includes(card.workspaceId))
      // 服务端兜底：defaultWorkspaceId 就是校验过的 lastWorkspaceId（不在列表里就退回第一个）
      const fallbackWorkspaceId =
        board && board.defaultWorkspaceId && workspaceIds.includes(board.defaultWorkspaceId)
          ? board.defaultWorkspaceId
          : (workspaceIds[0] || '')
      // 「全部工作区」只在真的不止一个工作区时出现：只有一个时它和那个工作区完全等价，
      // 多一个状态只是噪音；工作区被删到只剩一个时，这条会把它自动收掉。
      const allSelectable = workspaces.length >= 2
      const activeWorkspaceId = resolveViewWorkspace({
        picked: pickedWorkspaceId,
        workspaceIds,
        fallbackId: fallbackWorkspaceId,
        hasOrphan: orphanCards.length > 0,
        hasMissing: missingCards.length > 0,
      })
      // 新建卡片必须落到一个真实工作区：视图停在异常抽屉时退回服务端默认值。
      // 「全部工作区」不同——那里没有「当前工作区」，交给编辑器要求用户显式选一个，
      // 免得把卡片静默归到某个仓库下。
      const currentWorkspaceId = workspaceIds.includes(activeWorkspaceId)
        ? activeWorkspaceId
        : activeWorkspaceId === BUCKET_ALL
          ? ''
          : fallbackWorkspaceId
      const running = cards.some((card) => card.status === 'running')

      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [running])

      useEffect(() => {
        setNow(Date.now())
      }, [board])

      const workspaceTitle = useCallback(
        (workspaceId) => {
          if (!workspaceId) return ''
          const found = (board ? board.workspaces : []).find((workspace) => workspace.id === workspaceId)
          return found ? found.title : ''
        },
        [board],
      )

      const notify = useCallback((next) => {
        setToast(next ? { kind: 'info', ...next, at: Date.now() } : null)
      }, [])

      /** 高级区「恢复视图与排序默认值」：只清本地界面偏好，不碰工作区记忆和卡片数据。 */
      const resetViewPrefs = useCallback(() => {
        try {
          window.localStorage.removeItem(VIEW_MODE_KEY)
          window.localStorage.removeItem(SORT_STATE_KEY)
        } catch {}
        setView('board')
        setSort({ ...DEFAULT_SORT })
        notify({ text: t('已恢复默认视图与排序', 'Default view and sort restored') })
      }, [notify])

      // 从会话标题栏点「完成」跳回来时，接住那条提示。
      // done 带撤销；finishing 只是「提示词发出去了」，没有可撤销的东西。
      useEffect(() => {
        const notice = pendingBoardNotice
        if (!notice) return
        pendingBoardNotice = null
        const label = notice.seq ? `fx-${notice.seq}` : notice.title || t('这张卡片', 'the card')
        const undo = () => {
          void post('undone', { id: notice.cardId }).catch((failure) => notify({ kind: 'error', text: String(failure?.message ?? failure) }))
        }
        if (notice.outcome === 'finishing') {
          notify({
            text: t(
              `已发送 ${label} 的收尾提示词，跑完自动完成`,
              `Sent the wrap-up prompt for ${label}; it will complete automatically.`,
            ),
          })
          return
        }
        if (notice.outcome === 'fallback-done') {
          notify({
            text: t(
              `会话不可用，已直接完成 ${label}（收尾提示词未发送）`,
              `Conversation unavailable — ${label} was marked done without the wrap-up prompt.`,
            ),
            undo,
          })
          return
        }
        notify({ text: t(`已把 ${label} 移到已完成`, `Moved ${label} to done`), undo })
      }, [notify, post])

      const openCreate = useCallback(() => setModal({ mode: 'create', card: null }), [])

      const gearRef = useRef(null)
      const closeSettings = useCallback(() => {
        setSettingsOpen(false)
        // 返回后把焦点放回齿轮，键盘用户不会掉到页面开头
        window.setTimeout(() => gearRef.current?.focus?.(), 0)
      }, [])

      /** 切换看板视图的工作区，并记住这个选择（只写浏览器本地，不碰服务端）。 */
      const selectWorkspace = useCallback((next) => {
        setPickedWorkspaceId(next)
        persistViewWorkspace(next)
      }, [])

      // 工作区「…」菜单 / 会话页「✓ 完成」要求面板切到某个工作区：面板没重挂时靠这条。
      useEffect(() => {
        const listener = (workspaceId) => selectWorkspace(workspaceId)
        viewWorkspaceListeners.add(listener)
        return () => {
          viewWorkspaceListeners.delete(listener)
        }
      }, [selectWorkspace])

      /** 看板 / 列表：只换内容区，头部和工作区选择保持不变。 */
      const selectView = useCallback((next) => {
        if (!VIEW_MODES.includes(next)) return
        setView(next)
        persistViewMode(next)
      }, [])

      /** 表头点击：没在排序的列用它的自然方向，当前列再点一次翻转。 */
      const toggleSort = useCallback(
        (key) => {
          const column = LIST_COLUMNS.find((item) => item.key === key && item.sortable)
          if (!column) return
          const next =
            sort.key === key
              ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: column.dir }
          setSort(next)
          persistSortState(next)
        },
        [sort],
      )

      /** 卡片落库到别的工作区时把视图跟过去，避免「新建完却看不见」。 */
      const handleSaved = useCallback(
        (saved) => {
          if (!saved || !saved.workspaceId) return
          // 「全部工作区」里哪张卡都看得见，不需要跟：跟过去会让人在全局视图里建第二张卡时
          // 被自动保存一路踢到某个工作区去。
          if (activeWorkspaceId === BUCKET_ALL) return
          if (saved.workspaceId === activeWorkspaceId) return
          selectWorkspace(saved.workspaceId)
        },
        [activeWorkspaceId, selectWorkspace],
      )

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), toast.undo ? 8000 : 4600)
        return () => clearTimeout(timer)
      }, [toast])

      useEffect(() => {
        if (!doneConfirm) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setDoneConfirm(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [doneConfirm])

      const runCard = useCallback(
        async (card) => {
          setBusy(`run:${card.id}`)
          try {
            await post('run', { id: card.id })
            notify({ text: t('已开始执行，卡片进入进行中', 'Started — the card is now running') })
          } catch (failure) {
            notify({ kind: 'error', text: String(failure?.message ?? failure) })
          } finally {
            setBusy('')
          }
        },
        [post, notify],
      )

      /** 复制「合并 / 清理」命令：只写剪贴板，不动仓库。 */
      const copyMergeCommand = useCallback(
        async (kind, card) => {
          const text = kind === 'cleanup' ? cleanupCommandOf(card) : mergeCommandOf(card)
          if (!text) return
          const ok = await copyText(text)
          notify({
            text: ok
              ? kind === 'cleanup'
                ? t('已复制清理命令（先确认合并完成）', 'Cleanup command copied — confirm the merge first')
                : t('已复制合并命令', 'Merge command copied')
              : t('复制失败，请手动选中', 'Copy failed — select it manually'),
          })
        },
        [notify],
      )

      /** 让卡片自己的会话去合并：插件只发消息，Git 写操作交给模型与沙箱。 */
      const askSessionToMerge = useCallback(
        async (card) => {
          setBusy(`merge:${card.id}`)
          setDoneConfirm(null)
          try {
            await post('merge', { id: card.id })
            notify({
              text: t(
                '已让会话去合并，这一轮会重新跑；跑完会回到待审核',
                'Asked the conversation to merge — it is running again and returns to review',
              ),
            })
          } catch (failure) {
            notify({ kind: 'error', text: String(failure?.message ?? failure) })
          } finally {
            setBusy('')
          }
        },
        [post, notify],
      )

      /** 真的去标完成；点完成前的确认也走这里。 */
      const performDone = useCallback(
        async (card) => {
          setBusy(`done:${card.id}`)
          try {
            const body = await post('done', { id: card.id })
            const undo = () => {
              void post('undone', { id: card.id }).catch((failure) => notify({ kind: 'error', text: String(failure?.message ?? failure) }))
            }
            if (body.completionResult === 'sent') {
              notify({
                text: t('已发送收尾提示词，跑完自动完成', 'Sent the wrap-up prompt — the card will complete when it finishes'),
              })
            } else if (body.completionResult === 'fallback-done') {
              notify({
                text: t(
                  '会话不可用，已直接标记完成（收尾提示词未发送）',
                  'Conversation unavailable — marked done without the wrap-up prompt',
                ),
                undo,
              })
            } else {
              notify({ text: t('已移入已完成', 'Moved to done'), undo })
            }
          } catch (failure) {
            notify({ kind: 'error', text: String(failure?.message ?? failure) })
          } finally {
            setBusy('')
          }
        },
        [post, notify],
      )

      /**
       * 点「完成」：分支上还有没合并的提交时先问一句。
       * 看完板的人很容易把「标记完成」当成「已经合进去了」，其实 Done 列只是记录事实。
       */
      const markDone = useCallback(
        (card) => {
          if (mergeStateOn && mergeNeedsAttention(card)) {
            setDoneConfirm({ card })
            return
          }
          void performDone(card)
        },
        [mergeStateOn, performDone],
      )

      const markUndone = useCallback(
        async (card) => {
          setBusy(`undone:${card.id}`)
          try {
            await post('undone', { id: card.id })
            notify({ text: t('已撤销完成，回到待审核', 'Undone — back to review') })
          } catch (failure) {
            notify({ kind: 'error', text: String(failure?.message ?? failure) })
          } finally {
            setBusy('')
          }
        },
        [post, notify],
      )

      const openCard = useCallback(
        (card) => {
          // 建了会话但一次都没真的跑起来（投递 / 建工作树失败）：回到编辑，让人能改完重试
          if (!card.sessionId || !card.lastRunStartedAt) {
            setModal({ mode: 'edit', card })
            return
          }
          if (card.sessionArchived) {
            notify({ kind: 'error', text: t('这个会话已被归档。点卡片上的「重新执行」可以开一个新会话。', 'That conversation is archived. Use “Run again” on the card to start a new one.') })
            return
          }
          const uiWorkspace = pluginCtx?.get('uiWorkspace')
          if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
            notify({ kind: 'error', text: t('当前 DSH 版本无法打开会话', 'This DSH version cannot open conversations') })
            return
          }
          try {
            uiWorkspace.openSession(card.sessionId)
          } catch (failure) {
            notify({ kind: 'error', text: String(failure?.message ?? failure) })
          }
        },
        [notify],
      )

      /** 已完成卡片：点标题展开成完整卡片，再点标题旁的箭头折回去。 */
      const toggleDoneExpanded = useCallback((cardId) => {
        setExpandedDone((previous) => {
          const next = new Set(previous)
          if (next.has(cardId)) next.delete(cardId)
          else next.add(cardId)
          return next
        })
      }, [])

      const visibleCards = useMemo(
        () => filterVisibleCards({ cards, workspaceId: activeWorkspaceId, workspaceIds }),
        [cards, activeWorkspaceId, board],
      )

      const byColumn = useMemo(() => {
        const groups = { todo: [], running: [], review: [], done: [] }
        for (const card of visibleCards) {
          const key = groups[card.status] ? card.status : 'todo'
          groups[key].push(card)
        }
        groups.running.sort(
          (a, b) =>
            // 球在用户这边的卡片排最前：它们才是堵住进度的
            Number(Boolean(b.awaiting)) - Number(Boolean(a.awaiting)) || (a.runningSince || 0) - (b.runningSince || 0),
        )
        groups.review.sort((a, b) => (b.lastRunEndedAt || 0) - (a.lastRunEndedAt || 0))
        groups.done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
        groups.todo.sort((a, b) => a.createdAt - b.createdAt)
        return groups
      }, [visibleCards])

      const totals = useMemo(
        () => ({
          todo: byColumn.todo.length,
          running: byColumn.running.length,
          review: byColumn.review.length,
          done: byColumn.done.length,
        }),
        [byColumn],
      )

      // 列表是平铺的：工作区过滤后整体排序，不再按状态分组。
      // 进行中按用时排序时，now 每秒会推着行微调；其余排序不受影响（值没变）。
      const sortedCards = useMemo(
        () => [...visibleCards].sort((left, right) => compareListCards(left, right, sort, now, skewRef.current)),
        [visibleCards, sort, now],
      )

      const elapsedOf = (card) => {
        if (!card.runningSince) return 0
        return Math.max(0, now - skewRef.current - card.runningSince)
      }

      // 「等你回答」的计时：助手挂起在问句 / 权限确认上，这一轮还开着，但用户关心的是已经等了多久。
      const awaitElapsedOf = (card) => {
        if (!card.awaitingSince) return 0
        return Math.max(0, now - skewRef.current - card.awaitingSince)
      }

      /**
       * 「全部工作区」里卡片上的工作区 chip。
       * 只有这个视图需要它：其它视图里每张卡的工作区都一样，信息恒等于顶栏那个选择。
       * 它本身是按钮——点一下就把看板收窄到那个工作区，不用再回顶栏找。
       */
      const workspaceChipOf = (card, className) => {
        const name = workspaceTitle(card.workspaceId)
        if (activeWorkspaceId !== BUCKET_ALL || !name) return null
        return h(
          'button',
          {
            type: 'button',
            className: className ? `fxk-chip fxk-chip-ws ${className}` : 'fxk-chip fxk-chip-ws',
            title: t(`只看「${name}」`, `Show only “${name}”`),
            'aria-label': t(`只看工作区「${name}」`, `Show only workspace “${name}”`),
            onClick: (event) => {
              // chip 长在整张卡（role=button）里面：别让点它变成打开会话
              event.stopPropagation()
              selectWorkspace(card.workspaceId)
            },
          },
          name,
        )
      }

      /**
       * 卡片编号 chip（`fx-12`）：卡片自己的身份，看板卡片和列表都靠它说话。
       * 它本身是按钮——点一下复制，方便在会话里直接说「处理 fx-12」；
       * 没落库的草稿没有编号，返回 null（chip 行照旧渲染，高度不变）。
       *
       * 已经有检出的卡片不重复这一枚：旁边的分支 chip 本身就写着 `⎇ fx-12-…`，
       * 数就在开头；多一枚只会把 chip 行挤到第二行。建树失败（有分支名但没检出目录）
       * 的卡片只剩「工作树失败」，编号照旧补上。
       */
      const seqChipOf = (card) => {
        const label = cardSeqLabel(card)
        if (!label) return null
        const worktree = card.worktree
        if (worktree && worktree.path && worktree.branch) return null
        return h(
          'button',
          {
            type: 'button',
            className: 'fxk-chip fxk-chip-seq',
            title: t(`卡片编号 ${label}，点一下复制`, `Card number ${label} — click to copy`),
            'aria-label': t(`复制卡片编号 ${label}`, `Copy card number ${label}`),
            onClick: (event) => {
              // chip 长在整张卡（role=button）里面：别让点它变成打开会话
              event.stopPropagation()
              void copyText(label).then((ok) => {
                notify({
                  text: ok
                    ? t(`已复制编号 ${label}`, `Copied ${label}`)
                    : t(`复制失败，编号 ${label}`, `Copy failed — ${label}`),
                })
              })
            },
          },
          label,
        )
      }

      const renderCard = (card) => {
        const state = card.status
        const isDone = state === 'done'
        const isFolded = isDone && !expandedDone.has(card.id)
        const title = workspaceTitle(card.workspaceId)
        const attachmentCount = (card.attachments || []).length
        // 卡片中段那一行 chip。可能一个都没有（普通卡 + 关了合并状态）：这一行照样渲染、只留空，
        // 高度由 CSS 的 min-height 钉成一行 chip——卡片尺寸不随 chip 增减变化，
        // 切到「全部工作区」（多出工作区胶囊）时也不会跳。
        const metaChips = [
          seqChipOf(card),
          workspaceChipOf(card),
          card.workspaceId && !title ? h('span', { className: 'fxk-chip fxk-chip-warn' }, t('工作区不可用', 'Workspace missing')) : null,
          worktreeChipOf(card, mergeStateOn, copyMergeCommand),
          attachmentCount ? h('span', { className: 'fxk-chip', title: t('附件', 'Attachments') }, `📎 ${attachmentCount}`) : null,
          card.sessionArchived
            ? h('span', { className: 'fxk-chip fxk-chip-warn', title: t('会话已归档', 'Conversation archived') }, t('会话已归档', 'Archived'))
            : null,
          card.error ? h('span', { className: 'fxk-chip fxk-chip-err', title: card.error }, t('有报错', 'Error')) : null,
        ].filter(Boolean)

        // 已完成列默认只留标题行：整行点开才展开成完整卡片，避免已归档的卡片一直占满一整列。
        if (isFolded) {
          // 折叠行也带上编号：一整列已完成里，只有编号能和你记的那张对上
          const foldedLabel = cardSeqLabel(card)
          return h(
            'div',
            {
              key: card.id,
              className: 'fxk-card fxk-card-folded',
              'data-state': state,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': 'false',
              'aria-label': t(`${card.title}（已折叠，点击展开）`, `${card.title} (collapsed, click to expand)`),
              title: t('点击展开', 'Click to expand'),
              onClick: () => toggleDoneExpanded(card.id),
              onKeyDown: (event) => {
                // 整行是 role=button；内部按钮（展开后的折叠箭头等）自己处理键盘，不再冒泡触发整卡。
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleDoneExpanded(card.id)
                }
              },
            },
            h('span', { className: 'fxk-caret', 'aria-hidden': 'true' }),
            foldedLabel ? h('span', { className: 'fxk-folded-seq' }, foldedLabel) : null,
            h('span', { className: 'fxk-card-title fxk-card-title-folded' }, card.title),
            workspaceChipOf(card, 'fxk-ws-folded'),
            foldedMergeOf(card),
          )
        }

        const titleNode = isDone
          ? h(
              'div',
              { className: 'fxk-card-title-row' },
              h('div', { className: 'fxk-card-title' }, card.title),
              h(
                'button',
                {
                  type: 'button',
                  className: 'fxk-card-collapse',
                  'aria-expanded': 'true',
                  'aria-label': t('折叠这张卡片', 'Collapse this card'),
                  title: t('折叠', 'Collapse'),
                  onClick: (event) => {
                    event.stopPropagation()
                    toggleDoneExpanded(card.id)
                  },
                },
                h('span', { className: 'fxk-caret fxk-caret-open', 'aria-hidden': 'true' }),
              ),
            )
          : h('div', { className: 'fxk-card-title' }, card.title)

        return h(
          'div',
          {
            key: card.id,
            className: isDone ? 'fxk-card fxk-card-expanded' : 'fxk-card',
            'data-state': state,
            role: 'button',
            tabIndex: 0,
            'aria-label': card.finishing
              ? t(`${card.title}（收尾中）`, `${card.title} (wrapping up)`)
              : card.awaiting
                ? t(`${card.title}（等你回答）`, `${card.title} (waiting for you)`)
                : card.title,
            onClick: () => openCard(card),
            onKeyDown: (event) => {
              // 内部按钮（折叠箭头 / 撤销 / 执行）自己处理键盘，不再冒泡触发「打开会话」。
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openCard(card)
              }
            },
          },
          titleNode,
          card.body ? h('div', { className: 'fxk-card-excerpt' }, excerptOf(card.body)) : null,
          h('div', { className: 'fxk-card-meta' }, ...metaChips),
          state === 'running'
            ? h(
                'div',
                { className: 'fxk-card-foot' },
                card.preparing
                  ? h(
                      'span',
                      {
                        className: 'fxk-timer',
                        title: t(
                          '正在新建分支与检出，建好之后才开始跑这一轮',
                          'Creating the branch and checkout; the run starts when it finishes',
                        ),
                      },
                      h('span', { className: 'fxk-pulse' }),
                      h('span', { className: 'fxk-finishing-label' }, t('准备工作树…', 'preparing worktree')),
                    )
                  : card.awaiting
                    ? h(
                        'span',
                        {
                          className: 'fxk-timer fxk-timer-awaiting',
                          title: t(
                            '助手在会话里等你回话，回答后这一轮原地继续；这段时间不算任务用时',
                            'The agent is waiting for your reply and continues where it left off; this wait is not counted as run time',
                          ),
                        },
                        h('span', { className: 'fxk-await-dot' }),
                        h('b', null, formatElapsed(awaitElapsedOf(card))),
                        h('span', { className: 'fxk-awaiting-label' }, t('等你回答', 'waiting')),
                      )
                    : h(
                        'span',
                        {
                          className: 'fxk-timer',
                          title: card.finishing
                            ? t('收尾提示词正在跑，跑完自动完成', 'The wrap-up prompt is running; the card completes automatically')
                            : undefined,
                        },
                        h('span', { className: 'fxk-pulse' }),
                        h('b', null, formatElapsed(elapsedOf(card))),
                        h('span', { className: card.finishing ? 'fxk-finishing-label' : undefined }, card.finishing ? t('收尾中', 'wrapping up') : t('运行中', 'running')),
                      ),
                card.lastRunStartedAt
                  ? h(
                      'span',
                      { className: 'fxk-hint fxk-foot-since', 'data-locale': isZh() ? 'zh' : 'en' },
                      t(`开始于 ${formatClock(card.lastRunStartedAt)}`, `since ${formatClock(card.lastRunStartedAt)}`),
                    )
                  : null,
              )
            : state === 'review'
              ? h(
                  'div',
                  { className: 'fxk-card-foot' },
                  h(
                    'span',
                    { className: 'fxk-hint' },
                    card.lastRunMs
                      ? shortOrFull(
                          t(`用时 ${formatDuration(card.lastRunMs)}`, `took ${formatDuration(card.lastRunMs)}`),
                          t(`用时 ${formatDurationShort(card.lastRunMs)}`, `took ${formatDurationShort(card.lastRunMs)}`),
                        )
                      : shortOrFull(t('已跑完，待你查看', 'Run finished'), t('已跑完', 'Finished')),
                  ),
                  card.sessionArchived
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'fxk-mini fxk-mini-run',
                          disabled: busy === `run:${card.id}`,
                          onClick: (event) => {
                            event.stopPropagation()
                            void runCard(card)
                          },
                        },
                        '▶ ',
                        t('重新执行', 'Run again'),
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'fxk-mini fxk-mini-ok',
                      title:
                        completionMode === 'prompt'
                          ? t('标记完成，并先发送收尾提示词', 'Mark done and send the wrap-up prompt first')
                          : t('标记为已完成，移入已完成列', 'Mark as done and move to the Done column'),
                      disabled: busy === `done:${card.id}`,
                      onClick: (event) => {
                        event.stopPropagation()
                        void markDone(card)
                      },
                    },
                    '✓ ',
                    t('完成', 'Mark done'),
                  ),
                )
              : state === 'done'
                ? h(
                    'div',
                    { className: 'fxk-card-foot' },
                    h(
                      'span',
                      { className: 'fxk-hint' },
                      card.doneAt
                        ? shortOrFull(
                            t(`完成于 ${formatClock(card.doneAt)}`, `done ${formatClock(card.doneAt)}`),
                            t(`完成于 ${formatClockShort(card.doneAt)}`, `done ${formatClockShort(card.doneAt)}`),
                          )
                        : t('已完成', 'Done'),
                    ),
                    card.sessionArchived
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'fxk-mini fxk-mini-run',
                            disabled: busy === `run:${card.id}`,
                            onClick: (event) => {
                              event.stopPropagation()
                              void runCard(card)
                            },
                          },
                          '▶ ',
                          t('重新执行', 'Run again'),
                        )
                      : null,
                    mergeStateOn && mergeNeedsAttention(card) && card.sessionId && !card.sessionArchived
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'fxk-mini',
                            disabled: busy === `merge:${card.id}`,
                            title: t(
                              '让这一轮的会话把分支合并回主分支并清理（会重新打开这一轮）',
                              'Ask this card’s conversation to merge the branch and clean up (it reopens this turn)',
                            ),
                            onClick: (event) => {
                              event.stopPropagation()
                              void askSessionToMerge(card)
                            },
                          },
                          t('合并', 'Merge'),
                        )
                      : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'fxk-mini',
                        disabled: busy === `undone:${card.id}`,
                        onClick: (event) => {
                          event.stopPropagation()
                          void markUndone(card)
                        },
                      },
                      '↩ ',
                      t('撤销', 'Undo'),
                    ),
                  )
                : h(
                    'div',
                    { className: 'fxk-card-foot' },
                    h('span', { className: 'fxk-hint' }, t('还没开始', 'Not started')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'fxk-mini fxk-mini-run',
                        disabled: busy === `run:${card.id}`,
                        onClick: (event) => {
                          event.stopPropagation()
                          void runCard(card)
                        },
                      },
                      '▶ ',
                      t('执行', 'Run'),
                    ),
                  ),
        )
      }

      const renderColumn = (column) => {
        const items = byColumn[column.id] || []
        const isTodo = column.id === 'todo'
        // 进行中列头补一句「N 张等你回答」：卡片已经排到最前，这里再给一个一眼能看到的数
        const awaitingCount = column.id === 'running' ? items.filter((card) => card.awaiting).length : 0
        // 已完成列头补一句「N 未合并」：默认折叠的列表里，这是唯一一眼能看到的线索
        const mergeTones = column.id === 'done' && mergeStateOn
          ? items.map((card) => mergeToneOf(card.worktree && card.worktree.merge))
          : []
        const mergePending = mergeTones.filter((tone) => tone === 'unmerged' || tone === 'lost').length
        const mergeLost = mergeTones.filter((tone) => tone === 'lost').length
        return h(
          'section',
          { key: column.id, className: 'fxk-col', 'data-state': column.id, 'aria-label': isZh() ? column.zh : column.en },
          h(
            'header',
            { className: 'fxk-col-head' },
            h('span', { className: 'fxk-col-dot' }),
            h('span', { className: 'fxk-col-name' }, isZh() ? column.zh : column.en),
            mergePending > 0
              ? h(
                  'span',
                  {
                    className: 'fxk-col-merge',
                    title: mergeLost > 0
                      ? t(
                          `${mergePending} 张的分支还没合并，其中 ${mergeLost} 张的分支已删除`,
                          `${mergePending} branch(es) not merged yet — ${mergeLost} of them already deleted`,
                        )
                      : t(`${mergePending} 张的分支还没合并（没检测到合并）`, `${mergePending} branch(es) not merged yet`),
                  },
                  t(`${mergePending} 未合并`, `${mergePending} unmerged`),
                )
              : null,
            h(
              'span',
              {
                className: awaitingCount > 0 ? 'fxk-col-count is-await' : 'fxk-col-count',
                title: awaitingCount > 0 ? t(`${awaitingCount} 张等你回答`, `${awaitingCount} waiting for you`) : undefined,
              },
              String(items.length),
            ),
            awaitingCount > 0
              ? h(
                  'span',
                  { className: 'fxk-col-await', title: t('这些卡片在等你回话，回答后原地继续跑', 'These cards are waiting for your reply; they continue once you answer') },
                  t(`${awaitingCount} 张等你回答`, `${awaitingCount} waiting`),
                )
              : null,
          ),
          h(
            'div',
            { className: 'fxk-col-body' },
            loading && !board
              ? [h('div', { key: 'a', className: 'fxk-skeleton' }), h('div', { key: 'b', className: 'fxk-skeleton' }), h('div', { key: 'c', className: 'fxk-skeleton' })]
              : items.length === 0
                ? h('div', { className: 'fxk-empty' }, isZh() ? column.hintZh : column.hintEn)
                : items.map(renderCard),
            isTodo
              ? h(
                  'button',
                  { type: 'button', className: 'fxk-col-new', onClick: openCreate },
                  '+ ',
                  t('新建待办', 'New card'),
                )
              : null,
          ),
        )
      }

      // ---------------------------------------------------------------- list
      /**
       * 任务列表头前的留白：行里是「状态点 + 编号 + 标题」，
       * 表头也得占住点 + 编号这两段，否则「任务」会压到 fx-N 上方、
       * 读起来像编号列的表头。复用行内同名的 class，宽度和出现时机自动一致：
       * 两个 class 都只在 ≤700px 的手机版出现。
       */
      const listHeadLead = (column) =>
        column.key === 'title'
          ? [
              h('span', { key: 'lead-dot', className: 'fxk-mob-dot', 'aria-hidden': 'true' }),
              h('span', { key: 'lead-seq', className: 'fxk-task-seq', 'aria-hidden': 'true' }),
            ]
          : []
      const renderListHeadCell = (column) => {
        const active = sort.key === column.key
        const className = `fxk-thcell ${column.cls}${column.align === 'right' ? ' is-right' : ''}`
        if (!column.sortable) {
          return h('th', { key: column.key, scope: 'col', className }, t(column.zh, column.en))
        }
        return h(
          'th',
          {
            key: column.key,
            scope: 'col',
            className,
            'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
          },
          h(
            'button',
            {
              type: 'button',
              className: `fxk-thbtn${column.align === 'right' ? ' is-right' : ''}`,
              'data-active': String(active),
              title: t(`按${column.zh}排序`, `Sort by ${column.en}`),
              onClick: () => toggleSort(column.key),
            },
            listHeadLead(column),
            h('span', null, t(column.zh, column.en)),
            h(IconSort, { active, dir: active ? sort.dir : column.dir }),
          ),
        )
      }

      const renderListRow = (card) => {
        const state = card.status
        // 进行中里「等你回答」的那一档：状态仍是进行中，只是这一轮卡在用户这边
        const awaiting = state === 'running' && Boolean(card.awaiting)
        const attachmentCount = (card.attachments || []).length
        const seqLabel = cardSeqLabel(card)
        const updatedAt = Number(card.updatedAt) || Number(card.createdAt) || 0
        const elapsed = elapsedOf(card)
        const duration =
          state === 'running'
            ? awaiting
              ? h('span', { className: 'fxk-timer fxk-timer-awaiting' }, h('span', { className: 'fxk-await-dot' }), h('b', null, formatElapsed(awaitElapsedOf(card))))
              : h('span', { className: 'fxk-timer' }, h('span', { className: 'fxk-pulse' }), h('b', null, formatElapsed(elapsed)))
            : Number(card.lastRunMs) > 0
              ? h('span', { className: 'fxk-dur-text' }, formatDuration(card.lastRunMs))
              : h('span', { className: 'fxk-dur-empty' }, '—')

        const actions = []
        const rerun = h(
          'button',
          {
            key: 'rerun',
            type: 'button',
            className: 'fxk-act fxk-act-icon',
            title: t('重新执行', 'Run again'),
            'aria-label': t(`重新执行 ${card.title}`, `Run ${card.title} again`),
            disabled: busy === `run:${card.id}`,
            onClick: () => void runCard(card),
          },
          '↻',
        )
        if (state === 'todo') {
          actions.push(
            h(
              'button',
              {
                key: 'run',
                type: 'button',
                className: 'fxk-act fxk-act-run',
                title: t('执行这张卡片', 'Run this card'),
                disabled: busy === `run:${card.id}`,
                onClick: () => void runCard(card),
              },
              '▶ ',
              t('执行', 'Run'),
            ),
          )
        } else if (state === 'review') {
          if (card.sessionArchived) actions.push(rerun)
          actions.push(
            h(
              'button',
              {
                key: 'done',
                type: 'button',
                className: 'fxk-act fxk-act-ok',
                title:
                  completionMode === 'prompt'
                    ? t('标记完成，并先发送收尾提示词', 'Mark done and send the wrap-up prompt first')
                    : t('标记为已完成，移入已完成', 'Mark as done'),
                disabled: busy === `done:${card.id}`,
                onClick: () => void markDone(card),
              },
              '✓ ',
              t('完成', 'Done'),
            ),
          )
        } else if (state === 'done') {
          if (card.sessionArchived) actions.push(rerun)
          actions.push(
            h(
              'button',
              {
                key: 'undone',
                type: 'button',
                className: 'fxk-act',
                title: t('撤销完成，回到待审核', 'Undo done — back to review'),
                disabled: busy === `undone:${card.id}`,
                onClick: () => void markUndone(card),
              },
              '↩ ',
              t('撤销', 'Undo'),
            ),
          )
        }

        return h(
          'tr',
          {
            key: card.id,
            className: 'fxk-table-row',
            'data-state': state,
            onClick: () => openCard(card),
          },
          h(
            'td',
            { className: 'fxk-td fxk-td-status c-status' },
            h(
              'span',
              {
                className: 'fxk-state',
                'data-state': awaiting ? 'awaiting' : state,
                title: awaiting
                  ? t('进行中 · 等你回答', 'Running · waiting for you')
                  : card.preparing
                    ? t('进行中 · 准备工作树', 'Running · preparing worktree')
                    : card.finishing
                      ? t('进行中 · 收尾', 'Running · wrap-up')
                      : undefined,
              },
              h('span', { className: 'fxk-state-dot', 'aria-hidden': 'true' }),
              h(
                'span',
                null,
                awaiting
                  ? t('等你回答', 'Waiting')
                  : card.preparing
                    ? t('准备中', 'Preparing')
                    : card.finishing
                      ? t('收尾中', 'Wrapping up')
                      : statusLabelOf(state),
              ),
            ),
          ),
          h('td', { className: 'fxk-td fxk-td-seq c-seq' }, cardSeqLabel(card) || '—'),
          h(
            'td',
            { className: 'fxk-td fxk-td-task c-task' },
            h(
              'div',
              { className: 'fxk-task' },
              // 窄屏状态列收起，用标题前的色点代替；宽屏这个点 display:none
              h(
                'span',
                {
                  className: 'fxk-mob-dot',
                  'data-state': awaiting ? 'awaiting' : state,
                  role: 'img',
                  'aria-label': awaiting
                    ? t('等你回答', 'Waiting for you')
                    : card.preparing
                      ? t('准备中', 'Preparing')
                      : card.finishing
                        ? t('收尾中', 'Wrapping up')
                        : statusLabelOf(state),
                },
              ),
              // 编号列只在手机版（≤700px）收起，那时编号改在这里出现（CSS 二选一，更宽时不重复）。
              // 没编号的卡片也占住同一段槽位，每行标题都从同一条 x 开始，和表头留白对得上。
              h(
                'span',
                {
                  className: 'fxk-task-seq',
                  title: seqLabel ? t(`卡片编号 ${seqLabel}`, `Card number ${seqLabel}`) : undefined,
                },
                seqLabel || '',
              ),
              h('button', {
                type: 'button',
                className: 'fxk-title',
                title: card.title,
                // 标题自己是按钮：键盘 Enter / Space 也能打开会话（整行 onClick 不响应键盘）；
                // 挡掉冒泡，免得和整行的 onClick 双开
                onClick: (event) => {
                  event.stopPropagation()
                  openCard(card)
                },
              }, card.title),
              workspaceChipOf(card),
              attachmentCount
                ? h('span', { className: 'fxk-att', title: t('附件', 'Attachments') }, `📎 ${attachmentCount}`)
                : null,
              worktreeChipOf(card, mergeStateOn, copyMergeCommand),
              card.error ? h('span', { className: 'fxk-chip fxk-chip-err', title: card.error }, t('有报错', 'Error')) : null,
              card.sessionArchived
                ? h('span', { className: 'fxk-chip fxk-chip-warn', title: t('会话已归档，可点右侧重新执行', 'Conversation archived — run again on the right') }, t('已归档', 'Archived'))
                : null,
              card.workspaceId && !workspaceTitle(card.workspaceId)
                ? h('span', { className: 'fxk-chip fxk-chip-warn' }, t('工作区不可用', 'Workspace missing'))
                : null,
            ),
          ),
          h('td', { className: 'fxk-td fxk-td-dur c-dur' }, duration),
          h('td', { className: 'fxk-td fxk-td-upd c-upd' }, formatWhen(updatedAt)),
          h(
            'td',
            { className: 'fxk-td fxk-td-acts c-acts', onClick: (event) => event.stopPropagation() },
            state === 'running'
              ? h(
                  'span',
                  { className: awaiting ? 'fxk-timer fxk-timer-awaiting fxk-mob-timer' : 'fxk-timer fxk-mob-timer' },
                  h('span', { className: awaiting ? 'fxk-await-dot' : 'fxk-pulse' }),
                  h('b', null, formatElapsed(awaiting ? awaitElapsedOf(card) : elapsed)),
                )
              : null,
            h('div', { className: 'fxk-acts' }, actions),
          ),
        )
      }

      const renderListTable = () => {
        const total = visibleCards.length
        const open = total - totals.done
        const awaitingTotal = visibleCards.filter((card) => card.status === 'running' && card.awaiting).length
        const sortColumn = LIST_COLUMNS.find((item) => item.key === sort.key) || LIST_COLUMNS[0]
        const sortName = t(sortColumn.zh, sortColumn.en)
        const arrow = sort.dir === 'asc' ? '↑' : '↓'
        const footFull = isZh()
          ? `共 ${total} 张 · 待办 ${totals.todo} · 进行中 ${totals.running}${awaitingTotal > 0 ? `（${awaitingTotal} 张等你回答）` : ''} · 待审核 ${totals.review} · 已完成 ${totals.done}`
          : `${total} cards · ${totals.todo} to do · ${totals.running} running${awaitingTotal > 0 ? ` (${awaitingTotal} waiting for you)` : ''} · ${totals.review} review · ${totals.done} done`
        const footShort = isZh()
          ? `按${sortName} ${arrow} · 共 ${total} 张 · 未完成 ${open}${awaitingTotal > 0 ? ` · 等你 ${awaitingTotal}` : ''}`
          : `By ${sortName} ${arrow} · ${total} cards · ${open} open${awaitingTotal > 0 ? ` · ${awaitingTotal} waiting` : ''}`

        return h(
          'div',
          { className: 'fxk-listwrap' },
          h(
            'section',
            { className: 'fxk-tablepanel' },
            h(
              'div',
              { className: 'fxk-tablescroll' },
              h(
                'table',
                { className: 'fxk-table' },
                h('caption', { className: 'fxk-sr-only' }, t('任务列表', 'Task list')),
                h('thead', null, h('tr', null, LIST_COLUMNS.map(renderListHeadCell))),
                h(
                  'tbody',
                  null,
                  loading && !board
                    ? Array.from({ length: 5 }).map((_, index) =>
                        h(
                          'tr',
                          { key: `skeleton-${index}` },
                          h('td', { colSpan: LIST_COLUMNS.length, className: 'fxk-skeleton-cell' }, h('span', { className: 'fxk-skeleton-bar' })),
                        ),
                      )
                    : sortedCards.length === 0
                      ? h(
                          'tr',
                          null,
                          h(
                            'td',
                            { colSpan: LIST_COLUMNS.length, className: 'fxk-empty-cell' },
                            activeWorkspaceId === BUCKET_ALL
                              ? t('还没有卡片。', 'No cards yet.')
                              : t('这个工作区还没有卡片。', 'No cards in this workspace yet.'),
                          ),
                        )
                      : sortedCards.map(renderListRow),
                ),
              ),
              h('button', { type: 'button', className: 'fxk-addrow', onClick: openCreate }, '＋ ', t('新建待办', 'New card')),
            ),
            h(
              'footer',
              { className: 'fxk-tablefoot' },
              h('span', { className: 'fxk-foot-full' }, footFull),
              h('span', { className: 'fxk-foot-short' }, footShort),
            ),
          ),
        )
      }

      /** 点完成前的确认：分支还没合回去，或者检出里还有未提交的改动。 */
      const doneConfirmCard = doneConfirm ? doneConfirm.card : null
      const doneConfirmMerge = doneConfirmCard && doneConfirmCard.worktree ? doneConfirmCard.worktree.merge : null
      const canAskSession = Boolean(
        doneConfirmCard && doneConfirmCard.sessionId && !doneConfirmCard.sessionArchived,
      )
      const doneConfirmTitle = !doneConfirmMerge
        ? t('先确认一下', 'One check first')
        : doneConfirmMerge.state === 'unmerged' && doneConfirmMerge.dirty === true
          ? t('还没合并，也还有未提交的改动', 'Not merged yet, and the checkout has uncommitted changes')
          : doneConfirmMerge.state === 'unmerged'
            ? t('这个分支还没合并', 'This branch is not merged yet')
            : t('检出里还有未提交的改动', 'The checkout has uncommitted changes')
      const doneConfirmNode = doneConfirm
        ? h(
            'div',
            {
              className: 'fxk-overlay',
              'data-align': 'center',
              onClick: (event) => {
                if (event.target === event.currentTarget) setDoneConfirm(null)
              },
            },
            h(
              'div',
              {
                className: 'fxk-confirm',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': doneConfirmTitle,
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'fxk-confirm-close',
                  'aria-label': t('关掉这条提示（取消）', 'Close this reminder (cancel)'),
                  title: t('取消：先不动这张卡片', 'Cancel — leave the card as it is'),
                  onClick: () => setDoneConfirm(null),
                },
                '✕',
              ),
              h('div', { className: 'fxk-confirm-title' }, doneConfirmTitle),
              h('div', { className: 'fxk-confirm-text' }, mergeSummaryOf(doneConfirm.card)),
              h(
                'div',
                { className: 'fxk-confirm-text' },
                canAskSession
                  ? t(
                      '可以让这一轮的会话去合并并清理；也可以继续完成——看板只记下这一轮没合回去。',
                      'You can let this card’s conversation merge and clean up, or complete anyway — the board just records that nothing was merged back.',
                    )
                  : doneConfirmMerge && doneConfirmMerge.state === 'unmerged'
                    ? t(
                        '这一轮的会话已经归档，看板没法让会话合并；可以复制命令在项目目录里手动合并，或者继续完成。',
                        'This card’s conversation is archived, so it cannot merge for you; copy the command and run it in the project root, or complete anyway.',
                      )
                    : t(
                        '这一轮的会话已经归档，看板没法让会话合并；检出里还有没提交的改动，先去检出里提交或复制出来，再合并。',
                        'This card’s conversation is archived, so it cannot merge for you; the checkout has uncommitted changes — commit or copy them first, then merge.',
                      ),
              ),
              h(
                'div',
                { className: 'fxk-confirm-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'fxk-btn',
                    'data-tone': 'warn',
                    onClick: () => {
                      const pending = doneConfirm.card
                      setDoneConfirm(null)
                      void performDone(pending)
                    },
                  },
                  t('继续完成', 'Complete anyway'),
                ),
                canAskSession
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'fxk-btn fxk-btn-primary',
                        autoFocus: true,
                        disabled: busy === `merge:${doneConfirm.card.id}`,
                        onClick: () => void askSessionToMerge(doneConfirm.card),
                      },
                      t('让会话合并', 'Let the conversation merge'),
                    )
                  : doneConfirmMerge && doneConfirmMerge.state === 'unmerged'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'fxk-btn fxk-btn-primary',
                          autoFocus: true,
                          onClick: () => {
                            void copyMergeCommand('merge', doneConfirm.card)
                            setDoneConfirm(null)
                          },
                        },
                        t('复制命令', 'Copy command'),
                      )
                    : null,
              ),
            ),
          )
        : null

      // 看板视图 = 一个工作区；两个以上工作区时还能选「全部工作区」。
      // 异常抽屉只在真的存在这类卡片时出现，平时完全看不到。
      const filterOptions = [
        ...(allSelectable ? [{ value: BUCKET_ALL, label: t('全部工作区', 'All workspaces') }] : []),
        ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.title })),
        ...(orphanCards.length > 0
          ? [{ value: BUCKET_NONE, label: `${t('未指定工作区', 'No workspace')} · ${orphanCards.length}` }]
          : []),
        ...(missingCards.length > 0
          ? [{ value: BUCKET_MISSING, label: `${t('工作区不可用', 'Workspace missing')} · ${missingCards.length}` }]
          : []),
      ]

      const toastNode = toast
        ? h(
            'div',
            { className: 'fxk-toast', role: 'status' },
            h('span', { className: 'fxk-toast-text' }, toast.text),
            toast.undo
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => {
                      const undo = toast.undo
                      setToast(null)
                      if (undo) undo()
                    },
                  },
                  t('撤销', 'Undo'),
                )
              : null,
            h('button', { type: 'button', onClick: () => setToast(null), 'aria-label': t('关掉提示', 'Dismiss') }, '✕'),
          )
        : null

      if (settingsOpen) {
        return h(
          'div',
          { className: 'fxk-root', 'data-view': 'settings' },
          h(SettingsPage, {
            settings: board ? board.settings : null,
            advanced: board ? board.advanced : null,
            capabilities: board && board.advanced ? board.advanced.capabilities : null,
            loading,
            error,
            view,
            sort,
            cardCount: cards.length,
            onSave: saveSettings,
            onSaveWorktree: saveWorktree,
            onResetView: resetViewPrefs,
            onBack: closeSettings,
            onRetry: () => void load(),
            notify,
          }),
          toastNode,
        )
      }

      return h(
        'div',
        { className: 'fxk-root', 'data-narrow': narrowCol, 'data-view': view },
        h(
          'header',
          { className: 'fxk-head' },
          h(
            'div',
            { className: 'fxk-brand' },
            h('span', { className: 'fxk-brand-mark' }, h(IconKanban, { size: 16, active: true })),
            h('span', { className: 'fxk-brand-title' }, t('任务看板', 'Task board')),
            h(
              'div',
              { className: 'fxk-viewswitch', role: 'group', 'aria-label': t('视图', 'View') },
              h(
                'button',
                {
                  type: 'button',
                  'data-active': String(view === 'board'),
                  'aria-pressed': view === 'board',
                  'aria-label': t('看板视图', 'Board view'),
                  title: t('看板视图', 'Board view'),
                  onClick: () => selectView('board'),
                },
                h(IconKanban, { size: 14, active: view === 'board' }),
                h('span', { className: 'fxk-viewswitch-label' }, t('看板', 'Board')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-active': String(view === 'list'),
                  'aria-pressed': view === 'list',
                  'aria-label': t('列表视图', 'List view'),
                  title: t('列表视图', 'List view'),
                  onClick: () => selectView('list'),
                },
                h(IconList, { size: 14 }),
                h('span', { className: 'fxk-viewswitch-label' }, t('列表', 'List')),
              ),
            ),
          ),
          h('span', { className: 'fxk-head-spacer' }),
          h(
            'label',
            { className: 'fxk-filter' },
            h('span', { className: 'fxk-filter-label' }, t('工作区', 'Workspace')),
            h(
              'select',
              {
                className: 'fxk-select',
                value: activeWorkspaceId || '',
                'aria-label': t('切换看板的工作区', 'Switch the board workspace'),
                onChange: (event) => selectWorkspace(event.target.value),
              },
              filterOptions.length > 0
                ? filterOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))
                : h('option', { value: '', disabled: true }, t('还没有工作区', 'No workspaces yet')),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'fxk-btn fxk-new-head',
              title: t('新建待办', 'New card'),
              'aria-label': t('新建待办', 'New card'),
              onClick: openCreate,
            },
            h('span', { className: 'fxk-new-plus' }, '+'),
            h('span', { className: 'fxk-new-label' }, t('新建待办', 'New card')),
          ),
          h(
            'button',
            {
              ref: gearRef,
              type: 'button',
              className: 'fxk-btn fxk-btn-icon fxk-gear',
              title: t('设置', 'Settings'),
              'aria-label': t('设置', 'Settings'),
              onClick: () => {
                setModal(null)
                setSettingsOpen(true)
              },
            },
            h(IconGear, { size: 16 }),
          ),
        ),
        view === 'board'
          ? h(
              'div',
              { className: 'fxk-tabs' },
              COLUMNS.map((column) =>
                h(
                  'button',
                  {
                    key: column.id,
                    type: 'button',
                    className: 'fxk-tab',
                    'data-active': String(narrowCol === column.id),
                    onClick: () => setNarrowCol(column.id),
                  },
                  isZh() ? column.zh : column.en,
                  h('span', { className: 'fxk-col-count' }, String(totals[column.id] || 0)),
                ),
              ),
            )
          : null,
        error
          ? h(
              'div',
              { className: 'fxk-errorbar', role: 'alert' },
              h('span', null, error),
              h(
                'button',
                { type: 'button', className: 'fxk-btn', onClick: () => void load() },
                t('重试', 'Retry'),
              ),
            )
          : null,
        view === 'list' ? renderListTable() : h('div', { className: 'fxk-board' }, COLUMNS.map(renderColumn)),
        doneConfirmNode,
        modal
          ? h(Editor, {
              key: modal.card ? modal.card.id : 'new',
              mode: modal.mode,
              card: modal.card,
              workspaces,
              defaultWorkspaceId: currentWorkspaceId || null,
              // 「全部工作区」里新建：不预填、必须由人显式选一个（见编辑器里的 requireChoice）
              requireChoice: activeWorkspaceId === BUCKET_ALL,
              worktreeOffered: Boolean(board && board.settings && board.settings.worktree && board.settings.worktree.offer),
              worktreeAvailable: Boolean(board && board.advanced && board.advanced.capabilities && board.advanced.capabilities.worktrees),
              attachmentLimitBytes:
                board && board.advanced && board.advanced.limits ? board.advanced.limits.maxCardAttachmentBytes : null,
              post,
              notify,
              onSaved: handleSaved,
              onClose: () => setModal(null),
            })
          : null,
        toastNode,
      )
    }

    // ---------------------------------------------------------------- editor
    // ------------------------------------------------------------ draft utils
    /** 侧栏里是否已经有值得保存的内容。 */
    function hasContentOf(state) {
      return Boolean(
        String(state.title || '').trim() ||
          String(state.body || '').trim() ||
          (state.kept && state.kept.length) ||
          (state.added && state.added.length),
      )
    }

    /** 附件集合的指纹：用来判断一次保存期间用户有没有增删附件。 */
    function attachmentSignature(state) {
      const kept = (state.kept || []).map((item) => item.id).sort().join('|')
      const added = (state.added || []).map((item) => item.key).sort().join('|')
      return `${kept}::${added}`
    }

    function attachmentPayloadOf(state) {
      return [
        ...(state.kept || []).map((item) => ({
          attachmentId: item.id,
          kind: item.kind,
          name: item.name,
          bytes: item.bytes,
          mediaType: item.mediaType,
          width: item.width,
          height: item.height,
        })),
        ...(state.added || []).map((item) => ({
          kind: item.kind,
          name: item.name,
          data: item.data,
          ...(item.mediaType ? { mediaType: item.mediaType } : {}),
        })),
      ]
    }

    // ---------------------------------------------------------------- editor
    function Editor(props) {
      const { mode, card, workspaces, defaultWorkspaceId, requireChoice: requireChoiceProp, worktreeOffered, worktreeAvailable, attachmentLimitBytes, post, notify, onSaved, onClose } = props
      // 「全部工作区」里新建时没有「当前工作区」可默认：由用户自己选，别替他挑第一个
      const requireChoice = requireChoiceProp === true
      // 附件上限跟 Host 配置走（cordis.patch.yml 可改）；没拿到（看板还没读完）时用默认值
      const attachmentLimit = Number(attachmentLimitBytes) > 0 ? Number(attachmentLimitBytes) : MAX_CARD_BYTES
      // 只回填用户手写的标题；派生标题留空，由占位符和下面的会话名预览兜住
      const [title, setTitle] = useState(card ? (typeof card.titleInput === 'string' ? card.titleInput : card.title) : '')
      const [body, setBody] = useState(card ? card.body : '')
      // 工作区必填：优先卡片自己的（校验它还在），否则用看板当前工作区。
      // 历史卡片没工作区、或工作区已被删时，打开编辑就顺手落到一个有效工作区。
      // 「全部工作区」里新建是个例外：留空，由人显式选（void 掉 workspaces[0] 那条兜底，
      // 否则会静默把卡片归到列表第一个仓库）。
      const initialWorkspaceId =
        card && card.workspaceId && workspaces.some((workspace) => workspace.id === card.workspaceId)
          ? card.workspaceId
          : requireChoice
            ? ''
            : defaultWorkspaceId || (workspaces[0] && workspaces[0].id) || ''
      const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
      // 工作树意图跟着卡片走；默认不勾，只有建卡的人显式打开才生效
      const [worktreeRequested, setWorktreeRequested] = useState(Boolean(card && card.worktree && card.worktree.requested))
      const [kept, setKept] = useState(card && Array.isArray(card.attachments) ? card.attachments : [])
      const [added, setAdded] = useState([])
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [dragging, setDragging] = useState(false)
      // 第一次自动保存后卡片就落库了，之后都走 update
      const [savedId, setSavedId] = useState(card ? card.id : null)
      // 卡片短编号（fx-N）由 Host 在落库时分配；草稿阶段还没有
      const [savedSeq, setSavedSeq] = useState(card && card.seq ? Number(card.seq) : null)
      const [auto, setAuto] = useState({ kind: 'idle', at: 0 })
      // 「还没选工作区」时点 ✕ 的二次确认：只由 ✕ 按钮点亮，Esc / 点背景不参与，
      // 免得连按两下 Esc 被当成「确认放弃」。
      const [discardArmed, setDiscardArmed] = useState(false)
      const fileRef = useRef(null)
      const addedRef = useRef(added)
      addedRef.current = added
      const savedIdRef = useRef(savedId)
      savedIdRef.current = savedId
      const onSavedRef = useRef(onSaved)
      onSavedRef.current = onSaved
      // 所有保存请求排队串行，避免「防抖保存」和「手动保存」互相覆盖
      const chainRef = useRef(Promise.resolve())
      const dirtyRef = useRef(false)
      const changeRef = useRef(0)
      const timerRef = useRef(null)
      const latest = useRef({})
      latest.current = { title, body, workspaceId, worktreeRequested, kept, added }

      /**
       * 新建 + 还没有工作区：这张卡没有归属，不能落库。
       * 它的内容只活在编辑器里，所以自动保存要停、关闭要拦（见 close）。
       * 只看「有没有工作区」而不看 requireChoice：这样即便编辑期间工作区被删到只剩一个、界面开关变了，
       * 也不会突然把一张空工作区的卡写进库里。
       */
      const blockedByWorkspace = useCallback(
        () => !savedIdRef.current && !latest.current.workspaceId && workspaces.length > 0,
        [workspaces.length],
      )

      /** 真正落库一次：create 或 update；返回 { card, created }。 */
      const persist = useCallback(
        (options) => {
          const opts = options || {}
          const run = async () => {
            const state = latest.current
            if (!hasContentOf(state)) return null
            if (!opts.force && !dirtyRef.current) return null
            // 没有归属就不落库：否则自动保存会造出一张不属于任何工作区的孤儿卡，
            // 直接掉进「未指定工作区」那个抽屉。
            if (blockedByWorkspace()) return null
            const version = changeRef.current
            const signature = attachmentSignature(state)
            let created = !savedIdRef.current
            setAuto((previous) => ({ kind: 'saving', at: previous.at }))
            try {
              const payload = {
                title: state.title.trim(),
                body: state.body,
                workspaceId: state.workspaceId || null,
                worktree: { requested: Boolean(state.worktreeRequested) },
                attachments: attachmentPayloadOf(state),
              }
              // update 的 id 要放进 card 里：Host 的 updateCard 读的是 card.id
              let result = created
                ? await post('create', { card: payload }, { silent: true })
                : await post('update', { card: { ...payload, id: savedIdRef.current } }, { silent: true }).catch(async (failure) => {
                    // Host 里这张卡真的没了（被删 / 数据被换过）：退化成新建，别让草稿永远存不进去
                    if (Number(failure?.status) !== 404) throw failure
                    created = true
                    savedIdRef.current = null
                    setSavedId(null)
                    return post('create', { card: payload }, { silent: true })
                  })
              const saved = result && result.card
              if (!saved) throw new Error(t('保存失败', 'Save failed'))
              savedIdRef.current = saved.id
              setSavedId(saved.id)
              if (saved.seq) setSavedSeq(Number(saved.seq))
              // 落库到别的工作区时，让看板视图跟过去（同工作区时父层直接 no-op）
              onSavedRef.current?.(saved)
              // 附件这次已经落库：把「待上传」转成「已在库」，避免每 8 秒重传 base64
              if (attachmentSignature(latest.current) === signature) {
                for (const item of latest.current.added) {
                  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
                }
                setAdded([])
                setKept(Array.isArray(saved.attachments) ? saved.attachments : [])
              }
              const unchanged = changeRef.current === version
              dirtyRef.current = !unchanged
              setAuto({ kind: unchanged ? 'saved' : 'dirty', at: Date.now() })
              setError('')
              if (!unchanged) scheduleRef.current()
              return { card: saved, created }
            } catch (failure) {
              setAuto((previous) => ({ kind: 'error', at: previous.at }))
              setError(String(failure?.message ?? failure))
              throw failure
            }
          }
          const next = chainRef.current.then(run, run)
          chainRef.current = next.then(() => {}, () => {})
          return next
        },
        [post, blockedByWorkspace],
      )

      /** 停手后 1.2 秒存一次。 */
      const scheduleSoon = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          if (!dirtyRef.current) return
          void persist().catch(() => {})
        }, AUTOSAVE_IDLE_MS)
      }, [persist])
      const scheduleRef = useRef(scheduleSoon)
      scheduleRef.current = scheduleSoon

      /** 每次内容变化：标脏 + 重置防抖计时。 */
      const markDirty = useCallback(() => {
        dirtyRef.current = true
        changeRef.current += 1
        // 继续动了就说明不是要放弃：把 ✕ 的二次确认收回去
        setDiscardArmed(false)
        setAuto((previous) => (previous.kind === 'dirty' ? previous : { kind: 'dirty', at: previous.at }))
        scheduleSoon()
      }, [scheduleSoon])

      // 一直打不停手时，也每 8 秒兜底存一次
      useEffect(() => {
        const timer = setInterval(() => {
          if (dirtyRef.current) void persist().catch(() => {})
        }, AUTOSAVE_INTERVAL_MS)
        return () => clearInterval(timer)
      }, [persist])

      // 侧栏被关掉 / 面板被切走时补最后一次，别让刚敲的字丢掉
      useEffect(() => {
        return () => {
          if (timerRef.current) clearTimeout(timerRef.current)
          for (const item of addedRef.current) {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
          }
          if (dirtyRef.current && hasContentOf(latest.current)) {
            void persist({ force: true }).catch(() => {})
          }
        }
      }, [persist])

      const totalBytes = kept.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0) + added.reduce((sum, item) => sum + item.bytes, 0)

      const addFiles = useCallback(
        async (fileList) => {
          const files = Array.from(fileList || [])
          if (files.length === 0) return
          let projected = totalBytes
          const next = []
          for (const file of files) {
            const isImage = IMAGE_TYPES.includes(file.type)
            if (projected + file.size > attachmentLimit) {
              setError(t(`附件总大小超过 ${formatBytes(attachmentLimit)}`, `Attachments exceed ${formatBytes(attachmentLimit)}`))
              break
            }
            projected += file.size
            try {
              const data = await readAsBase64(file)
              next.push({
                key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                kind: isImage ? 'image' : 'file',
                name: file.name || (isImage ? 'image' : 'file'),
                mediaType: isImage ? file.type : undefined,
                data,
                bytes: file.size,
                previewUrl: isImage ? URL.createObjectURL(file) : '',
              })
            } catch (failure) {
              setError(String(failure?.message ?? failure))
            }
          }
          if (next.length > 0) {
            setAdded((previous) => [...previous, ...next])
            markDirty()
          }
        },
        [totalBytes, markDirty, attachmentLimit],
      )

      const save = useCallback(
        async (thenRun) => {
          if (busy) return
          if (!hasContentOf(latest.current)) {
            setError(t('先给卡片写点东西，或者挂一个附件', 'Write something or attach a file first'))
            return
          }
          if (workspaces.length > 0 && !latest.current.workspaceId) {
            setError(t('先选一个所属工作区，待办必须落在某个工作区里', 'Pick a workspace — every card belongs to one'))
            return
          }
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          setBusy(thenRun ? 'run' : 'save')
          setError('')
          try {
            const outcome = await persist({ force: true })
            const saved = outcome && outcome.card
            if (!saved) throw new Error(t('保存失败', 'Save failed'))
            // 保存途中又敲了字：先补一次再走，别让「立即执行」跑的是旧内容
            if (dirtyRef.current) await persist({ force: true })
            if (thenRun) {
              await post('run', { id: saved.id }, { silent: true })
              notify({ text: t('已开始执行，卡片进入进行中', 'Started — the card is now running') })
            } else {
              const seqLabel = mode === 'edit' ? '' : cardSeqLabel(saved)
              notify({
                text: seqLabel
                  ? t(`已保存为待办 · ${seqLabel}`, `Saved to To do · ${seqLabel}`)
                  : mode === 'edit'
                    ? t('已保存', 'Saved')
                    : t('已保存为待办', 'Saved to To do'),
              })
            }
            dirtyRef.current = false
            onClose()
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setBusy('')
          }
        },
        [busy, mode, persist, post, notify, onClose],
      )

      /**
       * 关侧栏：先把没落库的改动补存一次；存失败就留在原地提示，不丢内容。
       * source: 'x'（标题栏 ✕）/ 'esc' / 'backdrop'。怎么做由 closeIntentOf 决定。
       */
      const close = useCallback(
        (source) => {
          if (busy) return
          const intent = closeIntentOf({
            blocked: blockedByWorkspace(),
            hasContent: hasContentOf(latest.current),
            dirty: dirtyRef.current,
            source,
            discardArmed,
          })
          if (intent === 'warn') {
            setError(
              t(
                '先选一个所属工作区：这张卡片还没有归属，所以还什么都没保存',
                'Pick a workspace first — the card has no home yet, so nothing is saved',
              ),
            )
            return
          }
          if (intent === 'arm') {
            setDiscardArmed(true)
            setError(
              t(
                '还没选工作区，这张卡片还没保存；再点一次 ✕ 就是放弃这次输入',
                'No workspace yet, so nothing is saved — click ✕ again to discard',
              ),
            )
            return
          }
          setDiscardArmed(false)
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          if (intent === 'close') {
            onClose()
            return
          }
          setBusy('close')
          setError('')
          persist({ force: true })
            .then(() => {
              setBusy('')
              onClose()
            })
            .catch(() => setBusy(''))
        },
        [busy, blockedByWorkspace, discardArmed, persist, onClose],
      )

      const remove = useCallback(async () => {
        const id = savedIdRef.current || (card && card.id)
        if (!id) return
        if (busy) return
        setBusy('delete')
        try {
          await post('delete', { id }, { silent: true })
          dirtyRef.current = false
          savedIdRef.current = null
          notify({ text: t('卡片已删除', 'Card deleted') })
          onClose()
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy('')
        }
      }, [card, busy, post, notify, onClose])

      const heading = mode === 'edit' ? t('编辑待办', 'Edit card') : t('新建待办', 'New card')
      const seqText = savedSeq ? `fx-${savedSeq}` : ''
      const copySeq = () => {
        if (!seqText) return
        void copyText(seqText).then((ok) => {
          notify({
            text: ok
              ? t(`已复制编号 ${seqText}`, `Copied ${seqText}`)
              : t(`复制失败，编号 ${seqText}`, `Copy failed — ${seqText}`),
          })
        })
      }
      // 「全部工作区」里新建、还没选工作区、但已经写了东西：这时候自动保存是停的。
      // 这行字必须说实话，否则用户会以为内容已经存进去了。
      const needWorkspace = !savedId && !workspaceId && workspaces.length > 0 && hasContentOf({ title, body, kept, added })
      const autoText = needWorkspace
        ? t('选一个工作区后才会保存', 'Saves once you pick a workspace')
        : auto.kind === 'saving'
          ? t('自动保存中…', 'Auto-saving…')
          : auto.kind === 'dirty'
            ? t('有改动，稍后自动保存', 'Unsaved changes')
            : auto.kind === 'error'
              ? t('自动保存失败', 'Auto-save failed')
              : auto.kind === 'saved' && auto.at
                ? t(`已自动保存 ${clockOf(auto.at)}`, `auto-saved ${clockOf(auto.at)}`)
                : t('自动保存已开启', 'Auto-save on')
      // 标题留空时，会话名取正文首行（没有正文就用单个附件名）；这里只是实时预览，落库的标题由 Host 派生
      const autoName = title.trim()
        ? ''
        : titlePreviewOf(body, [...kept.map((item) => item.name), ...added.map((item) => item.name)])

      return h(
        'div',
        {
          className: 'fxk-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget) close('backdrop')
          },
        },
        h(
          'div',
          {
            className: 'fxk-sheet',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': heading,
            onKeyDown: (event) => {
              if (event.key === 'Escape') close('esc')
            },
          },
          h(
            'header',
            { className: 'fxk-sheet-head' },
            h('span', { className: 'fxk-sheet-title' }, heading),
            seqText
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'fxk-sheet-seq',
                    title: t('卡片编号，点一下复制', 'Card number — click to copy'),
                    'aria-label': t(`复制卡片编号 ${seqText}`, `Copy card number ${seqText}`),
                    onClick: copySeq,
                  },
                  seqText,
                )
              : null,
            h('span', { className: 'fxk-sheet-spacer' }),
            h('button', { type: 'button', className: 'fxk-btn fxk-btn-icon', disabled: Boolean(busy), 'aria-label': t('关闭', 'Close'), onClick: () => close('x') }, '✕'),
          ),
          h(
            'div',
            { className: 'fxk-sheet-body' },
            h(
              'div',
              { className: 'fxk-field' },
              h('label', { className: 'fxk-label' }, t('标题（可留空，自动取正文首行）', 'Title (optional — first line is used)')),
              h('input', {
                className: 'fxk-input',
                autoFocus: Boolean(mode === 'create'),
                value: title,
                placeholder: t('标题未填写', 'No title yet'),
                onChange: (event) => {
                  setTitle(event.target.value)
                  markDirty()
                },
              }),
              // 留空时把「会话名会取什么」直接摆出来，省得用户猜正文首行会被怎么截
              title.trim()
                ? null
                : h(
                    'div',
                    { className: 'fxk-hint' },
                    t(`会话名：${autoName || '未命名事项'}`, `Conversation name: ${autoName || 'Untitled'}`),
                  ),
            ),
            h(
              'div',
              { className: 'fxk-field' },
              h('label', { className: 'fxk-label' }, t('想法 / 任务内容', 'What to do')),
              h(
                'div',
                {
                  className: `fxk-drop${dragging ? ' fxk-dragging' : ''}`,
                  onDragOver: (event) => {
                    event.preventDefault()
                    setDragging(true)
                  },
                  onDragLeave: () => setDragging(false),
                  onDrop: (event) => {
                    event.preventDefault()
                    setDragging(false)
                    if (event.dataTransfer && event.dataTransfer.files) void addFiles(event.dataTransfer.files)
                  },
                },
                h('textarea', {
                  className: 'fxk-textarea',
                  value: body,
                  placeholder: t('写多少都行：背景、想法、可能的做法、验收标准……执行时正文会原样发出。', 'Anything: context, ideas, approach, acceptance criteria… sent verbatim when you run it.'),
                  onChange: (event) => {
                    setBody(event.target.value)
                    markDirty()
                  },
                  onPaste: (event) => {
                    const files = event.clipboardData && event.clipboardData.files
                    if (files && files.length > 0) {
                      event.preventDefault()
                      void addFiles(files)
                    }
                  },
                }),
              ),
              h('div', { className: 'fxk-hint' }, t('可以粘贴图片，或把文件拖进上面的输入框。', 'Paste images or drop files into the box above.')),
            ),
            h(
              'div',
              { className: 'fxk-field' },
              h('label', { className: 'fxk-label' }, t('附件', 'Attachments')),
              h(
                'div',
                { className: 'fxk-attach' },
                ...kept.map((item) =>
                  h(
                    'span',
                    { key: `kept-${item.id}`, className: 'fxk-attach-item', title: item.name },
                    item.kind === 'image'
                      ? h('img', { src: `${API}/attachment?id=${encodeURIComponent(item.id)}`, alt: '', loading: 'lazy' })
                      : h('span', { 'aria-hidden': true }, '📄'),
                    h('span', { className: 'fxk-attach-name' }, item.name),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'fxk-attach-x',
                        'aria-label': t('移除附件', 'Remove attachment'),
                        onClick: () => {
                          setKept((previous) => previous.filter((entry) => entry.id !== item.id))
                          markDirty()
                        },
                      },
                      '✕',
                    ),
                  ),
                ),
                ...added.map((item) =>
                  h(
                    'span',
                    { key: item.key, className: 'fxk-attach-item', title: item.name },
                    item.previewUrl
                      ? h('img', { src: item.previewUrl, alt: '' })
                      : h('span', { 'aria-hidden': true }, '📄'),
                    h('span', { className: 'fxk-attach-name' }, item.name),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'fxk-attach-x',
                        'aria-label': t('移除附件', 'Remove attachment'),
                        onClick: () => {
                          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
                          setAdded((previous) => previous.filter((entry) => entry.key !== item.key))
                          markDirty()
                        },
                      },
                      '✕',
                    ),
                  ),
                ),
                h(
                  'button',
                  { type: 'button', className: 'fxk-mini', onClick: () => fileRef.current && fileRef.current.click() },
                  t('＋ 添加附件', '+ Attach'),
                ),
                h('input', {
                  ref: fileRef,
                  type: 'file',
                  multiple: true,
                  style: { display: 'none' },
                  onChange: (event) => {
                    void addFiles(event.target.files)
                    event.target.value = ''
                  },
                }),
              ),
              h('div', { className: 'fxk-hint' }, formatBytes(totalBytes), t(` 已用（上限 ${formatBytes(attachmentLimit)}）`, ` used (${formatBytes(attachmentLimit)} limit)`)),
            ),
            h(
              'div',
              { className: 'fxk-field' },
              h('label', { className: 'fxk-label' }, t('所属工作区', 'Workspace')),
              h(
                'select',
                {
                  className: 'fxk-select',
                  value: workspaceId,
                  onChange: (event) => {
                    setWorkspaceId(event.target.value)
                    markDirty()
                  },
                },
                workspaces.length > 0
                  ? [
                      // 「全部工作区」里新建时这里是空的：给一个禁用占位，明确「还没选」
                      workspaceId
                        ? null
                        : h('option', { key: '__pick', value: '', disabled: true }, t('选择一个工作区…', 'Pick a workspace…')),
                      ...workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, workspace.title)),
                    ]
                  : h('option', { value: '', disabled: true }, t('还没有工作区', 'No workspaces yet')),
              ),
              h(
                'div',
                { className: 'fxk-hint' },
                workspaces.length === 0
                  ? t('先在 DSH 里创建一个工作区，再回来建待办。', 'Create a workspace in DSH first, then come back.')
                  : requireChoice && !workspaceId
                    ? t(
                        '你在「全部工作区」里新建，卡片还没有归属：选一个工作区才能保存或执行。',
                        'You are in “All workspaces”, so the card has no home yet — pick one to save or run.',
                      )
                    : t('默认就是看板当前的工作区。执行时会在这个工作区里建会话，会话也会出现在侧边栏对应工作区下。', 'Defaults to the board’s current workspace. The run creates a conversation there, listed under it in the sidebar.'),
              ),
            ),
            // 工作树：只在「设置里给了入口 + DSH 服务在 + 这张卡还没执行过」时出现
            worktreeOffered && worktreeAvailable && (!card || !card.sessionId)
              ? h(
                  'div',
                  { className: 'fxk-field' },
                  h(
                    'label',
                    { className: 'fxk-check', 'data-checked': String(worktreeRequested), 'data-disabled': String(!workspaceId) },
                    h('input', {
                      type: 'checkbox',
                      checked: worktreeRequested,
                      disabled: !workspaceId,
                      'aria-describedby': 'fxk-worktree-card-desc',
                      onChange: (event) => {
                        setWorktreeRequested(event.target.checked)
                        markDirty()
                      },
                    }),
                    h(
                      'span',
                      { className: 'fxk-check-text' },
                      h('span', { className: 'fxk-check-title' }, t('在独立 worktree 中运行', 'Run in an isolated worktree')),
                      h(
                        'span',
                        { id: 'fxk-worktree-card-desc', className: 'fxk-check-desc' },
                        t(
                          '第一次执行时新建分支与检出，会话目录切过去；源目录里未提交的改动不会带过去。',
                          'The first run creates a branch and checkout and switches the conversation there; uncommitted changes stay in the source checkout.',
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'fxk-hint' },
                    workspaceId
                      ? t(
                          `分支名形如 ${savedSeq ? `fx-${savedSeq}` : 'fx-<编号>'}-<标题片段>，目录在仓库 .agents/worktrees/ 下。`,
                          `Branches look like ${savedSeq ? `fx-${savedSeq}` : 'fx-<number>'}-<title-slug> under .agents/worktrees/ in the repository.`,
                        )
                      : t('先选一个工作区，才能确定在哪个仓库建工作树。', 'Pick a workspace first so the board knows which repository to use.'),
                  ),
                  card && card.worktree && card.worktree.error
                    ? h('div', { className: 'fxk-err', role: 'alert' }, card.worktree.error)
                    : null,
                )
              : card && card.worktree && card.worktree.requested
                ? h(
                    'div',
                    { className: 'fxk-hint' },
                    worktreeAvailable
                      ? t(
                          '这张卡片勾过「独立工作树」，但设置里已经关掉了这个入口；执行时不会新建工作树。',
                          'This card asked for an isolated worktree, but the option is turned off in Settings; running it will not create one.',
                        )
                      : t(
                          '这张卡片勾过「独立工作树」，但 DSH 没有启用工作树服务；执行时不会新建工作树。',
                          'This card asked for an isolated worktree, but DSH’s worktree service is not enabled; running it will not create one.',
                        ),
                  )
                : null,
            error ? h('div', { className: 'fxk-err', role: 'alert' }, error) : null,
          ),
          h(
            'footer',
            { className: 'fxk-sheet-foot' },
            mode === 'edit'
              ? h(
                  'button',
                  { type: 'button', className: 'fxk-btn fxk-btn-danger', disabled: Boolean(busy), onClick: () => void remove() },
                  t('删除', 'Delete'),
                )
              : null,
            h('span', { className: 'fxk-sheet-spacer' }),
            h(
              'span',
              {
                className: 'fxk-autosave',
                'data-kind': needWorkspace ? 'blocked' : auto.kind,
                title: needWorkspace
                  ? t(
                      '这张卡片还没有所属工作区，所以什么都没存。选一个工作区就会立刻存下来。',
                      'Nothing is saved yet because the card has no workspace. Pick one and it saves right away.',
                    )
                  : t('停手 1.2 秒或每 8 秒自动保存一次；关闭侧栏前会再补存一次。', 'Saves 1.2s after you stop typing and every 8s; flushes once more before closing.'),
              },
              autoText,
            ),
            h(
              'button',
              { type: 'button', className: 'fxk-btn', disabled: Boolean(busy) || (workspaces.length > 0 && !workspaceId), onClick: () => void save(false) },
              busy === 'save' ? t('保存中…', 'Saving…') : t('保存', 'Save'),
            ),
            h(
              'button',
              { type: 'button', className: 'fxk-btn fxk-btn-primary', disabled: Boolean(busy) || (workspaces.length > 0 && !workspaceId), onClick: () => void save(true) },
              busy === 'run' ? t('执行中…', 'Starting…') : t('▶ 立即执行', '▶ Run now'),
            ),
          ),
        ),
      )
    }

    // ---------------------------------------- 会话页标题栏：卡片状态 + 完成
    const HEADER_STATE = {
      running: {
        zh: '进行中',
        en: 'Running',
        hintZh: '会话正在跑，跑完会落到待审核',
        hintEn: 'The run is in progress and lands in review when it finishes',
      },
      finishing: {
        zh: '收尾中',
        en: 'Wrapping up',
        hintZh: '收尾提示词正在跑，跑完自动完成',
        hintEn: 'The wrap-up prompt is running; the card completes automatically',
      },
      awaiting: {
        zh: '等你回答',
        en: 'Waiting for you',
        hintZh: '助手在会话里等你回话，回答后这一轮原地继续',
        hintEn: 'The agent is waiting for your reply; the run continues where it left off',
      },
      review: {
        zh: '待审核',
        en: 'In review',
        hintZh: '这一轮已经跑完，可以标记完成',
        hintEn: 'This run has finished — you can mark it done',
      },
      done: {
        zh: '已完成',
        en: 'Done',
        hintZh: '已在任务看板标记完成',
        hintEn: 'Marked done on the task board',
      },
    }

    /**
     * 会话标题栏里的「工作树位置」。
     *
     * 勾了独立工作树的卡片，会话跑在 .agents/worktrees/ 的检出里，项目目录看不到这些改动。
     * 标题栏不写出来，人就会以为改在自己仓库里，跑完直接归档，分支留在那儿没人合并。
     * 所以常驻一枚分支标：宽标题栏写分支名，窄标题栏只留图标；分支 / 目录 / 合并提醒
     * 都放进 tooltip。勾了但还没建好时是虚线的「准备工作树」。
     */
    function headerWorktreeOf(card, state) {
      const worktree = card && card.worktree ? card.worktree : null
      if (!worktree) return null
      const branch = worktree.branch || ''
      if (!worktree.path && !branch) {
        // 建树失败：会话已经建出来了（这次没跑），别让她一直挂着「准备工作树」
        if (worktree.error) {
          return h(
            'span',
            {
              className: 'fxk-hd-wt',
              'data-tone': 'error',
              title: [
                t('工作树没建成，这张卡片这次没有跑起来。', 'The worktree could not be created, so this card did not run.'),
                worktree.error,
                t('再执行一次会重试，分支名会换一个。', 'Running it again retries with a new branch name.'),
              ].join('\n'),
            },
            h(IconBranch, { size: 12 }),
            h('span', { className: 'fxk-hd-wt-name' }, t('工作树失败', 'Worktree failed')),
          )
        }
        // 只勾了、还没建：第一次执行时才建分支，如实说「在准备」，别假装已有分支
        if (!worktree.requested) return null
        return h(
          'span',
          {
            className: 'fxk-hd-wt',
            'data-phase': 'preparing',
            title: t(
              '这张卡片勾了独立工作树，第一次执行时建分支与检出；建好后这里会显示分支名和目录。',
              'This card asked for an isolated worktree. The first run creates the branch and checkout; the name and path appear here once it exists.',
            ),
          },
          h(IconBranch, { size: 12 }),
          h('span', { className: 'fxk-hd-wt-name' }, t('准备工作树', 'Preparing worktree')),
        )
      }
      const name = branch || t('工作树', 'Worktree')
      // 这一轮结束了才最该提醒合并：跑的时候说「在哪」，跑完说「还没合并」
      const lead =
        state === 'review' || state === 'done'
          ? t('这一轮已经结束，改动还在工作树分支上。', 'This run has ended; the changes are still on the worktree branch.')
          : t('这一轮在独立工作树里跑，改动不在项目目录。', 'This run works in an isolated worktree, not in your project folder.')
      const title = [
        lead,
        `${t('分支', 'Branch')}：${name}`,
        worktree.path ? `${t('目录', 'Path')}：${worktree.path}` : null,
        t(
          `合并回主分支（在项目目录 git merge ${name}）；归档会话时 DSH 会删掉检出，分支保留。`,
          `Merge it back (git merge ${name} in the project root); archiving the session removes the checkout but keeps the branch.`,
        ),
      ].filter(Boolean)
      return h(
        'span',
        { className: 'fxk-hd-wt', title: title.join('\n') },
        h('span', { className: 'fxk-hd-wt-sr' }, t('独立工作树，分支 ', 'isolated worktree, branch ')),
        h(IconBranch, { size: 12 }),
        h('span', { className: 'fxk-hd-wt-name' }, name),
      )
    }

    /**
     * 会话标题栏里的「卡片状态 + 完成」。
     *
     * 只对看板卡片开的会话出现。状态优先用会话的实时 running：
     * 用户在已完成 / 待审核的会话里继续说话，turn/start 一响就立刻回到「进行中」，
     * 「完成」按钮同时消失；这一轮跑完再问一次 Host，落到待审核或已完成。
     */
    function HeaderCardState({ sessionId, useSession }) {
      const [card, setCard] = useState(() => (headerCardCache.has(sessionId) ? headerCardCache.get(sessionId) : undefined))
      // idle | busy | failed | board
      const [phase, setPhase] = useState('idle')
      const [failure, setFailure] = useState('')
      // 分支上还有没合并的提交：第一次点「完成」只把按钮变成确认，第二次才真的标
      const [confirming, setConfirming] = useState(false)
      const [mergeStateOn, setMergeStateOn] = useState(true)
      // 编号复制反馈：'' | 'ok' | 'fail'，1.4 秒后自己收掉
      const [seqCopy, setSeqCopy] = useState('')
      const running = useSession((snapshot) => snapshot.running)
      const alive = useRef(true)
      const wasRunning = useRef(running)
      const outcomeRef = useRef('done')

      const load = useCallback(async () => {
        try {
          const next = await fetchSessionCard(sessionId)
          rememberHeaderCard(sessionId, next.card)
          if (alive.current) {
            setCard(next.card)
            setMergeStateOn(next.mergeState)
          }
        } catch (error) {
          console.error('[kanban-fx] 读取卡片状态失败：', error?.message ?? error)
        }
      }, [sessionId])

      useEffect(() => {
        alive.current = true
        setCard(headerCardCache.has(sessionId) ? headerCardCache.get(sessionId) : undefined)
        setPhase('idle')
        void load()
        return () => {
          alive.current = false
        }
      }, [sessionId, load])

      // 这一轮结束（running true → false）：重新问一次 Host，可能已经在别处被标完成。
      // running 变 true 说明 Host 的 turn/start 已经清掉了 doneAt：本地先把「已完成」
      // 降回待审核，避免这一轮跑完后、探测回来前闪一下「已完成」。
      useEffect(() => {
        if (running && card && card.sessionId === sessionId && card.status === 'done') {
          const next = { ...card, status: 'review', doneAt: null }
          rememberHeaderCard(sessionId, next)
          setCard(next)
        }
        if (wasRunning.current && !running) void load()
        wasRunning.current = running
      }, [running, card, sessionId, load])

      // 「等你回答」只是卡片上的一枚派生标记，没有独立事件推到标题栏：这一轮在跑的时候
      // 隔几秒问一次 Host（一张卡一个轻请求），问句出现 / 回答完都能在 4 秒内反映出来。
      useEffect(() => {
        if (!running) return undefined
        const timer = window.setInterval(() => {
          void load()
        }, HEADER_CARD_POLL_MS)
        return () => window.clearInterval(timer)
      }, [running, load])

      // 这一轮结束 / 失败 / 超时都要把「确认」收掉，别让按钮一直停在问句上
      useEffect(() => {
        if (!confirming) return undefined
        const timer = window.setTimeout(() => setConfirming(false), 6000)
        return () => window.clearTimeout(timer)
      }, [confirming])

      // 「✓ 已复制」/「复制失败」也自己收掉：换回 fx-N 之后标题栏宽度就回去了
      useEffect(() => {
        if (!seqCopy) return undefined
        const timer = window.setTimeout(() => setSeqCopy(''), 1400)
        return () => window.clearTimeout(timer)
      }, [seqCopy])

      if (card === undefined || card === null || card.sessionArchived) return null

      const cardRunning = Boolean(card && card.status === 'running')
      const state = running || cardRunning
        ? card.finishing
          ? 'finishing'
          : card.awaiting
            ? 'awaiting'
            : 'running'
        : card.status === 'done'
          ? 'done'
          : 'review'
      const meta = HEADER_STATE[state]
      // 分支上还有没合并的提交：点「完成」时先要一次确认（标题栏没有弹窗宿主，就地把按钮变成确认）
      const needsMergeWarning = Boolean(mergeStateOn && card && card.worktree && mergeNeedsAttention(card))
      // 拦下来的原因可能只是「检出里有未提交改动」，措辞跟着真实原因走
      const confirmLabel =
        card && card.worktree && card.worktree.merge && card.worktree.merge.state === 'unmerged'
          ? t('未合并，仍要完成？', 'Unmerged — complete anyway?')
          : t('有未提交改动，仍要完成？', 'Uncommitted changes — complete anyway?')
      const confirmTitleText =
        card && card.worktree && card.worktree.merge && card.worktree.merge.state === 'unmerged'
          ? t('这一轮的分支还没合并；再点一次就标记完成，或先去合并', 'The branch is unmerged — click again to mark it done anyway')
          : t('检出里还有未提交的改动；再点一次就标记完成，或先去处理', 'The checkout has uncommitted changes — click again to mark it done anyway')

      const openBoard = (workspaceId, outcome = 'done') => {
        const layout = pluginCtx?.get('layout')
        if (!layout || typeof layout.selectPanel !== 'function') {
          throw new Error(t('当前 DSH 版本无法打开任务看板', 'This DSH version cannot open the task board'))
        }
        if (workspaceId) requestViewWorkspace(workspaceId)
        // 面板是切 key 后重新挂载的，提示在挂载时消费；跳转失败就清掉，不留陈年提示
        const notice = { cardId: card.id, seq: card.seq, title: card.title, outcome }
        pendingBoardNotice = notice
        try {
          layout.selectPanel('kanban-fx')
        } catch (error) {
          if (pendingBoardNotice === notice) pendingBoardNotice = null
          throw error
        }
      }

      const complete = async () => {
        if (phase === 'busy') return
        if (needsMergeWarning && !confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        setPhase('busy')
        setFailure('')
        let body = null
        try {
          body = await postCardAction('done', { sessionId })
        } catch (error) {
          if (!alive.current) return
          setPhase('failed')
          setFailure(String(error?.message ?? error))
          window.setTimeout(() => {
            if (alive.current) setPhase((current) => (current === 'failed' ? 'idle' : current))
          }, 5000)
          // 状态可能已经变了（比如又开跑了）：让标签自己说实话
          void load()
          return
        }
        const updated = (body && body.card) || { ...card, status: 'done', doneAt: Date.now() }
        const outcome =
          body && body.completionResult === 'sent'
            ? 'finishing'
            : body && body.completionResult === 'fallback-done'
              ? 'fallback-done'
              : 'done'
        outcomeRef.current = outcome
        rememberHeaderCard(sessionId, updated)
        if (!alive.current) return
        setCard(updated)
        setPhase('idle')
        // 看板记忆的工作区跟着卡片走，回到看板就能直接看见这张卡
        const workspaces = Array.isArray(body && body.workspaces) ? body.workspaces : []
        const workspaceId = workspaces.some((item) => item.id === updated.workspaceId) ? updated.workspaceId : null
        try {
          // 三个入口的「完成」都跳回看板；prompt 模式只是落点变成进行中（收尾中）
          openBoard(workspaceId, outcome)
        } catch (error) {
          // 已经标好了，只是没跳过去：留一个「打开看板」的按钮兜底
          setFailure(String(error?.message ?? error))
          setPhase('board')
        }
      }

      const openBoardAgain = () => {
        try {
          openBoard(card.workspaceId || null, outcomeRef.current)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        }
      }

      // 会话里也要看得到「这是 fx-几」：标题栏里点一下就能复制，粘贴到别的会话里说「处理 fx-11」。
      const seqLabel = cardSeqLabel(card)
      const copySeq = () => {
        if (!seqLabel) return
        void copyText(seqLabel).then((ok) => {
          if (alive.current) setSeqCopy(ok ? 'ok' : 'fail')
        })
      }

      const doneHint =
        card.completionMode === 'prompt'
          ? card.seq
            ? t(`发送收尾提示词，跑完后自动完成（fx-${card.seq}）`, `Send the wrap-up prompt and complete automatically (fx-${card.seq})`)
            : t('发送收尾提示词，跑完后自动完成', 'Send the wrap-up prompt and complete automatically')
          : card.seq
            ? t(`标记为已完成，回到任务看板（fx-${card.seq}）`, `Mark as done and return to the task board (fx-${card.seq})`)
            : t('标记为已完成，回到任务看板', 'Mark as done and return to the task board')

      const button =
        phase === 'board'
          ? h(
              'button',
              {
                type: 'button',
                className: 'fxk-hd-btn',
                'data-tone': 'board',
                title: failure || t('回到任务看板', 'Back to the task board'),
                onClick: openBoardAgain,
              },
              t('打开看板', 'Open board'),
            )
          : state === 'review'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'fxk-hd-btn',
                  'data-tone': phase === 'failed' ? 'error' : confirming ? 'warn' : undefined,
                  disabled: phase === 'busy',
                  title: phase === 'failed'
                    ? failure || t('标记失败，点击重试', 'Could not mark it done — click to retry')
                    : confirming
                      ? confirmTitleText
                      : needsMergeWarning
                        ? t(`${doneHint}（分支还没合并，会先确认一次）`, `${doneHint} (the branch is unmerged — one confirmation first)`)
                        : doneHint,
                  onClick: () => void complete(),
                },
                phase === 'busy'
                  ? t('标记中…', 'Marking…')
                  : phase === 'failed'
                    ? t('标记失败', 'Retry')
                    : confirming
                      ? confirmLabel
                      : t('✓ 完成', '✓ Mark done'),
              )
            : null

      return h(
        'span',
        { className: 'fxk-hd' },
        seqLabel
          ? h(
              'button',
              {
                type: 'button',
                className: 'fxk-hd-seq',
                'data-copied': seqCopy || undefined,
                title: seqCopy === 'ok'
                  ? t(`已复制编号 ${seqLabel}`, `Copied ${seqLabel}`)
                  : seqCopy === 'fail'
                    ? t(`复制失败，编号 ${seqLabel}`, `Copy failed — ${seqLabel}`)
                    : t(`卡片编号 ${seqLabel}，点一下复制`, `Card number ${seqLabel} — click to copy`),
                'aria-label': seqCopy === 'ok'
                  ? t(`已复制编号 ${seqLabel}`, `Copied ${seqLabel}`)
                  : seqCopy === 'fail'
                    ? t(`复制失败，编号 ${seqLabel}`, `Copy failed — ${seqLabel}`)
                    : t(`复制卡片编号 ${seqLabel}`, `Copy card number ${seqLabel}`),
                onClick: copySeq,
              },
              seqCopy === 'ok' ? t('✓ 已复制', '✓ Copied') : seqCopy === 'fail' ? t('复制失败', 'Copy failed') : seqLabel,
            )
          : null,
        headerWorktreeOf(card, state),
        h(
          'span',
          { className: 'fxk-hd-state', 'data-state': state, title: t(meta.hintZh, meta.hintEn) },
          h('span', { className: 'fxk-hd-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'fxk-hd-label' }, t(meta.zh, meta.en)),
        ),
        button,
      )
    }

    // ------------------------------------------------------------------ apply
    // 单个注册点失败不能拖垮整个客户端入口：DSH 认为必需入口未激活时会整体中断 web boot。
    function contribute(ctx, declaration, component, what) {
      try {
        return ctx.slots.register(declaration, component)
      } catch (failure) {
        console.error(`[kanban-fx] 注册${what}失败：`, failure)
      }
      try {
        if (typeof ctx.slots.inject === 'function') return ctx.slots.inject(declaration.name, () => ctx.slots.register(declaration, component))
      } catch (failure) {
        console.error(`[kanban-fx] 以 inject 方式注册${what}也失败：`, failure)
      }
      return undefined
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        try {
          ensureStyles()
        } catch (failure) {
          console.error('[kanban-fx] 注入样式失败：', failure)
        }
        contribute(ctx, { name: 'sidebar.panellist', id: 'kanban-fx', order: 30, label: () => t('任务看板', 'Task board') }, IconKanban, '侧边栏入口')
        contribute(ctx, { name: 'main', key: 'kanban-fx' }, Panel, '看板主面板')
        // 会话标题栏：卡片状态 + 完成。槽位由对话包声明，显式用 inject 等它就位；
        // 这里注册失败只丢这一处按钮，不能拖垮整个客户端入口。
        try {
          if (typeof ctx.slots.inject === 'function') {
            ctx.slots.inject('conversation.session.header.actions', () => {
              try {
                return ctx.slots.register(
                  { name: 'conversation.session.header.actions', id: 'kanban-card', order: 0 },
                  HeaderCardState,
                )
              } catch (failure) {
                console.error('[kanban-fx] 注册会话标题栏完成按钮失败：', failure)
                return undefined
              }
            })
          }
        } catch (failure) {
          console.error('[kanban-fx] 订阅会话标题栏失败：', failure)
        }
        // 工作区「…」菜单：把「打开任务看板」放在重命名（order 100）上面。
        // contextMenus 是可选依赖——没有菜单服务的 profile 里看板照常工作，只是少这一项。
        try {
          ctx.inject(['contextMenus'], (menuCtx) => {
            menuCtx.effect(() => menuCtx.contextMenus.register({
              id: 'kanban-fx.workspace-board',
              target: 'workspace',
              order: 50,
              resolve: ({ workspaceId }) => (workspaceId ? [{
                id: 'open-board',
                label: t('打开任务看板', 'Open task board'),
                icon: { key: 'kanban-fx.board' },
                failureLabel: t('打不开任务看板，请重试', 'Could not open the task board'),
                run: () => { openBoardPanel(workspaceId) },
              }] : []),
            }), 'kanban-fx: 工作区菜单入口')
          })
        } catch (failure) {
          console.error('[kanban-fx] 注册工作区菜单失败：', failure)
        }
        contribute(ctx, { name: 'contextMenu.icon', key: 'kanban-fx.board' }, KanbanMenuIcon, '工作区菜单图标')
      },
    }
  },
})
