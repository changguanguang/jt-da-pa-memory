# jt-da-pa-memory 🧠

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的一个**个人 AI 风格跨会话记忆插件**。

它记住的是「你这个人」——身份、偏好、长期事实、教训——而不是聊天记录。每条记忆带出处，可读可改，遗忘可撤销，并带有相关性 + 重要性 + 时间衰减三层打分。

**零运行时依赖**：纯 ESM JavaScript，只用 Node 内置模块，不 import 任何 dsh 包，因此不受 dsh 版本 API 漂移影响，也不需要编译。

---

## 它做了什么

**写入** —— 模型通过工具把关于你的事实记下来。同一事实换种说法会自动合并，事实变了用 `replaces` 更新而非新增。

**注入** —— 每轮把「核心记忆（importance ≥ 3）+ 最近记忆」作为动态上下文注入系统提示词（走 dsh 官方的 `ctx.systemPrompt.context()`，满足「Model-visible ⟺ logged」）。模型还能随时用 `memory_recall` 深挖。

**打分** —— 召回按 `IDF（稀有词权重高）× importance × 时间衰减（45 天半衰期）` 排序，只把够格的喂给模型。

**整理** —— `memory_consolidate` 合并近重复、删除空条目。它**从不发明事实、从不删你自己写的行**，且每次改动可 `memory_undo` 撤销。

### Personal AI 的六个特征

| 特征 | 实现 |
|---|---|
| 1. 记住「你这个人」 | 7 类记忆：identity / preference / fact / project / lesson / goal / other |
| 2. 可读可改 | 记忆是普通 JSON：`$DSH_HOME/jt-da-pa-memory/memory.json` |
| 3. 出处 | 每条记录 source（谁写的、何时）、project 归属 |
| 4. 相关性排序 | IDF + importance + 时间衰减 |
| 5. 遗忘可见可撤销 | 每次删除/合并进 `log`，`memory_undo` 可撤销 |
| 6. 整理不发明事实 | 合并只在原文词集合内，不删用户内容 |

### 工具

| 工具 | 作用 |
|---|---|
| `memory_remember` | 记住一条关于你的事实（去重 / 合并 / 更新） |
| `memory_recall` | 按 query 检索相关记忆 |
| `memory_forget` | 删除（按 id 或 query），可撤销 |
| `memory_update` | 修改一条记忆的 text / category / importance / project |
| `memory_list` | 列出全部记忆（透明） |
| `memory_consolidate` | 整理：合并近重复、删空 |
| `memory_undo` | 撤销最近一次改动 |

---

## 查看与删除记忆（三种方式）

### 方式 1：`/memory` 命令（最方便，推荐）

在 dsh 的输入框里直接输入，**不经过模型**、即时返回：

| 输入 | 效果 |
|---|---|
| `/memory` | 列出全部记忆（含 id、类别、时间） |
| `/memory forget 靠窗` | 删除所有包含「靠窗」的记忆 |
| `/memory forget id:pm_1a2b3c4d` | 按 id 删除一条 |
| `/memory undo` | 撤销最近一次删除 / 合并 |
| `/memory tidy` | 整理：合并近重复、删空 |
| `/memory help` | 显示帮助 |

例：

```
> /memory
你的个人记忆（共 3 条）：
  - (identity) 在北京工作 · 今天  [pm_69b532ea]
  - 房东是 Bob Li · 今天  [pm_a2233f4c]
  - (preference) 坐飞机喜欢靠窗 · 今天  [pm_e481c2cf]

删除：/memory forget <文字>   或   /memory forget id:<id>
```

> 需要 profile 里挂了 `dsh-commands`（web / desktop profile 默认有）。没有命令平面时，`/memory` 不会出现，但工具与注入照常工作。

### 方式 2：直接编辑记忆文件

记忆就是普通 JSON，位置：

| 系统 | 路径 |
|---|---|
| Windows | `C:\Users\<你>\.dsh\jt-da-pa-memory\memory.json` |
| macOS / Linux | `~/.dsh/jt-da-pa-memory/memory.json` |
| 设了 `DSH_HOME` | `$DSH_HOME/jt-da-pa-memory/memory.json` |

用编辑器打开，**删掉 `memories` 数组里的一整个 `{...}` 条目就删掉一条记忆**；加一条就记住一条。改完保存，重启 dsh（或等下一轮）生效。

### 方式 3：让 agent 操作

| 你对 agent 说 | 触发的工具 |
|---|---|
| 「你知道我什么」 | `memory_list` |
| 「忘掉靠窗那件事」 | `memory_forget` |
| 「撤销刚才的删除」 | `memory_undo` |

### 在哪里「看到」记忆生效

记忆不是显示在某个面板里，而是**每轮对话自动注入**给模型。验证方法：记一条 → 新开一个会话 → 问相关的问题，它能答上来就说明注入生效了。/memory 列出的和注入的是同一批数据。（本插件暂无图形面板；想看图界面可加 Client 半，参考 dsh-mnemon 的 Memory System。）

---

## 安装

先决条件：已装 dsh（`npx @deepseek-ai/dsh web` 至少能跑起来）。Node 20+。

### 方式 A：直接装本地目录（开发 / 试用，推荐）

```sh
# 1. 把整个 jt-da-pa-memory 目录放到任意位置，例如
#    D:/plugins/jt-da-pa-memory

# 2. 装进 dsh 的 web profile（把路径换成你的实际路径）
dsh plugin --profile web add /path/to/jt-da-pa-memory

# 3. 重启 dsh web
npx @deepseek-ai/dsh web
```

### 方式 B：手动写入用户 patch 层（最可控）

不经过 `dsh plugin`，直接改 profile 的用户 patch：

```sh
# 打开 $DSH_HOME/profiles/web/cordis.patch.yml（默认为 ~/.dsh/...）
```

加一行（`name` 指向你的 `index.js` 绝对路径）：

```yaml
- insert:
    - id: jt-da-pa-memory
      name: '/absolute/path/to/jt-da-pa-memory/index.js'
```

重启 `dsh web` 生效。

### 方式 C：如果它在你本地是一个 git 仓库

```sh
dsh plugin --profile web add /path/to/jt-da-pa-memory
# 或（如果你推到了 GitHub）
dsh plugin --profile web add github:you/jt-da-pa-memory
```

### 验证

```sh
# 看它是否被装配进 profile
dsh --profile web --dump-config | grep jt-da-pa-memory
```

启动后，在新会话里说一句：**「记住我坐飞机喜欢靠窗」**。模型应调用 `memory_remember`。
再开一个新会话问：**「我订机票有什么偏好吗」**——它应能答上来（核心记忆每轮都在上下文里）。

---

## 配置（可选）

在 patch 的插件行里加 `config`：

```yaml
- insert:
    - id: jt-da-pa-memory
      name: 'jt-da-pa-memory'
      config:
        dir: '/absolute/path/to/store'   # 默认 $DSH_HOME/jt-da-pa-memory
```

---

## 数据

记忆存在 `$DSH_HOME/jt-da-pa-memory/memory.json`（默认 `~/.dsh/jt-da-pa-memory/memory.json`）：

```json
{
  "version": 1,
  "memories": [
    {
      "id": "pm_1a2b3c4d",
      "text": "Prefers window seats on flights",
      "category": "preference",
      "project": "",
      "importance": 3,
      "source": { "kind": "agent" },
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000,
      "accessCount": 2,
      "lastAccessedAt": 1760000000000
    }
  ],
  "log": []
}
```

你可以直接编辑这个文件（删一行就忘掉一条）。`log` 是最近 200 条改动记录，供 undo。

---

## 开发与测试

```sh
# 只跑核心逻辑（不需要 dsh）
node test.mjs        # 23 个断言

# 语法检查
node --check index.js
```

插件完全对齐 dsh 官方模式「section provider + tool」：

- 写入/检索：`ctx.tools.register()`
- 注入：`ctx.systemPrompt.context()`
- 存储：插件自有 JSON（不写进 session log）

想扩展：`index.js` 里的 `remember / recall / consolidate / buildInjection` 都是导出的纯函数，可以单独测试和替换。

---

## 已知限制

- **关键词检索不跨语言**：中文 query 不会命中英文记忆（反之亦然）。要跨语言需接 embedding 端点。这是关键词检索的固有限制，不是 bug。
- **无自动整理**：`memory_consolidate` 需要模型或你手动触发（可后续加空闲定时器，参考 `dsh-meow-memory` 的 dream）。
- **无跨设备同步**：记忆是本地文件。跨端要额外写同步层。
- **注入是「核心 + 最近」**，不是「按当前消息精确召回」——精确召回交给 `memory_recall` 工具，这样实现更稳、不依赖 dsh 内部消息结构。

## 许可证

MIT