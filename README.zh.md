# duckling

```
                                                              ____
                                                          ___/    \__
   __    __    __    __    __    __    __                /   o      \
  (o>   (o>   (o>   (o>   (o>   (o>   (o>                \_         >
   ~~    ~~    ~~    ~~    ~~    ~~    ~~                  \_______/
                                                             ||  ||
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

> **在 Telegram 上跑 Claude Code。** 开 session、看 plan 滚动、按按钮回答问题 —— 全程从手机上。

[![npm version](https://img.shields.io/npm/v/duckling-cli.svg)](https://www.npmjs.com/package/duckling-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/duckling-cli)](https://www.npmjs.com/package/duckling-cli)

[English](README.md) · **中文**

```bash
npm i -g duckling-cli   # 安装
duckling setup          # 扫码配对 @DucklingCli_Bot
duckling start          # 起 daemon → 在 TG 里跟 bot 聊
```

已发布到 npm：**[`duckling-cli`](https://www.npmjs.com/package/duckling-cli)**。要求 Node 18.17+，且本地装好 `claude`（用你已有的 OAuth，不用额外 API key）。

---

duckling 是一个小巧的 daemon，在你的电脑上跑官方的 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)，把它接到 Telegram。手机上发 prompt → Claude 在电脑上干活 → 结果、计划、问题以离散消息流回聊天，问题直接点按钮回答。

不用自己搭。我们维护了一个公用 bot（[@DucklingCli_Bot](https://t.me/DucklingCli_Bot)）和一个 Cloudflare Worker。装一个 npm 包，扫码，就完事。

## 为什么做这个？

Claude Code 在你电脑前的时候很好用，**离开电脑就麻烦了**：

- 🚇 在地铁里，想看跑了 20 分钟的任务到哪一步了。
- 🛏️ 躺床上，Claude 卡在 `AskUserQuestion` 等你点一下。
- 🏃 出门跑步，突然想起一个 refactor 想让 Claude 先动起来。

duckling 就是干这个的。**它不替代你的终端** —— 真要写代码还是 SSH 进去最快。duckling 给的是"环境感知" —— "好了没"、"批准这个操作"、"杀掉这个跑歪的分支"。

## 快速开始

两种用法，**二选一**。

### 路线 A —— 用公用 bot 🦆（推荐）

配对到我们维护的 bot（[@DucklingCli_Bot](https://t.me/DucklingCli_Bot)）+ 公用 Cloudflare Worker。**零基础设施。**

```bash
npm i -g duckling-cli           # 一次性安装
duckling setup                  # 一次性配对(QR + TG 点一下)
cd /path/to/your/project        # ← 在你要工作的项目目录下
duckling start                  # daemon 把这里当 cwd
```

发生了什么:
1. `npm i -g duckling-cli` —— 全局装 CLI。
2. `duckling setup` —— 终端弹一个 QR + `https://t.me/DucklingCli_Bot?start=…` 链接。扫码 / 点链接 → 在 Telegram 里按 **Start** → 配对完成。配置写到 `~/.config/duckling/config.json`。
3. **`cd` 进你的项目目录**。这一步很重要:daemon 把当前所在目录(你 `cd` 完的位置)当作 cwd,跑 Claude session 也在这个目录,`/new` 选择器列的是同一个目录下你 terminal 里已有的 `~/.claude/projects/<encoded-cwd>/*.jsonl`。
4. `duckling start` —— daemon 起来,连到公用 relay,顺手打印它锁定的 cwd 让你确认。

**你不需要** Cloudflare 账号、TG bot、任何部署。模型推理走你本地的 Claude OAuth,**不经过 relay**。

切换项目:`duckling stop && cd /other/project && duckling start`。

### 路线 B —— 自己跑 bot + Worker

如果你不想依赖公用 relay（搞团队私用、不放心中间层），就自己 host。命令行端完全一样，只是你（运维方）多做一次 Cloudflare 部署。

**运维方（你），一次性：**

```bash
git clone https://github.com/scao7/duckling-cli.git
cd duckling-cli
npm install
# 跟着 DEPLOY.md 走 —— 5 条 wrangler 命令：
#   wrangler login
#   wrangler secret put TELEGRAM_BOT_TOKEN     # 从 BotFather 来
#   wrangler secret put TG_WEBHOOK_SECRET      # 随便一个随机串
#   wrangler deploy                            # 输出你的 relay URL
#   curl … setWebhook                          # 告诉 TG 你的 webhook
```

**每个用户（用你 fork 的人），一次性：**

```bash
npm i -g duckling-cli
export DUCKLING_RELAY_URL=https://your-relay.your-subdomain.workers.dev
duckling setup
duckling start
```

`DUCKLING_RELAY_URL` 把配对和 daemon WebSocket 指到你自己的 Worker，不走我们这边。配对完成后这个 URL 会写进 `~/.config/duckling/config.json`，之后不用再 export。

完整 recipe + 费用计算（剧透：小团队在 Cloudflare 免费层下 **$0**）在 **[DEPLOY.md](DEPLOY.md)**。

### 两种路线都要

- **Node 18.17+**
- **本机能跑 `claude`，且登录了。** SDK 用你现有的 Claude OAuth —— 不用 API key，不会另外扣钱。命令行能跑 `claude --version` 就行。

### 配完之后 —— 跟 bot 聊

两种开任务方式:

**一行带任务:** 命令 + 任务一起发。

```
你：   /new 把 auth middleware 重构成新的 token 格式
Bot：  📋 refactor-auth-middleware              ← 边干边原地编辑
       ⬜ 读现有 middleware
       ⬜ 改成新 token 格式
       ⬜ 改测试
       ⬜ 跑 lint + 测试
Bot：  ❓ refactor-auth-middleware · Token 来源
       从 header 读,还是 header + cookie 都读?
       [ 只 header ] [ header + cookie ]         ← 点一个
       …                                          ← 干活时静默
Bot：  ✅ refactor-auth-middleware · completed · 4m12s · $0.0341
```

**点一下完事:** 光发 `/new`(不带任务)。Bot 列出本机这个 cwd 下已有的 session 选择器,点一个继续,或者点"➕ 新员工"开个空白的:

```
你：   /new
Bot：  🦆 派活给谁?选一个旧任务接着干,或者点 新员工 开个全新的。
       [ 把 auth middleware 重构…  · 12分钟前 ]
       [ 写个 quicksort           · 1小时前   ]
       [ 调 login 流程            · 昨天     ]
       [ ➕ 新员工                              ]   ← 点 = 生成"员工一号"
```

那些可恢复的行直接来自 `~/.claude/projects/<你的-cwd>/*.jsonl` —— 就是你 terminal 里 `claude` 一直在用的那些 session。点哪条都是**fork**(不会污染原 session 的滚动);点"新员工"就生成一个空白 session,名字自动 `员工一号` / `员工二号`...,你下一条消息就是它的第一个任务。

**总共四种消息**:plan、问题、完成、错误。没有 "我正在读文件 X"、没有 "正在跑 npm test..."、没有 🚀 启动横幅。聊天是用来报里程碑的,不是用来闲聊的。

## 能干啥

### 全部命令

| 命令 | 作用 |
|---|---|
| `/new` | 不带参数 → 选择器(恢复某个旧 session 或开新员工)。带参数 `/new <任务>` → 直接开 session 跑这个任务。 |
| `/kill` | 叫停一个 session。不带参数 → 弹列表选一个;带参数 `/kill <名字>` → 直接干掉那个。 |
| `/help` | 三行速查 |

`/` 菜单里就这**三条**。多一条都会变成"在手机上多一件可摆弄的事" —— 这工具的初衷就是拒绝这个。

### 不用打字也能做

- **直接发消息** —— 有当前 session 时,不带 `/` 的文字接着当前任务说("顺便处理一下 token 为空的情况")。如果你用 `/new` 起了个空白员工但还没派活,你下一条消息就是它的第一个任务。
- **一键决策** —— Claude 调 `AskUserQuestion` 时,每个选项变成按钮,点一下就行。
- **到处都是选择器** —— `/new` 和 `/kill` 不带参数都会弹**可点的列表**,永远不用记 session 名字或 ID。

### duckling 守的设计原则

1. **生产在电脑前**,这个工具只服务"不在电脑前"的时刻。其它情况都不该用它。
2. **让用户做更少,不是做更多。** 选择器 > 打字。默认值 > 配置。自动 > 手动。
3. **任何把用户拉回手机的功能都不要。** 让你"过来看看进度"的就是错的。
4. **消息越少越好。** 只发 plan、approve、完成、错误,以及 Claude 真没法不问你就推进的问题。
5. **下属关系,不是闲聊伙伴。** 员工不会跟老板一直 IM,只在里程碑和重要事情上汇报。
6. **加功能前问一句:这让用户能离开电脑,还是必须盯着手机?** 必须盯 → 拒绝。
7. **北极星:用户睡前发任务,醒来看一条"完成"消息。**

如果你 fork 出去之后冒出想加通知、加 dashboard、加 "实时尾巴"、加状态条、任何会让 bot 每个任务发不止一次声响的念头 —— 回来重读上面七条。duckling 整个就是围着这七条建的。
- **一键回答问题** —— Claude 调 `AskUserQuestion`，每个选项变成按钮，点一下就行。
- **Plan 原地编辑** —— `TodoWrite` 是一条消息持续更新，看着任务一项项打勾。
- **直接讲话** —— 不带 `/` 的文字默认进当前 session 接着聊。

## 怎么工作的

```
   你的手机                 Cloudflare Worker             你的电脑
 ┌──────────────┐            ┌───────────────┐           ┌──────────────────┐
 │ Telegram     │◀── Bot ───▶│ duckling-relay│◀── WS ───▶│ duckling daemon  │
 │  @Duckling…  │            │  + DOs        │           │  └ Agent SDK     │
 │              │            │               │           │     └ session 1  │
 │              │            │               │           │     └ session 2  │
 └──────────────┘            └───────────────┘           └──────────────────┘
                                                                  │ OAuth
                                                                  ▼
                                                          ┌──────────────────┐
                                                          │ Claude (你的订阅)│
                                                          └──────────────────┘
```

- **Daemon** 在本地跑 SDK，每个 `/new` 对应一个 `Session`。Session 有自己的输入流，你 TG 上发一句就推一句进去，SDK 流出事件就转给 relay。
- **Relay** 是 Cloudflare Worker，每个 TG 用户一个 Durable Object，持有 webhook、保管 hibernate 的 WebSocket、把 SDK 事件渲染成 TG 消息。
- **Anthropic 的推理调用不经过 relay**。SDK 直接从你机器上 OAuth 调 Claude。Relay 只是 control plane。

## 隐私 & 安全

- **代码不出你机器**，除非 Claude 自己决定读写文件 —— 那种情况下，文件路径 / 预览作为 tool_use 事件流过 relay。但**工具的输出**（测试日志、文件内容）不走 relay。
- **Relay 转发完就忘**。Durable Object 里只存：配对 token、设备记录、最近一次 sessions snapshot、问题回调的临时上下文。**不存代码，不存对话历史**。
- **不信任公用 relay 就自己部署**。Worker 是全部 —— `npx wrangler deploy` 你就拥有自己的 data plane。看 [DEPLOY.md](DEPLOY.md)。
- **Daemon 侧的认证是 deviceToken**，不透明的字符串，可以从 relay 上吊销。是你本机唯一的秘密。

## 自己部署

默认指向我们运营的公用 relay。想自己跑：

```bash
# 一次性，作为你自己 bot 的运维方
git clone https://github.com/scao7/duckling-cli.git
cd duckling-cli
npm install
# 跟着 DEPLOY.md 走 —— 五步：wrangler login + secret put + deploy + setWebhook
```

你 fork 出去之后，用户用：

```bash
export DUCKLING_RELAY_URL=https://your-relay.workers.dev
duckling setup
```

完整 recipe + 费用计算（剧透：小团队在 Cloudflare 免费层下 **$0**）在 **[DEPLOY.md](DEPLOY.md)**。

## 架构

| 层 | 干什么 | 代码 |
|---|---|---|
| CLI | `duckling setup\|start\|stop\|status` | [`src/cli/`](src/cli) |
| Daemon | 跑 SDK、管 session、维持 WS | [`src/daemon/`](src/daemon) |
| Worker | TG webhook、配对、转发到 UserDO | [`src/worker/`](src/worker) |
| Shared | 通信协议（`DaemonToRelay` / `RelayToDaemon`） | [`src/shared/protocol.ts`](src/shared/protocol.ts) |

代码量很小（TS ~1500 行），没用 framework。Daemon 端就是 node 原生 + `ws` + `commander`；Worker 端就是 raw `fetch` + Durable Objects。

设计文档（架构决策、为什么 duckling 只是"传话的"不做权限门）在 **[CLAUDE.md](CLAUDE.md)**。

## 开发

```bash
git clone https://github.com/scao7/duckling-cli.git
cd duckling-cli
npm install
npm run build        # tsc + worker typecheck

# CLI:
node dist/cli/index.js setup
node dist/cli/index.js start

# Worker 本地调（TG webhook 进不来 localhost，但 /pair/* 和 /healthz 能调）:
npm run worker:dev

# 改完部署:
npm run worker:deploy
```

## 路线图

还没做的：

- **`duckling attach`** —— 把你 SSH 终端里跑着的 `claude` session 交给 bot 接管，TG 那头继承同一段对话历史。
- **单机多 TG 用户** —— 当前是每个 Linux 用户一个 daemon。
- **回复定位 session** —— 让 TG 回复消息直接路由到对应 session，不用 `/switch`。
- **自动归档** —— 老 session 不自动清理。
- **diff 渲染** —— `Edit`/`Write` 用 code block 或图片渲染。

欢迎 PR。大改动先开 issue 聊聊。

## 贡献

提 PR 时：
- `npm run build` 必须通过（两边都是严格 TS）。
- 改协议的话 [`src/shared/protocol.ts`](src/shared/protocol.ts) 和 `src/daemon/`、`src/worker/` 里的处理函数都要一起改。

## License

[MIT](LICENSE) —— 随便 fork。公用 bot/relay 只是方便大家用，不是壁垒。

## 致谢

基于 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript)。 多轮对话的 streaming input 模式参考了 [openclaw-claude-code-plugin](https://github.com/openclaw/openclaw-claude-code-plugin)。
