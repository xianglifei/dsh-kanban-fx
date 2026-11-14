/**
 * 任务看板 · Client 半。
 *
 * 侧边栏入口 + 主面板：四列看板（待办 / 进行中 / 待审核 / 已完成）。
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
    const MAX_CARD_BYTES = 24 * 1024 * 1024
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    // 自动保存：停手 1.2 秒先存一次，连续打字时再每 8 秒兜底存一次
    const AUTOSAVE_IDLE_MS = 1200
    const AUTOSAVE_INTERVAL_MS = 8000
    // 看板是「某个工作区的视图」，没有「全部」。视图工作区记在浏览器本地：
    // 优先级 localStorage → defaultWorkspaceId（= 校验过的 lastWorkspaceId）→ 工作区列表第一个。
    const VIEW_WORKSPACE_KEY = 'dsh-kanban-fx.view-workspace'
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
        hintZh: '在执行中的卡片会出现在这里，右上角显示本轮已经跑了多久。',
        hintEn: 'Cards that are running show up here with a live timer.',
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

    let zhCache = null
    function isZh() {
      if (zhCache !== null) return zhCache
      let value = 'zh'
      try {
        const snapshot = pluginCtx?.get('locale')?.getSnapshot?.()
        value = String(snapshot?.locale ?? snapshot?.id ?? snapshot?.current ?? 'zh')
      } catch {}
      zhCache = value.toLowerCase().startsWith('zh')
      return zhCache
    }
    const t = (cn, en) => (isZh() ? cn : en)

    /** 状态 → 看板列的中文 / 英文名；列表和看板共用一套叫法。 */
    function statusLabelOf(status) {
      const column = COLUMNS.find((item) => item.id === status)
      return column ? t(column.zh, column.en) : String(status || '')
    }

    // ------------------------------------------- session header (card status)
    // 会话 → 卡片的探测结果：命中先画、再后台刷新，切回会话时标题栏不会闪一下空。
    const headerCardCache = new Map()
    // 从会话标题栏点「完成」跳回看板时，交接给看板面板的一条提示（带撤销）。
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
      return body.card || null
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
.fxk-btn-danger { color: var(--fxk-err); }
.fxk-btn-danger:hover { background: color-mix(in srgb, var(--fxk-err) 10%, transparent); }
.fxk-btn-icon { width: 30px; padding: 0; }
/* 标题旁的图标刷新：只是「立刻重读一次」的兜底，不跟工作区切换器抢位置 */
.fxk-sync {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; flex: none; padding: 0; margin-left: 1px;
  border: 0; border-radius: 6px;
  background: transparent; color: var(--fxk-text-3);
  cursor: pointer;
}
.fxk-sync:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-sync:active { color: var(--fxk-text-2); }
.fxk-sync:focus-visible { outline: 2px solid color-mix(in srgb, var(--fxk-brand) 55%, transparent); outline-offset: 1px; }

/* 视图切换：紧跟着页面标题，属于「这页是什么」，不和右侧的工作区 / 新建混在一组。
   两段式小控件，当前段浮起来；窄到 380px 以下只剩图标（aria-label 仍在）。 */
.fxk-viewswitch {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  height: 28px; margin-left: 6px; padding: 2px;
  border-radius: 8px; background: var(--fxk-hover);
}
.fxk-viewswitch button {
  height: 24px; padding: 0 10px; border: 0; border-radius: 6px;
  background: transparent; color: var(--fxk-text-2);
  font-size: 12px; line-height: 1; font-weight: 500;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
  cursor: pointer;
  transition: color 120ms, background 120ms;
}
.fxk-viewswitch button:hover { color: var(--fxk-text); }
.fxk-viewswitch button[data-active="true"] {
  background: var(--fxk-card); color: var(--fxk-text); font-weight: 560;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .08), 0 0 0 1px var(--fxk-border-soft);
}
.fxk-viewswitch button:focus-visible { outline-offset: 1px; }
.fxk-viewswitch svg { display: block; }
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
.fxk-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; line-height: 16px; color: var(--fxk-text-2); }
.fxk-chip {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 150px; height: 18px; padding: 0 6px;
  border-radius: 6px; background: var(--fxk-hover); color: var(--fxk-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fxk-chip-warn { background: color-mix(in srgb, var(--fxk-warn) 14%, transparent); color: color-mix(in srgb, var(--fxk-warn) 40%, var(--fxk-text)); }
.fxk-chip-err { background: color-mix(in srgb, var(--fxk-err) 12%, transparent); color: color-mix(in srgb, var(--fxk-err) 55%, var(--fxk-text)); }
.fxk-card-foot { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.fxk-card-foot-spacer { flex: 1; }
.fxk-mini {
  height: 24px; padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--fxk-border); background: transparent;
  font-size: 11.5px; line-height: 1; color: var(--fxk-text-2); cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.fxk-mini:hover { background: var(--fxk-hover); color: var(--fxk-text); }
.fxk-mini-ok { color: var(--fxk-ok-ink); border-color: color-mix(in srgb, var(--fxk-ok) 40%, var(--fxk-border)); }
.fxk-mini-ok:hover { background: color-mix(in srgb, var(--fxk-ok) 12%, transparent); color: var(--fxk-ok-ink); }
.fxk-mini-run { color: var(--fxk-text); border-color: color-mix(in srgb, var(--fxk-brand) 26%, var(--fxk-border)); }
.fxk-mini-run:hover { background: color-mix(in srgb, var(--fxk-brand) 10%, transparent); }
.fxk-timer { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--fxk-text-2); font-variant-numeric: tabular-nums; }
.fxk-timer b { font-weight: 600; color: var(--fxk-text); font-family: var(--fxk-mono); font-size: 12px; }
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
  .fxk-table thead th.c-task { padding-left: 27px; }
  .fxk-table tbody td.c-task { padding-left: 12px; }
  .fxk-table tbody td { height: 52px; }
  .fxk-table tbody td.c-acts { padding-right: 12px; }
  .fxk-mob-dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; flex: none; background: var(--fxk-idle); }
  .fxk-mob-dot[data-state="running"] { background: var(--fxk-brand); }
  .fxk-mob-dot[data-state="review"] { background: var(--fxk-warn); }
  .fxk-mob-dot[data-state="done"] { background: var(--fxk-ok); }
  .fxk-mob-timer { display: inline-flex; }
  .fxk-att, .fxk-table .fxk-chip { display: none; }
  .fxk-tablefoot { padding: 0 12px; }
  .fxk-foot-full { display: none; }
  .fxk-foot-short { display: inline; }
  .fxk-addrow { padding: 0 12px; font-size: 11.5px; }
}

/* 中等宽度（分屏 / 平板）：保留状态和任务，收起编号 / 用时 / 更新，
   避免固定列把任务标题挤成一条缝。表尾负责告诉你当前按哪一列排序。 */
@container (min-width: 701px) and (max-width: 1080px) {
  .fxk-table th.c-seq, .fxk-table th.c-dur, .fxk-table th.c-upd,
  .fxk-table td.c-seq, .fxk-table td.c-dur, .fxk-table td.c-upd { display: none; }
  .fxk-mob-timer { display: inline-flex; }
  .fxk-foot-full { display: none; }
  .fxk-foot-short { display: inline; }
}

/* 手机上先把标题行收紧一档，保住「看板 / 列表」两个文字标签 */
@container (max-width: 430px) {
  .fxk-head { gap: 6px; }
  .fxk-viewswitch { margin-left: 2px; }
  .fxk-viewswitch button { padding: 0 8px; }
  /* 保住「看板 / 列表」两个标签：顶部新建收成 +（表尾那条带文字的新建还在） */
  .fxk-head .fxk-btn { width: 30px; padding: 0; }
  .fxk-new-label { display: none; }
}

/* 再窄就只留图标，aria-label / title 还在 */
@container (max-width: 360px) {
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
.fxk-hd-state[data-state="review"] .fxk-hd-dot { background: var(--fxk-hd-review); }
.fxk-hd-state[data-state="done"] .fxk-hd-dot { background: var(--fxk-hd-done); }
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

/* 窄标题栏：状态只留圆点。文字不 display:none，而是收成 1px 的屏读文本，
   这样读屏仍然能读到「进行中 / 待审核 / 已完成」，按钮优先保留。 */
@container (max-width: 620px) {
  .fxk-hd-label {
    position: absolute; width: 1px; height: 1px;
    margin: -1px; padding: 0; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0;
  }
  .fxk-hd-state { padding: 0; }
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

    /** 循环箭头（Lucide rotate-cw，24 网格）：标题旁那个「立刻重读一次」的小按钮。 */
    function IconRefresh(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M21 3v5h-5',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
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
     * 列表的用时：进行中算当前这一轮，其余用上一次跑完的用时。
     * 排序和展示共用，避免「按用时排序」和看到的数字对不上。
     */
    function durationOf(card, now, skew) {
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
      // 「已完成」列默认折叠成标题行；只有用户点开的那几张会展开，状态只活在这个面板里。
      const [expandedDone, setExpandedDone] = useState(() => new Set())
      const [syncedAt, setSyncedAt] = useState(0)
      const [now, setNow] = useState(() => Date.now())
      const skewRef = useRef(0)

      const applyBoard = useCallback((payload) => {
        if (!payload || payload.ok !== true) return
        skewRef.current = Date.now() - Number(payload.serverNow || Date.now())
        setBoard({
          cards: Array.isArray(payload.cards) ? payload.cards : [],
          workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
          defaultWorkspaceId: payload.defaultWorkspaceId || null,
        })
        setSyncedAt(Date.now())
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
        const onFocus = () => void load({ quiet: true })
        window.addEventListener('focus', onFocus)
        return () => {
          disposed = true
          try {
            if (source) source.close()
          } catch {}
          clearInterval(watchdog)
          clearInterval(fallback)
          window.removeEventListener('focus', onFocus)
        }
      }, [load])

      const cards = board ? board.cards : []
      const workspaces = board ? board.workspaces : []
      const workspaceIds = workspaces.map((workspace) => workspace.id)
      const orphanCards = cards.filter((card) => !card.workspaceId)
      const missingCards = cards.filter((card) => card.workspaceId && !workspaceIds.includes(card.workspaceId))
      // 服务端兜底：defaultWorkspaceId 就是校验过的 lastWorkspaceId（不在列表里就退回第一个）
      const fallbackWorkspaceId =
        board && board.defaultWorkspaceId && workspaceIds.includes(board.defaultWorkspaceId)
          ? board.defaultWorkspaceId
          : (workspaceIds[0] || '')
      const isSelectable = (id) =>
        Boolean(id) && (workspaceIds.includes(id) || (id === BUCKET_NONE && orphanCards.length > 0) || (id === BUCKET_MISSING && missingCards.length > 0))
      // 用户上次选的视图 → 服务端默认工作区 → 异常抽屉（只在有这类卡片时）
      let activeWorkspaceId = null
      if (isSelectable(pickedWorkspaceId)) activeWorkspaceId = pickedWorkspaceId
      else if (fallbackWorkspaceId) activeWorkspaceId = fallbackWorkspaceId
      else if (orphanCards.length > 0) activeWorkspaceId = BUCKET_NONE
      else if (missingCards.length > 0) activeWorkspaceId = BUCKET_MISSING
      // 新建卡片必须落到一个真实工作区：视图停在异常抽屉时退回服务端默认值
      const currentWorkspaceId = workspaceIds.includes(activeWorkspaceId) ? activeWorkspaceId : fallbackWorkspaceId
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

      // 从会话标题栏点「完成」跳回来时，接住那条提示（带撤销）。
      // 读一次就清掉：面板重新挂载时不会重复弹。
      useEffect(() => {
        const notice = pendingBoardNotice
        if (!notice) return
        pendingBoardNotice = null
        const label = notice.seq ? `fx-${notice.seq}` : notice.title || t('这张卡片', 'the card')
        notify({
          text: t(`已把 ${label} 移到已完成`, `Moved ${label} to done`),
          undo: () => {
            void post('undone', { id: notice.cardId }).catch((failure) => notify({ kind: 'error', text: String(failure?.message ?? failure) }))
          },
        })
      }, [notify, post])

      const openCreate = useCallback(() => setModal({ mode: 'create', card: null }), [])

      /** 切换看板视图的工作区，并记住这个选择（只写浏览器本地，不碰服务端）。 */
      const selectWorkspace = useCallback((next) => {
        setPickedWorkspaceId(next)
        persistViewWorkspace(next)
      }, [])

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

      const markDone = useCallback(
        async (card) => {
          setBusy(`done:${card.id}`)
          try {
            await post('done', { id: card.id })
            notify({
              text: t('已移入已完成', 'Moved to done'),
              undo: () => {
                void post('undone', { id: card.id }).catch((failure) => notify({ kind: 'error', text: String(failure?.message ?? failure) }))
              },
            })
          } catch (failure) {
            notify({ kind: 'error', text: String(failure?.message ?? failure) })
          } finally {
            setBusy('')
          }
        },
        [post, notify],
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
          if (!card.sessionId) {
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

      const visibleCards = useMemo(() => {
        return cards.filter((card) => {
          if (activeWorkspaceId === BUCKET_NONE) return !card.workspaceId
          if (activeWorkspaceId === BUCKET_MISSING) return Boolean(card.workspaceId) && !workspaceIds.includes(card.workspaceId)
          if (!activeWorkspaceId) return true
          return card.workspaceId === activeWorkspaceId
        })
      }, [cards, activeWorkspaceId, board])

      const byColumn = useMemo(() => {
        const groups = { todo: [], running: [], review: [], done: [] }
        for (const card of visibleCards) {
          const key = groups[card.status] ? card.status : 'todo'
          groups[key].push(card)
        }
        groups.running.sort((a, b) => (a.runningSince || 0) - (b.runningSince || 0))
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

      const renderCard = (card) => {
        const state = card.status
        const isDone = state === 'done'
        const isFolded = isDone && !expandedDone.has(card.id)
        const title = workspaceTitle(card.workspaceId)
        const attachmentCount = (card.attachments || []).length

        // 已完成列默认只留标题行：整行点开才展开成完整卡片，避免已归档的卡片一直占满一整列。
        if (isFolded) {
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
            h('span', { className: 'fxk-card-title fxk-card-title-folded' }, card.title),
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
            'aria-label': card.title,
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
          h(
            'div',
            { className: 'fxk-card-meta' },
            title ? h('span', { className: 'fxk-chip', title }, title) : null,
            card.workspaceId && !title ? h('span', { className: 'fxk-chip fxk-chip-warn' }, t('工作区不可用', 'Workspace missing')) : null,
            attachmentCount ? h('span', { className: 'fxk-chip', title: t('附件', 'Attachments') }, `📎 ${attachmentCount}`) : null,
            card.sessionArchived ? h('span', { className: 'fxk-chip fxk-chip-warn', title: t('会话已归档', 'Conversation archived') }, t('会话已归档', 'Archived')) : null,
            card.error ? h('span', { className: 'fxk-chip fxk-chip-err', title: card.error }, t('有报错', 'Error')) : null,
          ),
          state === 'running'
            ? h(
                'div',
                { className: 'fxk-card-foot' },
                h('span', { className: 'fxk-timer' }, h('span', { className: 'fxk-pulse' }), h('b', null, formatElapsed(elapsedOf(card))), h('span', null, t('运行中', 'running'))),
                h('span', { className: 'fxk-card-foot-spacer' }),
                card.lastRunStartedAt ? h('span', { className: 'fxk-hint' }, t(`开始于 ${formatClock(card.lastRunStartedAt)}`, `since ${formatClock(card.lastRunStartedAt)}`)) : null,
              )
            : state === 'review'
              ? h(
                  'div',
                  { className: 'fxk-card-foot' },
                  h(
                    'span',
                    { className: 'fxk-hint' },
                    card.lastRunMs ? t(`用时 ${formatDuration(card.lastRunMs)}`, `took ${formatDuration(card.lastRunMs)}`) : t('已跑完，待你查看', 'Run finished'),
                  ),
                  h('span', { className: 'fxk-card-foot-spacer' }),
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
                      title: t('标记为已完成，移入已完成列', 'Mark as done and move to the Done column'),
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
                    h('span', { className: 'fxk-hint' }, card.doneAt ? t(`完成于 ${formatClock(card.doneAt)}`, `done ${formatClock(card.doneAt)}`) : t('已完成', 'Done')),
                    h('span', { className: 'fxk-card-foot-spacer' }),
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
                    h('span', { className: 'fxk-card-foot-spacer' }),
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
        return h(
          'section',
          { key: column.id, className: 'fxk-col', 'data-state': column.id, 'aria-label': isZh() ? column.zh : column.en },
          h(
            'header',
            { className: 'fxk-col-head' },
            h('span', { className: 'fxk-col-dot' }),
            h('span', { className: 'fxk-col-name' }, isZh() ? column.zh : column.en),
            h('span', { className: 'fxk-col-count' }, String(items.length)),
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
            h('span', null, t(column.zh, column.en)),
            h(IconSort, { active, dir: active ? sort.dir : column.dir }),
          ),
        )
      }

      const renderListRow = (card) => {
        const state = card.status
        const attachmentCount = (card.attachments || []).length
        const updatedAt = Number(card.updatedAt) || Number(card.createdAt) || 0
        const elapsed = elapsedOf(card)
        const duration =
          state === 'running'
            ? h('span', { className: 'fxk-timer' }, h('span', { className: 'fxk-pulse' }), h('b', null, formatElapsed(elapsed)))
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
                title: t('标记为已完成，移入已完成', 'Mark as done'),
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
              { className: 'fxk-state', 'data-state': state },
              h('span', { className: 'fxk-state-dot', 'aria-hidden': 'true' }),
              h('span', null, statusLabelOf(state)),
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
              h('span', { className: 'fxk-mob-dot', 'data-state': state, role: 'img', 'aria-label': statusLabelOf(state) }),
              h('button', { type: 'button', className: 'fxk-title', title: card.title }, card.title),
              attachmentCount
                ? h('span', { className: 'fxk-att', title: t('附件', 'Attachments') }, `📎 ${attachmentCount}`)
                : null,
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
                  { className: 'fxk-timer fxk-mob-timer' },
                  h('span', { className: 'fxk-pulse' }),
                  h('b', null, formatElapsed(elapsed)),
                )
              : null,
            h('div', { className: 'fxk-acts' }, actions),
          ),
        )
      }

      const renderListTable = () => {
        const total = visibleCards.length
        const open = total - totals.done
        const sortColumn = LIST_COLUMNS.find((item) => item.key === sort.key) || LIST_COLUMNS[0]
        const sortName = t(sortColumn.zh, sortColumn.en)
        const arrow = sort.dir === 'asc' ? '↑' : '↓'
        const footFull = isZh()
          ? `共 ${total} 张 · 待办 ${totals.todo} · 进行中 ${totals.running} · 待审核 ${totals.review} · 已完成 ${totals.done}`
          : `${total} cards · ${totals.todo} to do · ${totals.running} running · ${totals.review} review · ${totals.done} done`
        const footShort = isZh()
          ? `按${sortName} ${arrow} · 共 ${total} 张 · 未完成 ${open}`
          : `By ${sortName} ${arrow} · ${total} cards · ${open} open`

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
                          h('td', { colSpan: LIST_COLUMNS.length, className: 'fxk-empty-cell' }, t('这个工作区还没有卡片。', 'No cards in this workspace yet.')),
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

      // 看板视图 = 一个工作区。异常抽屉只在真的存在这类卡片时出现，平时完全看不到。
      const filterOptions = [
        ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.title })),
        ...(orphanCards.length > 0
          ? [{ value: BUCKET_NONE, label: `${t('未指定工作区', 'No workspace')} · ${orphanCards.length}` }]
          : []),
        ...(missingCards.length > 0
          ? [{ value: BUCKET_MISSING, label: `${t('工作区不可用', 'Workspace missing')} · ${missingCards.length}` }]
          : []),
      ]

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
              'button',
              {
                type: 'button',
                className: 'fxk-sync',
                title: syncedAt
                  ? t(`立即刷新（上次同步 ${clockOf(syncedAt)}）`, `Refresh now (last synced ${clockOf(syncedAt)})`)
                  : t('立即刷新', 'Refresh now'),
                'aria-label': t('刷新看板', 'Refresh board'),
                onClick: () => void load(),
              },
              h(IconRefresh, { size: 15 }),
            ),
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
        modal
          ? h(Editor, {
              key: modal.card ? modal.card.id : 'new',
              mode: modal.mode,
              card: modal.card,
              workspaces,
              defaultWorkspaceId: currentWorkspaceId || null,
              post,
              notify,
              onSaved: handleSaved,
              onClose: () => setModal(null),
            })
          : null,
        toast
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
          : null,
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
      const { mode, card, workspaces, defaultWorkspaceId, post, notify, onSaved, onClose } = props
      // 只回填用户手写的标题；派生标题留空，由占位符和下面的会话名预览兜住
      const [title, setTitle] = useState(card ? (typeof card.titleInput === 'string' ? card.titleInput : card.title) : '')
      const [body, setBody] = useState(card ? card.body : '')
      // 工作区必填：优先卡片自己的（校验它还在），否则用看板当前工作区。
      // 历史卡片没工作区、或工作区已被删时，打开编辑就顺手落到一个有效工作区。
      const initialWorkspaceId =
        card && card.workspaceId && workspaces.some((workspace) => workspace.id === card.workspaceId)
          ? card.workspaceId
          : defaultWorkspaceId || (workspaces[0] && workspaces[0].id) || ''
      const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
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
      latest.current = { title, body, workspaceId, kept, added }

      /** 真正落库一次：create 或 update；返回 { card, created }。 */
      const persist = useCallback(
        (options) => {
          const opts = options || {}
          const run = async () => {
            const state = latest.current
            if (!hasContentOf(state)) return null
            if (!opts.force && !dirtyRef.current) return null
            const version = changeRef.current
            const signature = attachmentSignature(state)
            let created = !savedIdRef.current
            setAuto((previous) => ({ kind: 'saving', at: previous.at }))
            try {
              const payload = {
                title: state.title.trim(),
                body: state.body,
                workspaceId: state.workspaceId || null,
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
        [post],
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
            if (projected + file.size > MAX_CARD_BYTES) {
              setError(t(`附件总大小超过 ${Math.round(MAX_CARD_BYTES / 1024 / 1024)} MB`, `Attachments exceed ${Math.round(MAX_CARD_BYTES / 1024 / 1024)} MB`))
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
        [totalBytes, markDirty],
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

      /** 关侧栏：先把没落库的改动补存一次；存失败就留在原地提示，不丢内容。 */
      const close = useCallback(() => {
        if (busy) return
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        if (!dirtyRef.current || !hasContentOf(latest.current)) {
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
      }, [busy, persist, onClose])

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
      const autoText =
        auto.kind === 'saving'
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
            if (event.target === event.currentTarget) close()
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
              if (event.key === 'Escape') close()
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
            h('button', { type: 'button', className: 'fxk-btn fxk-btn-icon', disabled: Boolean(busy), 'aria-label': t('关闭', 'Close'), onClick: close }, '✕'),
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
              h('div', { className: 'fxk-hint' }, formatBytes(totalBytes), t(' 已用（上限 24 MB）', ' used (24 MB limit)')),
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
                  ? workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, workspace.title))
                  : h('option', { value: '', disabled: true }, t('还没有工作区', 'No workspaces yet')),
              ),
              h(
                'div',
                { className: 'fxk-hint' },
                workspaces.length > 0
                  ? t('默认就是看板当前的工作区。执行时会在这个工作区里建会话，会话也会出现在侧边栏对应工作区下。', 'Defaults to the board’s current workspace. The run creates a conversation there, listed under it in the sidebar.')
                  : t('先在 DSH 里创建一个工作区，再回来建待办。', 'Create a workspace in DSH first, then come back.'),
              ),
            ),
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
                'data-kind': auto.kind,
                title: t('停手 1.2 秒或每 8 秒自动保存一次；关闭侧栏前会再补存一次。', 'Saves 1.2s after you stop typing and every 8s; flushes once more before closing.'),
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
      const running = useSession((snapshot) => snapshot.running)
      const alive = useRef(true)
      const wasRunning = useRef(running)

      const load = useCallback(async () => {
        try {
          const next = await fetchSessionCard(sessionId)
          headerCardCache.set(sessionId, next)
          if (alive.current) setCard(next)
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
          headerCardCache.set(sessionId, next)
          setCard(next)
        }
        if (wasRunning.current && !running) void load()
        wasRunning.current = running
      }, [running, card, sessionId, load])

      if (card === undefined || card === null || card.sessionArchived) return null

      const state = running ? 'running' : card.status === 'done' ? 'done' : 'review'
      const meta = HEADER_STATE[state]

      const openBoard = (workspaceId) => {
        const layout = pluginCtx?.get('layout')
        if (!layout || typeof layout.selectPanel !== 'function') {
          throw new Error(t('当前 DSH 版本无法打开任务看板', 'This DSH version cannot open the task board'))
        }
        if (workspaceId) persistViewWorkspace(workspaceId)
        // 面板是切 key 后重新挂载的，提示在挂载时消费；跳转失败就清掉，不留陈年提示
        const notice = { cardId: card.id, seq: card.seq, title: card.title }
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
        headerCardCache.set(sessionId, updated)
        if (!alive.current) return
        setCard(updated)
        setPhase('idle')
        // 看板记忆的工作区跟着卡片走，回到看板就能直接看见这张卡
        const workspaces = Array.isArray(body && body.workspaces) ? body.workspaces : []
        const workspaceId = workspaces.some((item) => item.id === updated.workspaceId) ? updated.workspaceId : null
        try {
          openBoard(workspaceId)
        } catch (error) {
          // 已经标好了，只是没跳过去：留一个「打开看板」的按钮兜底
          setFailure(String(error?.message ?? error))
          setPhase('board')
        }
      }

      const openBoardAgain = () => {
        try {
          openBoard(card.workspaceId || null)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        }
      }

      const doneHint = card.seq
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
                  'data-tone': phase === 'failed' ? 'error' : undefined,
                  disabled: phase === 'busy',
                  title: phase === 'failed' ? failure || t('标记失败，点击重试', 'Could not mark it done — click to retry') : doneHint,
                  onClick: () => void complete(),
                },
                phase === 'busy'
                  ? t('标记中…', 'Marking…')
                  : phase === 'failed'
                    ? t('标记失败', 'Retry')
                    : t('✓ 完成', '✓ Mark done'),
              )
            : null

      return h(
        'span',
        { className: 'fxk-hd' },
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
      },
    }
  },
})
