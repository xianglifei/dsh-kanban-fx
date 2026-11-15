# 需求文档：卡片级 Git worktree（复用 DSH 工作树基建）

| 项目 | 内容 |
|---|---|
| 文档状态 | 已实现（0.6.0，2026-11-14） |
| 目标版本 | 0.6.0（minor，新能力） |
| 日期 | 2026-11-14 |
| 影响面 | `index.js`（能力探测 / 执行前置 / 状态机 / 存储 / 接口）、`client.js`（设置页 / 编辑器 / 卡片展示） |
| 依赖的 DSH | 0.2.2-rc.3（实测版本）。`ctx.worktrees` 属实验包，按「可选能力」对待 |
| 实现记录 | 按第 10 节四步落地；实现中额外修了「建会话 / 建树失败却显示待审核」与「失败卡片点开只能进空会话」两处旧问题。界面图未重拍（现有截图仍是 0.5.0 的） |
| 不在本期 | 自研 git 命令、基准分支选择、worktree 删除/恢复按钮、每工作区默认值、卡片自动清理 |

## 0. 一句话与结论

**一句话**：在设置页加一个「实验功能」开关，打开后新建 / 编辑卡片时多一个「在独立 worktree 中运行」的复选框（默认不勾）；勾上的卡片第一次执行时，先让 DSH 的工作树服务在仓库里建一条新分支和检出目录，把会话目录切过去，再投递卡片内容。

**结论**：方向成立，而且你对技术路线的判断是对的——**不要自己拼 `git worktree add`，用 DSH 现成的 `ctx.worktrees`**。理由见第 3 节：自己不实现，换来的不只是省事，还包括沙箱一致、会话事件、Forge 面板识别、归档清理这一整串行为。

但原方案有三处要修正：

1. **全局开关的语义不是「允许使用」，而是「在卡片上提供这个选项」**。能力有没有，由 DSH 那边是否启用了工作树服务决定，看板不能假装自己能开关它。不区分这两件事，会出现「设置开了但一点就报错」的状态。
2. **worktree 只在「第一次执行、建会话」的那一刻有意义**。它改的是会话的工作目录，属于一次性前置动作；卡片要能显示「准备工作树」「创建失败」「分支是 fx-12-xxx」这些状态，否则用户只会看到按钮转很久然后弹一个英文报错。
3. **「准备工作树」必须进状态机**。现在 `reconcile()` 3 秒后会把「投递了消息但 agent 没在跑」的卡片判成待审核。建 worktree 可能超过 3 秒，不处理就会出现「卡片闪回待审核、然后会话才开始跑」的错位。

## 1. 现状与问题

- 卡片第一次执行时，`runCard()` 用 `sessionController.create({ workspaceId })` 建会话，会话的工作目录就是工作区根目录，`agent.followup()` 投递正文。
- 于是同一工作区里并排跑两张卡片时，两个 agent 在**同一个检出目录**里改文件：未提交改动互相污染，`git status` 互相干扰，谁也不敢在中间提交。
- 用户现在只能自己开终端 `git worktree add`、再手动把 DSH 里那个会话 `cd` 过去——DSH 的会话目录是能切（`working_directory` 工具 / Forge 的「新建工作树」），但看板这边没有入口，而且看板建的会话不经过新会话页面，够不着 Forge 的那个选项。

典型场景：待办「给看板加 worktree 选项」和待办「修 README 里的截图」都属于同一个仓库，同时开跑，前者写 `index.js`，后者写 `README.md`，但两者共享同一个 `git status` 和同一份未提交区。用户想要的是「每张卡片在自己的分支上干活，互不干扰」。

## 2. DSH 已经提供了什么（实测 0.2.2-rc.3）

> 这一节是方案的依据，全部来自本机安装版本，路径都在 `app.asar/dsh/node_modules/@deepseek-ai/` 下。

| 能力 | 位置 | 事实 |
|---|---|---|
| 工作树服务 | `dsh-experimental-worktree`，服务名 `worktrees`，`ctx.worktrees` | `create(agent, { name?, from? }, signal?, onPhase?)`、`restore(...)`、`cleanupOf(session, revision)` |
| 模型工具 | `dsh-experimental-tool-worktree`，工具 `create_worktree` | 同一套服务的薄封装；装服务套件时顺带给模型 |
| 组合包 | `@deepseek-ai/dsh-experimental-tool-worktree`（独立「Git 工作树」） | 两行：`worktree` 服务 + `tool-worktree` 工具 |
| 统一入口 | `@deepseek-ai/dsh-experimental-forge-bundle`（「变更请求与工作树」） | 六行：同一服务与工具 + forge / forge-github / forge-session / forge-panel |
| 归档清理 | 服务内部 `archive.ts` | 归档会话时，若检出干净、无人引用、策略非只读，用 `git worktree remove` 删除检出、保留分支；`retainOnArchive` 可关掉 |

关键行为（决定了看板可以很薄）：

- `create()` 做的事：`workingDirectory.ensure(agent)` 拿到当前目录 → 从该目录 `rev-parse --show-toplevel` 得到仓库根 → `rev-parse HEAD` 钉住提交 → 在 `<仓库根>/.agents/worktrees/<branch>` 建分支和检出 → `workingDirectory.set(agent, path)` → 往会话日志追加 `plugin:worktree/created`，返回 `{ path, branch, baseCommit, repositoryRoot }`。
- `workingDirectory.set()` 会把 `Current working directory: "<path>".` 作为一条用户上下文通知排进 agent 收件箱，**在下一次请求里自动带上**（正常就是卡片第一条消息那一轮）。所以看板不需要在正文里再写「你现在在 worktree 里」。
- 服务自己处理了 `check-ref-format`、分支/目录已存在报错、父目录 `.gitignore`、禁用 clean/smudge filter、超时与取消。
- 限制（照抄，别承诺更多）：只从本地提交创建，不 fetch、不初始化子模块、不复制暂存/未暂存/未跟踪文件；仓库是 linked worktree、或会话策略只读时不可用；名字必须能通过 `check-ref-format`。

**启用方式（写进文档的关键一条）**：按 0.2.2 的升级指南，Web / Desktop 的「设置 → 插件」里，独立的「Git 工作树」卡片已被隐藏，统一入口是**「变更请求与工作树」**（forge 套件）。两者都选会插入重复的 `worktree` / `tool-worktree` 行，组件控件变只读，所以只能选一个。当前这个 profile 两个都没启用，所以本功能的第一次体验必然是「设置里灰着 + 一句去插件页启用的说明」。

## 3. 为什么不自己实现

| 维度 | 自己 `git worktree add` | 用 `ctx.worktrees` |
|---|---|---|
| 执行权限 | 插件进程直接起 git，绕过会话沙箱策略 | 按会话的 `sandboxPolicy` 在沙箱子进程里跑，和会话能力一致 |
| 目录切换 | 得自己调 `workingDirectory.set`，还得处理通知、投影、并发 | 服务内部完成并保证顺序 |
| 会话日志 | 没有 `plugin:worktree/created`，Forge 面板、会话列表、投影都不认 | 自动写事件，Forge 的「变更视图 / 恢复工作树 / 归档清理」全部认 |
| 命名 / 冲突 / 忽略 | 自己写，且要跟 DSH 的默认池子对齐 | 池子（`.agents/worktrees`）、`namePrefix`、`.gitignore` 都由服务落；看板只传一个合法名字 |
| 归档清理 | 自己扫、自己删，还要判断干净与否 | 服务已实现（含 `retainOnArchive` 开关） |
| 版本兼容 | 永久维护 | 实验 API 会变，但只需跟进一处 |

结论：自己实现的唯一收益是「少依赖一个实验包」，代价是把上面五件事重新做一遍，而且做出来是个 Forge 不认识的野 worktree。不划算。**沿用 DSH 基建是对的。**

代价也要说清楚：`ctx.worktrees` 是 experimental 包，0.2.2 的预发布期里默认命名、插件页入口、归档清理都改过一轮（见 DSH 安装包里的 `docs/upgrade-guide/` 三篇工作树迁移指南）。所以实现上必须「能力探测 + 全部 try/catch + 缺失时不拖垮看板」，不能把它当稳定契约。

## 4. 产品设计

### 4.1 两级开关，各管一件事

| 层级 | 位置 | 语义 | 默认 | 谁来管 |
|---|---|---|---|---|
| 全局 | 设置 → 实验功能 → 「在卡片上提供独立工作树」 | **入口开关**：卡片编辑器里要不要出现这个复选框 | 关 | 看板设置（`board.json`） |
| 卡片 | 新建 / 编辑卡片的表单 | **本次意图**：这张卡片第一次执行时，要不要新检出 | 不勾 | 卡片字段（不可执行后修改） |

为什么不做「全局默认勾选」：worktree 是一个有成本的选择（多一份检出、多一条分支、未提交改动不会带过去）。默认帮用户勾上，等于替用户决定「这个任务需要隔离」，第一次遇到的人只会觉得「为什么我的文件不见了」。全局开关只负责「让不让看到」，勾不勾永远由人决定。

### 4.2 设置页

设置页现在是两张卡：「完成之后」「高级（只读）」。**不要**把可编辑项塞进只读的「高级」，新增第三张卡放在两者之间：

```
┌ 实验功能 ────────────────────────────────┐
│ [ ] 在卡片上提供「独立工作树」           │
│     打开后，新建或编辑卡片可以勾选在独立  │
│     worktree 里运行。第一次执行时会在仓库 │
│     .agents/worktrees/ 下新建分支与检出。 │
│                                          │
│ 状态：当前 DSH 未启用工作树服务          │
│ 去「设置 → 插件」启用「变更请求与工作树」│
└──────────────────────────────────────────┘
```

- 服务不可用时：复选框禁用，显示原因与启用路径，**不隐藏**（隐藏了用户永远不知道有这功能，也不知道为什么别人的截图里有）。
- 服务可用、开关打开时：卡片表单出现复选框。
- 保存仍走现有 `POST /kanban-fx/settings`，新字段与 `completion` 平级，缺字段时保留旧值（向后兼容）。

### 4.3 卡片编辑器

放在「所属工作区」下面，只在以下条件**全部**满足时出现：

1. 设置里打开了全局开关；
2. Host 报告 `worktrees` 服务可用；
3. 这张卡片还没有会话（执行过就锁住，和现在的「已执行的卡片不能再改内容」一致）。

```
┌ 在独立 worktree 中运行 ──────────────────┐
│ [ ] 第一次执行时新建分支与检出             │
│     会在 <仓库>/.agents/worktrees/ 下建    │
│     分支 fx-12-<标题slug>，会话目录切过去。│
│     源目录里未提交的改动不会带过去。        │
└──────────────────────────────────────────┘
```

- 默认不勾；「立即执行」与「只保存」都尊重它。
- 没选工作区时勾选框也禁用，提示「先选工作区」——工作区是 worktree 的仓库来源。
- 勾了但关掉全局开关：已勾过的卡片保留字段，执行时按「未勾」处理（不静默建），编辑这张卡时给一句「已关闭，此卡片执行时不会新建工作树」。这样用户改设置不会破坏已有卡片的数据。
- 全局开关只影响「新建」：已经建好的 worktree 在卡片再次执行时仍然沿用，不会因为关掉开关就被搬回项目目录。

### 4.4 卡片展示

- 有 worktree 的卡片右上角加一个安静的分支 chip：`⎇ fx-12-kanban-worktree`（全中文标题时就是 `⎇ fx-12`）。tooltip 写完整路径。
- 准备阶段：chip 变成「准备工作树…」，卡片状态文案与「收尾中」同构（仍在进行中列，但写「准备工作树」）。
- 失败：卡片回到待办，`error` 里是中文外壳 + 服务原文（如「工作树创建失败：worktree branch already exists: fx-12」）；卡片上给一条警告 chip「工作树创建失败」，编辑器里保留勾选状态，重试会换一个新名字再试。
- 只读「高级」里加一行 `工作树服务：可用 / 未启用`，方便排障。

### 4.5 会话侧

不改。启用 forge 后，会话列表行、Forge 面板、变更视图读的是同一个服务与投影，会自动认出这是「这个会话创建的 worktree」，分支、基准提交、diff、恢复按钮都是白送的。看板只需要把 `path` / `branch` 存下来展示。

## 5. 数据模型

`board.json`，`STORE_VERSION` 不变（新增字段全部可缺省，读盘时补齐）：

```jsonc
// settings
{
  "completion": { "mode": "none", "prompt": "" },
  "worktree": { "offer": false }        // 新增：是否在卡片上提供选项
}

// card
{
  "worktree": {
    "requested": true,                   // 用户的意图；执行后仍保留，作为历史
    "branch": "fx-12-kanban-worktree",   // 以下 5 个成功后才写
    "path": "/repo/.agents/worktrees/fx-12-kanban-worktree",
    "baseCommit": "…",
    "repositoryRoot": "/repo",
    "phase": null,                       // 'prepare' | 'checkout' | null（仅创建过程中）
    "error": null,                       // 最近一次创建失败的中文消息
    "createdAt": 1763000000000
  },
  "preparingSince": 1763000000000        // 新增：创建中标记，成功/失败即清空
}
```

- `viewOf()` 增加 `worktree: { requested, branch, path, phase, error } | null`、`preparing: boolean`；不把 `baseCommit` / `repositoryRoot` 全丢给前端，够用就行（tooltip 需要 path）。
- `loadStore()` 的卡片白名单补默认值：旧数据 `worktree` 缺省为 `{ requested: false }`；`sanitizeUserSettings()` 补 `worktree.offer = false`。
- 不要为这个功能升级 `STORE_VERSION`：字段可缺省，升版本只会让旧客户端 / 旧数据多一次无谓迁移。

## 6. 状态机与时序

### 6.1 `runCard()` 的改动（新会话分支）

```js
// 已存在 workspaceId / 会话复用、resolveAgent 之后，投递之前
// 全局开关关掉时按「未勾」处理：不报错、直接不建
if (userSettings.worktree.offer && card.worktree?.requested && !card.worktree?.path) {
  const worktrees = ctx.get('worktrees')
  if (!worktrees?.create) throw httpError(409, '当前 DSH 没有工作树服务，请先在「设置 → 插件」启用「变更请求与工作树」')
  if (!card.workspaceId) throw httpError(409, '这张卡片没有工作区，无法确定在哪个仓库建工作树')

  card.preparingSince = Date.now()
  card.worktree.phase = 'prepare'
  card.worktree.error = null
  touch(card, 'worktree-prepare')

  try {
    const created = await worktrees.create(agent, { name: branchNameFor(card) }, undefined, (phase) => {
      card.worktree.phase = phase
      touch(card, 'worktree-phase')
    })
    Object.assign(card.worktree, created, { phase: null, createdAt: Date.now() })
  } catch (error) {
    card.preparingSince = null
    card.worktree.phase = null
    card.worktree.error = `工作树创建失败：${error.message}`
    touch(card, 'worktree-failed')
    throw httpError(409, card.worktree.error)   // 卡片没跑，别假装跑过
  }

  card.preparingSince = null
  touch(card, 'worktree-ready')
}

// 复用会话、但卡片记着 worktree、新会话目录不在里面（归档后「重新执行」）：
if (card.worktree?.path && 是新会话) {
  const wd = ctx.get('workingDirectory')
  if (wd?.set) await wd.set(agent, card.worktree.path)   // 路径不在就抛错，提示手工处理
}
```

要点：

1. **先建 worktree，再设 `runningSince` / `followup`**。这样通知天然排在第一轮请求里，卡片也不会出现「建目录过程中被 reconcile 判成结束」。`nameSession()` 是例外，要提前（见下一条）。
2. **失败保留会话，但卡片回待办**。会话已经建了（`sessionController.create` 先于 worktree），看板也没有删除会话的入口（DSH 侧只有归档），所以不删；重试复用同一个会话，`worktree.path` 还是空，会再试一次。为了让侧边栏里那个空会话可辨认，`nameSession()` 提到创建 worktree 之前。
3. **`statusOf()` 补一条**：`if (card.sessionId && !card.lastRunStartedAt && !card.doneAt) return TODO`。否则「建会话成功、消息没投出去」会被判成待审核——这也是现在 `resolveAgent` 失败的既有毛病，顺手修掉。
4. **`reconcile()` 无条件跳过 `preparingSince` 的卡片**（和 `finishingSince` 同样的宽限思路，但这里不用 10 秒，直接不猜：创建结束会自己清标记）。`runCard()` 的 409 守卫同时看 `runningSince || preparingSince`。
5. **成功后回到现有流程**：设 `runningSince`、投递、由 `turn/start` / `turn/end` 接管时间，worktree 相关字段不再变。

### 6.2 状态流转

```
待办 ──点执行──► [preparingSince] 进行中（准备工作树…）
                    │成功
                    ▼
                 投递消息 → turn/start → 进行中 → turn/end → 待审核 → 完成
                    │失败
                    ▼
                 待办（error：工作树创建失败，可重试）
```

## 7. 分支命名与冲突

- 规则：`fx-<seq>-<ascii slug>`，slug 取标题里的 ASCII 字母数字，转小写、连字符连接、截 24 字符；标题全是中文时只留 `fx-<seq>`。
- 为什么不用 DSH 的默认生成名：看板的价值是「卡片 fx-12 ↔ 分支 fx-12-xxx」可对应，`dsh-6b1f02c4-9a3e` 做不到。
- 冲突：`fx-12` 撞上上一次失败残留的分支时，`create()` 会抛 `worktree branch already exists`。捕获后换 `fx-12-<4位随机hex>` 重试一次；仍失败就报错，不做第三轮。
- 名字必须过 `check-ref-format`：slug 只保留 `[a-z0-9-]`，天然合法；空 slug 时 `fx-<seq>` 也合法。

## 8. 边界与失败态

| 场景 | 表现 | 处理 |
|---|---|---|
| 插件页没启用工作树（开关开着） | 设置页开关禁用 + 说明；卡片不出现复选框 | 已有卡片若仍勾着 → 409 中文提示，不建、不跑 |
| 全局开关被关掉（卡片还勾着） | 卡片不出现复选框，执行照常 | 按「未勾」处理：在项目目录跑，不报错、不建 worktree |
| 工作区不是 git 仓库 | `rev-parse --show-toplevel` 失败 | 409「这个工作区不是 Git 仓库，无法新建工作树」，卡片回待办 |
| 会话策略只读 | git 写入被拒 | 同上，原文附后；文档注明需要 workspace-write / danger-full-access |
| 仓库本身是 linked worktree | 公共 Git 目录在可写根外 | 创建失败，原文附后；文档写「暂时不可用」 |
| 大仓库检出慢 | 卡片「准备工作树…」持续数分钟 | DSH 自带 5 分钟超时；本期不做取消，文档写明 |
| 同一仓库两张卡同时建 | git 公共目录锁竞争，偶发失败 | 报错可重试；文档提一句 |
| worktree 被外部删掉 | 新会话进不去旧目录 | `wd.set` 失败 → 409「工作树目录已不存在」；本期不做恢复，指路 Forge 的「恢复工作树」 |
| 卡片删除 | 会话与 worktree 都不动 | 文档写明：worktree 归会话/DSH 管，删卡片不等于删分支；归档会话才会触发清理 |
| 会话归档触发清理 | 干净检出被删、分支保留 | 卡片 `sessionArchived` 已有徽标；worktree 字段只作历史展示 |

## 9. 接口变更

- `GET /kanban-fx/board`：`settings` 增加 `worktree`；`advanced.capabilities.worktrees` 为布尔；`cards[].worktree` / `cards[].preparing`。
- `POST /kanban-fx/settings`：接受 `{ completion, worktree }`；`worktree` 缺失时保留旧值（老客户端不破坏）；`offer` 只收布尔。
- `POST /kanban-fx/card` 的 `create` / `update`：接受 `worktree: { requested: boolean }`；`update` 时若卡片已有会话，忽略该字段（和现有 409 规则一致）。
- `POST /kanban-fx/card` 的 `run`：新增 409 文案（服务缺失 / 无工作区 / 非 git 仓库 / 创建失败）。
- 没有新端点，没有新依赖，没有新配置项。

## 10. 实施拆分

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | Host：能力探测、settings 读写、`loadStore` 卡片白名单、`viewOf` | 老 `board.json` 能读、能写回；`/board` 能看出服务有无 |
| 2 | Host：`runCard` 前置、`preparingSince`、`statusOf` / `reconcile`、命名与重试、错误文案 | 在 git 仓库工作区里跑通一张卡；非 git 工作区报中文错且卡片回待办 |
| 3 | Client：设置页「实验功能」卡（含禁用态与说明）、编辑器复选框、`post` 载荷 | 开关 → 复选框出现 → 保存 → 刷新后仍在 |
| 4 | Client：卡片分支 chip / 准备中文案 / 失败态；README、CHANGELOG、截图 | 浅色 / 深色 / 窄屏三张图，读起来像本来就有的功能 |

估工：第 1–2 步各半天，第 3–4 步各半天到一天，加上文案与截图约 2–3 天。

## 11. 测试与验收清单

1. 未启用工作树服务：设置页开关禁用且说明可操作；卡片无复选框；在 `board.json` 里硬写 `requested: true` 后执行 → 409 中文提示，卡片仍在待办。
2. 启用「变更请求与工作树」后重启：设置页可开；新建卡片勾选 → 立即执行 → 卡片「准备工作树…」→ 会话出现在侧边栏并已切到 `.agents/worktrees/fx-N-…` → 首条消息正常。
3. `git worktree list` 能看到该目录与分支；分支名与卡片编号对应；源检出 `git status` 不受影响。
4. 取消勾选再执行：不建 worktree，会话在项目目录（回归）。
5. 非 git 工作区、只读策略、branch 已存在（手工 `git branch fx-12`）：三种失败都回待办、给中文可读原因，重试行为符合预期。
6. 卡片执行后，编辑器不再显示复选框（与「不能改内容」一致）；已完成卡片仍显示分支 chip。
7. 归档该会话：DSH 的清理行为（干净 → 删除检出、保留分支）与卡片展示不冲突；「重新执行」在目录已删时给明确错误。
8. 双开两张卡在同一个仓库：各自分支、互不污染；同时创建时若遇锁冲突，报错可重试。
9. 深浅色、窄屏（编辑器与设置页）、键盘可达（复选框可 Tab、可 Space）、i18n 中英两套文案。
10. `README.md` 增加功能说明与前置条件（插件页启用哪个套件、需要 git 仓库、未提交改动不带走），`CHANGELOG.md` 顶部加 0.6.0 条目，`package.json` 版本同步。

## 12. 风险与已定方案

- **实验 API**：`ctx.worktrees` 所在包名带 experimental，0.2.2 预发布期改过默认命名、插件页入口、归档清理。缓解：能力探测、所有调用兜底、文档写「需要 0.2.2-rc.3 及以上」。
- **HTTP 长请求**：`run` 会等到 worktree 建完才返回，编辑器按钮会转很久。缓解：SSE 已经把「准备工作树」推到看板；本期接受，后续可改成 202 + 后台任务。
- **没有取消**：建到一半用户想停，只能等 DSH 的 5 分钟超时或停掉插件。本期接受，和「执行中不能删卡片」同一档。
- **删卡片不清理 worktree**：可能留下分支和目录。本期只写文档；后续可加「归档会话并清理」按钮。
- **已定 1**：全局开关叫「在卡片上提供独立工作树」，因为它描述的是入口，不是能力。
- **已定 2**：新会话（归档后重新执行）沿用同一份 worktree；路径不在时给明确错误，不自动重建。
- **已定 3**：不记忆「上一张卡片勾没勾」，避免「这次怎么自己勾上了」。
- **已定 4**：不改用户 profile；做运行时指路 + README 一节说明启用哪个套件。

## 13. 不在本期

- 基准分支选择（`from` 用 `HEAD`）。
- worktree 的删除 / 恢复 / 锁定按钮（交给 Forge 面板与 DSH 归档清理）。
- 每工作区默认值、按仓库记忆。
- 卡片表单之外的第二入口（列表视图、批量创建）。
- 自研任何 git 命令。
