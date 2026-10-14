我已经完整审阅了你的 [changguanguang/jt-da-pa-memory](https://github.com/changguanguang/jt-da-pa-memory) 仓库源码，排查并修复了 [index.js](https://github.com/changguanguang/jt-da-pa-memory/blob/main/index.js) 中的 **10 个隐藏 Bug**，同时在 [test.mjs](https://github.com/changguanguang/jt-da-pa-memory/blob/main/test.mjs) 中补充了对应的回归测试（全部 73 项断言均已通过），你可以直接下载替换使用：

### 一、 项目现有亮点评价

你的项目在 `dsh` ([package.json](https://github.com/changguanguang/jt-da-pa-memory/blob/main/package.json) / [cordis.patch.yml](https://github.com/changguanguang/jt-da-pa-memory/blob/main/cordis.patch.yml)) 生态下完成度很高，有三个非常讨巧的工程设计：

* **保持零外部依赖与极简部署**：仅用 Node.js 原生模块实现 IDF 加权、时间半衰期（45 天）、CJK Bigram 分词与原子写盘，无需配置向量数据库即可开箱即用。
* **打通“记忆 + 主动打扰 + 夜间整理”闭环**：相比绝大多数只做 CRUD 的记忆插件，你结合 `ctx.schedule` 实现了 `memory_remind` 主动唤醒，并用空闲定时器实现了 `dream` 整理与归档（见 [README.md](https://github.com/changguanguang/jt-da-pa-memory/blob/main/README.md)）。
* **兼顾模型可见性与人类可控性**：通过 `buildInjection` 将【关于你】（`identity` + `preference`）每轮注入系统提示词，并提供不经过大模型的 `/memory`、`/profile`、`/dream` 人类命令与 `undo` 撤销机制。

### 二、 排查出的 10 个隐藏 Bug 与已修复方案

通过对 [index.js](https://github.com/changguanguang/jt-da-pa-memory/blob/main/index.js) 进行逐行静态分析与沙箱实测，我定位并修复了以下 10 处隐蔽缺陷：

| 编号 | 所在位置 ([index.js](https://github.com/changguanguang/jt-da-pa-memory/blob/main/index.js)) | 隐藏 Bug 现象与触发原因 | 修复方案（已写入上方修复版文件） |
| --- | --- | --- | --- |
| **Bug 1** | `dream()` (第 326–332 行) | **返回的 `total` 统计失真**：`dream()` 直接返回了 `consolidate()` 计算的 `c.total`，未扣除紧接着 `archiveStale()` 新归档的条目数，导致提示“保留 X 条”包含了已归档条目。 | 在 `archiveStale()` 执行完毕后重新统计 `store.memories.filter(m => !m.archived).length`。 |
| **Bug 2** | `consolidate()` / `archiveStale()` / `undo()` (第 278–351 行) | **`dream` 无法被单次 `undo` 完整撤销**：每次合并与归档在循环内逐条调用 `pushLog`，一次 `dream` 会写入多条散碎日志，用户执行 `memory_undo` 只能撤销最后 1 条归档；且删空条目未记录日志。 | 为 `dream()` 引入事务级快照日志（`action: 'dream'`），单次 `undo()` 即可原子恢复整次整理与归档前的完整状态。 |
| **Bug 3** | `memory_update` & `memory_cancel_reminder` (第 489、585 行) | **JSON Schema 语法违规**：在属性内部写了 `id: { type: 'string', required: true }`。JSON Schema Draft-04+ 规范中 `required` 只能是外层数组，布尔值会在严格校验器（如 Ajv / LLM Strict Tool Use）下直接抛错。 | 移除属性内非法的 `required: true`，并为各工具的 `category` 补齐 `enum: CATEGORIES` 与数值范围约束。 |
| **Bug 4** | `memory_remind` (第 531–553 行) | **`every_seconds` 周期提醒被拦截**：第 550 行拷贝了 `args.every_seconds`，但 `parameters.properties`（开了 `additionalProperties: false`）和第 551 行的非空校验数组都漏掉了 `'every_seconds'`。 | 统一定义 `TIME_SELECTOR_KEYS`，在 Schema `properties` 与执行校验中同步补齐 `every_seconds`。 |
| **Bug 5** | `resolveConfig()` / `apply()` (第 43、57、789 行) | **`proactive.enabled` 配置形同虚设**：虽然解析并打印了 `主动打扰=开/关`，但工具注册与 `memory_remind` 执行时从未检查 `cfg.proactive.enabled`。 | 在 `memory_remind` 中增加 `if (!cfg.proactive.enabled)` 拦截并返回明确提示；同时兼容 `exec.session.id` 回退路径与防重复 `主动·` 前缀。 |
| **Bug 6** | `remember()` / `consolidate()` (第 179–211、284–301 行) | **已归档记忆（`archived: true`）幽灵拦截**：当用户再次告诉 AI 一条曾被归档的记忆时，`remember()` 在 `store.memories` 中命中已归档条目并直接返回 `deduped: true`，却未解除 `archived` 状态，导致该记忆永远无法被召回；`consolidate()` 也会把活跃记忆合并进归档记忆导致其消失。 | `remember()` 精确去重、`replaces` 或近重复合并命中已归档条目时自动执行 `delete target.archived` 唤醒；`consolidate()` 禁止跨归档状态吞并活跃记忆。 |
| **Bug 7** | `remember()` / `undo()` (第 213–221、334–351 行) | **新增记忆无法 `undo`，反而误撤历史操作**：`remember()` 新增条目时未调用 `pushLog`，若紧接着调用 `memory_undo`，会弹出几天前的旧日志并误改历史数据。 | 新增记忆时写入 `pushLog(store, 'remember', [], { ...item }, 'new')`，并在 `undo()` 中支持按 ID 撤回新增条目。 |
| **Bug 8** | `buildInjection()` (第 397–408 行) | **高优偏好被彻底挤出上下文**：`about = [...identity, ...preference]` 仅注入前 10 条，但 `seen` 却将全部 `about` 标记为已见。当 `identity` 超过 10 条时，即便 `importance: 5` 的核心 `preference` 既进不了【关于你】，也会在【其他记住的】中被 `seen` 过滤掉。 | 在【关于你】中按比例保障 `identity` 与 `preference` 席位，且 `seen` 仅记录实际输出的 `shownAbout`（最多 10 条），让溢出条目仍可由 `core`/`recent` 兜底。 |
| **Bug 9** | `tokenize()` (第 107–122 行) | **跨标点伪造中文 Bigram & 误删单数字/词尾 `s**`：`match(CJK_RE).join('')` 把整句中文跨标点拼在一起（如 `“我在北京，喜欢喝茶”` 会伪造出 `“京喜”`）；`w.length <= 1` 丢弃了 `“3 楼”`、`“5 岁”` 中的单数字；`nodejs`、`status`、`series` 被误切掉末尾 `s`。 | 改为按连续中文块 `/[\u3400-\u9fff]+/g` 内部切分 2-gram；保留单数字 token；增加 `NON_PLURAL_S` 白名单与 `-ies -> -y` 词干化。 |
| **Bug 10** | `loadStore()` / `saveStore()` / `apply()` (第 77–101、633 行) | **手动编辑或多会话并发被内存旧状态覆盖**：帮助信息提示用户可直接编辑 `memory.json`，但插件仅在启动时加载一次内存 `store`，后续哪怕触发一次 `memory_recall` 写回 `accessCount`，都会用旧内存覆盖外部修改；且并发临时文件仅用 `process.pid` 易冲突。 | 为 `store` 增加基于文件 `mtimeMs` 的 `syncStoreFromDisk` 热同步机制，并在临时文件名中加入随机后缀 `${process.pid}-${randomHex}`。 |

*注：顺带优化了 `MAX_MEMORIES` (800 条) 的淘汰策略——原代码 `splice(0, ...)` 会优先删掉用户最早录入的第 0 条记忆（往往是姓名、核心身份），修复版改为优先清理 `archived` 条目，其次按重要度、访问频次与时间综合淘汰非核心条目，并在 `scoreMem` 中引入了基于 `accessCount` 的轻量访问频次增益。*

### 三、 如何让插件更实用、更有差异化创新点（6 大演进方向）

目前主流的记忆插件（如 MCP 官方 `server-memory`、Mem0 或客户端内置 Memory）大多停留在“被动式 Fact 备忘录”。结合你已经具备的 `dsh-schedule` 调度能力与零依赖设计，可以从以下 6 个方向打出真正的差异化：

| 创新方向 | 解决的痛点 | 与其他插件的核心差异点 | 零依赖落地思路 |
| --- | --- | --- | --- |
| **1. 双时态事实演化图谱 (Bi-Temporal Evolution)** | 绝大多数插件遇到事实变更（如从上海搬到北京、换框架）要么直接覆盖丢掉历史，要么两条冲突事实并存误导模型。 | 不仅知道“现在是什么”，还能回答“半年来我的技术栈/目标是怎样演变的”。 | 当触发 `replaces` 或同类别冲突更新时，不直接抹除旧文本，而是在条目下追加 `history: [{ text, from, to }]` 演化链，注入时只展示当前值 + 最近一次变更提示（如 `在北京工作 (原: 在上海工作)`）。 |
| **2. 隐式偏好归纳引擎 (Dream 阶段从 Fact 提炼 Persona)** | 用户很少主动对 AI 说“记住我喜欢简短回答”，更多是在对话中不断纠正 AI（如“太长了”、“别用 emoji”、“用 TypeScript 重写”）。 | 从“用户显式口述才记”升级为“从交互摩擦与踩坑教训 (`lesson`) 中自动提炼行为准则”。 | 在 `dream()` 阶段扫描近期新增的 `lesson` / `project` 记忆，若高频出现同一 token 模式，或在系统提示词中引导模型在被用户纠正时自动记一条 `category: 'lesson'`，并在 `buildInjection` 中单独设立 `### 交互避坑准则 (Lessons)` 高优段落。 |
| **3. 带有 TTL 的情境工作记忆 (Episodic TTL Memory)** | 长期记忆和短期状态混在一起（例如“我这周在京都出差”、“今晚发版冻结”），过了这周还在每轮注入污染上下文。 | 区分“永久人格画像”与“阶段性情境 (Episodic Context)”，到点自动转化为历史归档。 | 在 `memory_remember` 中增加可选参数 `expires_in_days`（或 `valid_until`）。在有效期内作为高优 `### 当前近况` 强注入；过期后在 `buildInjection` 中自动静默归档，无需等 120 天衰减。 |
| **4. 记忆驱动的智能主动关怀 (Memory-Linked Follow-up)** | 现有 `memory_remind` 只是纯定时闹钟（和普通日历提醒无异），没有真正和“记忆状态”联动。 | 当记住一个 `goal` 或短期事件（如“下周三面试字节跳动”）时，**自动提议或挂钩一次事后追问**。 | 在 `memory_remember` 写入 `category: 'goal'` 且包含时间线索时，工具返回结构化提示建议模型联动调用 `memory_remind` 安排一次 `【主动回访】`（例如面试次日主动问“昨天面试感觉怎么样？要不要更新你的进展记忆？”）。 |
| **5. 语义冲突检测与主动求证 (Conflict Guard)** | 同一个 `category` 下先后记入矛盾事实（例如先记“对花生过敏”，后记“喜欢吃宫保鸡丁”或相反偏好），Jaccard 相似度低导致无法自动合并。 | 插件在写入时做“同槽位反义/冲突预警”，把 AI 从盲目记录变成会主动核实的助手。 | 为每条记忆提取轻量 `subject/topic` 标签（或复用高 IDF 核心词）。当同 `category` + 同 `topic` 命中旧记忆但 Jaccard 介于 `0.25 ~ 0.82` 之间时，`memory_remember` 在返回值中附带 `related_existing: [...]`，提示模型确认是否需要用 `replaces` 替换旧记忆。 |
| **6. 跨工区记忆透镜与 Markdown 双向同步 (`MEMORY.md`)** | 纯 JSON 文件虽然可读，但开发者在 IDE 里更习惯直接看 Markdown 或把项目经验同步到项目仓库。 | 兼顾全局个人画像与项目级知识沉淀，支持一键导出/同步人类友好的 Markdown 视图。 | 新增 `/memory export` 子命令（或在 `saveStore` 时可选生成同目录只读 ` PROFILE.md`），按【关于你】【项目经验】【近期目标】排版；同时支持检测当前工作目录 `process.cwd()` 名称自动匹配 `project` 作用域，无需模型每次手动传 `project` 参数。 |

如果你想把上面某几个创新特性（比如 **TTL 阶段性情境记忆**、**`replaces` 历史演化链** 或 **基于 `process.cwd()` 的自动项目作用域感知**）直接集成进代码中，告诉我你最中意的几个点，我可以立即帮你写进 `index.js` 并补齐单测！