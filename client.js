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
        hintZh: '跑完的卡片会落到这里。点开进会话看结果，满意就点「已完成」。',
        hintEn: 'Finished runs land here. Open the conversation, then mark done.',
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
  max-width: 1240px;
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
.fxk-brand-title { font-size: 15px; line-height: 22px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
.fxk-head-spacer { flex: 1; min-width: 4px; }
/* 右上角是「看板的工作区」切换器，不是筛选器：给个显式标签，免得和侧边栏混淆 */
.fxk-filter { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.fxk-filter-label { font-size: 11.5px; color: var(--fxk-text-3); white-space: nowrap; }
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
.fxk-sync {
  height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--fxk-text-2); font-size: 12px; cursor: pointer;
}
.fxk-sync:hover { background: var(--fxk-hover); color: var(--fxk-text-2); }

/* ----------------------------------------------------------------- board */
.fxk-board {
  flex: 1; min-height: 0;
  width: 100%; max-width: 1240px; margin: 0 auto;
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

/* ------------------------------------------------------------ status bar */
.fxk-errorbar {
  flex: none;
  width: 100%; max-width: 1240px; margin: 0 auto 8px;
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
  .fxk-head .fxk-sync { display: none; }
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
}

@media (prefers-reduced-motion: reduce) {
  .fxk-pulse { animation: none; }
  .fxk-skeleton { animation: none; }
  .fxk-overlay, .fxk-sheet, .fxk-toast { animation: none; }
  .fxk-card:hover { transform: none; }
  .fxk-caret { transition: none; }
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
        try {
          source = new EventSource(`${API}/events`)
          source.addEventListener('rev', () => {
            void load({ quiet: true })
          })
        } catch (failure) {
          console.error('[kanban-fx] 变化订阅不可用：', failure)
        }
        const fallback = setInterval(() => void load({ quiet: true }), 15_000)
        const onFocus = () => void load({ quiet: true })
        window.addEventListener('focus', onFocus)
        return () => {
          if (source) source.close()
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

      const openCreate = useCallback(() => setModal({ mode: 'create', card: null }), [])

      /** 切换看板视图的工作区，并记住这个选择（只写浏览器本地，不碰服务端）。 */
      const selectWorkspace = useCallback((next) => {
        setPickedWorkspaceId(next)
        persistViewWorkspace(next)
      }, [])

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
                      disabled: busy === `done:${card.id}`,
                      onClick: (event) => {
                        event.stopPropagation()
                        void markDone(card)
                      },
                    },
                    '✓ ',
                    t('已完成', 'Done'),
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
        { className: 'fxk-root', 'data-narrow': narrowCol },
        h(
          'header',
          { className: 'fxk-head' },
          h(
            'div',
            { className: 'fxk-brand' },
            h('span', { className: 'fxk-brand-mark' }, h(IconKanban, { size: 16, active: true })),
            h('span', { className: 'fxk-brand-title' }, t('任务看板', 'Task board')),
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
              className: 'fxk-sync',
              title: syncedAt
                ? t(`立即刷新（上次同步 ${clockOf(syncedAt)}）`, `Refresh now (last synced ${clockOf(syncedAt)})`)
                : t('立即刷新', 'Refresh now'),
              onClick: () => void load(),
            },
            t('刷新', 'Refresh'),
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
            '+ ',
            t('新建待办', 'New card'),
          ),
        ),
        h(
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
        ),
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
        h('div', { className: 'fxk-board' }, COLUMNS.map(renderColumn)),
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
      const [title, setTitle] = useState(card ? card.title : '')
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
                placeholder: t('比如：把看板插件的存储层写完', 'e.g. finish the board storage layer'),
                onChange: (event) => {
                  setTitle(event.target.value)
                  markDirty()
                },
              }),
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
                  placeholder: t('写多少都行：背景、想法、可能的做法、验收标准……执行时会原样发给 DSH。', 'Anything: context, ideas, approach, acceptance criteria… sent verbatim when you run it.'),
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
      },
    }
  },
})
