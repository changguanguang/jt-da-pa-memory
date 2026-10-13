# jt-da-pa-memory 🧠

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的一个**个人 AI 风格跨会话记忆插件**。

它记住的是「你这个人」——身份、偏好、长期事实、教训——而不是聊天记录。带**个性化画像**、**主动打扰**、**空闲 dream 整理**。每条记忆带出处，可读可改，遗忘可撤销，并有相关性 + 重要性 + 时间衰减三层打分。

**零运行时依赖**：纯 ESM JavaScript，只用 Node 内置模块，不 import 任何 dsh 包，不需要编译。

---

## 三大能力

### ① 个性化长期记忆

- **记住「你这个人」**：7 类记忆 —— `identity` / `preference` / `fact` / `project` / `lesson` / `goal` / `other`。
- **个性化画像**：每轮把「【关于你】」（身份 + 偏好）优先注入系统提示词，再补核心/最近记忆。
- **可读可改**：记忆是普通 JSON 文件，删一行就忘掉，加一行就记住。
- **出处**：每条记录来源、项目归属、时间戳。
- **遗忘可撤销**：每次删除/合并/归档进日志，可 `memory_undo`。
- **相关性排序**：`IDF（稀有词权重高）× importance × 时间衰减（45 天半衰期）`，CJK 用 bigram 分词。

### ② 主动打扰（结合 dsh 定时服务）

- **`memory_remind` 工具**：模型说「提醒我……」，就经 **dsh 的 `ctx.schedule`** 排定一次唤醒 ——
  到点由 dsh-schedule 还原会话、发一条消息，**你主动去找用户说**。
- 支持全部时间选择器：`after_seconds`（几秒后）/ `at`（绝对时刻）/ `daily` / `weekly` / `cron`。
- `memory_reminders` 列出、`memory_cancel_reminder` 取消。
- **无 `dsh-schedule` 的 profile 会优雅降级**（相关工具返回明确错误，其余功能照常）。
- 例：*「每天早上 9 点提醒我看看今天的安排」→ `memory_remind({ text:"看今天的安排", daily:{ time:"09:00:00", time_zone:"Asia/Shanghai" } })`*

### ③ dream（空闲整理）

- **空闲自动整理**：记忆写入后空闲 ≥ `dream.idleMinutes`（默认 30 分钟）且此后未 dream 过，自动整理：
  - 合并近重复
  - 删除空条目
  - 归档**陈旧、低价值、从未访问**的记忆（`archiveAfterDays` 默认 120 天；importance ≥ 3 永不归档）
- **全程可撤销**（`memory_undo`）。
- 手动触发：`memory_dream` 工具，或输入框敲 **`/dream`**。
- 定时器包在 `ctx.effect` 里，插件卸载即清理。

---

## 工具（11 个）

| 工具 | 作用 |
|---|---|
| `memory_remember` | 记住一条事实（去重 / 合并 / `replaces` 更新） |
| `memory_recall` | 按 query 检索相关记忆 |
| `memory_forget` | 删除（按 id 或 query），可撤销 |
| `memory_update` | 修改一条记忆 |
| `memory_list` | 列出全部记忆（透明） |
| `memory_profile` | 读取「关于你」个性化画像 |
| `memory_remind` | **安排一次主动打扰**（经 dsh 定时服务） |
| `memory_reminders` | 列出已安排的主动提醒 |
| `memory_cancel_reminder` | 取消一条提醒 |
| `memory_dream` | 手动整理记忆 |
| `memory_undo` | 撤销最近一次改动 |

## 人类命令

| 输入 | 效果 |
|---|---|
| `/memory` | 列出全部记忆（含【关于你】画像、id、类别、时间） |
| `/memory forget 靠窗` | 删除所有包含「靠窗」的记忆 |
| `/memory forget id:pm_1a2b3c4d` | 按 id 删除一条 |
| `/memory undo` | 撤销最近一次删除 / 合并 / 归档 |
| `/memory tidy` | 整理（同 dream） |
| `/memory profile` | 只看【关于你】画像 |
| `/profile` | 同上（单独命令） |
| `/dream` | 手动整理记忆 |
| `/memory help` | 显示帮助 |

---

## 安装

先决条件：已装 dsh（`npx @deepseek-ai/dsh web` 至少能跑起来）。Node 20+。

### 方式 A：从 GitHub 装（推荐）

```sh
dsh plugin --profile web add github:changguanguang/jt-da-pa-memory
npx @deepseek-ai/dsh web
```

### 方式 B：直接装本地目录

```sh
dsh plugin --profile web add /path/to/jt-da-pa-memory
npx @deepseek-ai/dsh web
```

### 方式 C：手动写入用户 patch 层

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: jt-da-pa-memory
      name: '/absolute/path/to/jt-da-pa-memory/index.js'
```

### 验证

```sh
dsh --profile web --dump-config | grep jt-da-pa-memory
```

启动后在新会话说 **「记住我坐飞机喜欢靠窗」**，再开一个新会问问 **「我订机票有什么偏好吗」**。

---

## 配置（可选）

在 patch 的插件行里加 `config`：

```yaml
- insert:
    - id: jt-da-pa-memory
      name: 'jt-da-pa-memory'
      config:
        dir: '/absolute/path/to/store'      # 默认 $DSH_HOME/jt-da-pa-memory
        dream:
          enabled: true                     # 关掉空闲整理
          idleMinutes: 30                   # 空闲多少分钟后 dream
          archiveAfterDays: 120             # 陈旧多少天后归档（0 = 不归档）
        proactive:
          enabled: true                     # 关掉主动打扰
```

---

## 查看与删除记忆

### 方式 1：`/memory` 命令（最方便）

```
> /memory
你的个人记忆（共 3 条）：
【关于你】
  名字叫小蓝  [pm_69b532ea]
  喜欢简短的回答  [pm_1a2b3c4d]
【其他】
  （fact）在北京工作 · 今天  [pm_a2233f4c]
```

### 方式 2：直接编辑记忆文件

| 系统 | 路径 |
|---|---|
| Windows | `C:\Users\<你>\.dsh\jt-da-pa-memory\memory.json` |
| macOS / Linux | `~/.dsh/jt-da-pa-memory/memory.json` |
| 设了 `DSH_HOME` | `$DSH_HOME/jt-da-pa-memory/memory.json` |

删掉 `memories` 数组里的一整个 `{...}` 条目就删掉一条记忆。改完保存，重启或下一轮生效。

### 方式 3：让 agent 操作

| 你对 agent 说 | 触发的工具 |
|---|---|
| 「你知道我什么」 | `memory_list` |
| 「忘掉靠窗那件事」 | `memory_forget` |
| 「撤销刚才的删除」 | `memory_undo` |
| 「每天早上 9 点提醒我……」 | `memory_remind` |

### 在哪里「看到」记忆生效

记忆不是显示在某个面板里，而是**每轮对话自动注入**给模型。验证：记一条 → 新开会话 → 问相关问题，它能答上来就说明生效了。

### 在哪里看「用户画像」

画像 = 记忆里 `identity` + `preference` 两类，即注入里的【关于你】段。三种看法：

1. 输入框敲 **`/profile`**（或 `/memory profile`）—— 直接列出身份与偏好。
2. 问 agent「**你了解我什么**」→ 它会调 `memory_profile`。
3. 看 `memory.json` 里 `category` 为 `identity` / `preference` 的条目。

> 画像不会自己出现——它来自你告诉 agent 的关于自己的事。你可以直接说「记住我叫小蓝，是后端工程师」「记住我喜欢简短的回答」，它们会归到 `identity` / `preference`。

---

## ⚠️ 关于「提醒」：谁实现的

**提醒的投递引擎是 dsh 自带的，不是本插件发明的。** 这点很重要，说清楚：

- dsh 的 `standard` preset 本来就挂了 `schedule_create/list/delete/update`（`@deepseek-ai/dsh-tool-schedule`）。
- 本插件的 `memory_remind` **调用同一个 `ctx.schedule` 服务**（故意复用，不重复造轮子）。
- 所以「到点唤醒会话、agent 主动说话」这套机制是 **dsh-schedule** 的；本插件提供的是 `memory_remind` **工具 + 主动打扰的语义包装**。

**怎么判断某次提醒是哪边触发的：**

| 看哪里 | 本插件 | dsh 自带 |
|---|---|---|
| 对话里的**工具名** | `memory_remind` | `schedule_create` |
| 工具**返回文案** | `已安排主动提醒「…」（sch_xxx）。到点我会主动找你。` | 另一种措辞 |
| 提醒**标题** | 带 `主动·` 前缀 | 原样 |

两者最终都落在 dsh 的同一个任务列表里，所以在 dsh 的日程/任务界面都能看到与取消。

---

## 数据

记忆存在 `$DSH_HOME/jt-da-pa-memory/memory.json`：

```json
{
  "version": 2,
  "memories": [
    { "id": "pm_1a2b3c4d", "text": "坐飞机喜欢靠窗", "category": "preference",
      "project": "", "importance": 3, "createdAt": 1760000000000,
      "updatedAt": 1760000000000, "accessCount": 2, "lastAccessedAt": 1760000000000 }
  ],
  "log": [],
  "lastWriteAt": 1760000000000,
  "lastDreamAt": 0,
  "dreams": 0
}
```

- `memories` —— 记忆本体（`archived: true` 表示已归档）
- `log` —— 最近 300 条改动（供 undo）
- `lastWriteAt` / `lastDreamAt` / `dreams` —— dream 调度用

---

## 开发与测试

```sh
node test.mjs        # 55 个断言，不需要 dsh
node --check index.js
```

---

## 设计说明（对齐 dsh 官方模式）

| 能力 | dsh 接缝 |
|---|---|
| 写入 / 检索 | `ctx.tools.register()` |
| 注入画像与记忆 | `ctx.systemPrompt.context()`（满足 Model-visible ⟺ logged） |
| 主动打扰 | `ctx.schedule.create/list/delete`（可选服务） |
| 人类命令 | `ctx.commands.register()`（可选服务） |
| 空闲 dream | `setInterval` 包在 `ctx.effect()` 里 |
| 存储 | 插件自有 JSON（不写进 session log） |

所有可选服务（`schedule` / `commands` / `systemPrompt`）用 `ctx.inject([...], cb)` 条件注册，缺席时优雅降级。

---

## 已知限制

- **关键词检索不跨语言**：中文 query 不命中英文记忆（反之亦然）。跨语言需 embedding。
- **dream 是确定性的**：只做合并 / 删空 / 归档，**不让模型重新蒸馏**（那需要给会话发消息）。想要模型参与的 dream 可参考 `dsh-meow-memory`。
- **主动打扰依赖 dsh-schedule**：需 web/desktop profile（含 Session controller 与持久化）；headless 下相关工具返回明确错误。
- **无跨设备同步**：记忆是本地文件。
- **注入是「画像 + 核心 + 最近」**，精确召回交给 `memory_recall` 工具。

## 许可证

MIT