# 织忆（dsh-memweave）设计文档

> 版本：v1.0.0  
> 目标运行时：DeepSeek Harness Desktop 0.2.1-rc.3（SDK 面 0.2.x）  
> 文档状态：实现基线（本文件与代码同步维护）

---

## 0. 结论摘要

织忆是一个 **Host 半 + Client 半** 的持久 Harness 插件（bundle 名为 `dsh-memweave`，显示名“织忆”），由三块能力组成：

1. **组织记忆**：`candidate → verified / disputed / superseded` 生命周期，默认检索池只含 `verified`，反模式强制召回。
2. **任务网络**：把模糊目标拆成带 `dependsOn` 与 `executor` 的任务节点，作为“以任务为中心”的基本单元。
3. **可衡量 Loop**：`metricName / metricTarget / metricUnit / cadence` 四要素强制，三轮以上给趋势。
4. **融合层**：固定五个内置记忆适配器；只在显式导入/导出时读取兼容文件，数据仍落在织忆自己的区域。

共 **10 个 Host 工具**：7 个原工具 + `memweave_fusion_status` / `memweave_import` / `memweave_export`。  
共 **3 个设置标签页**：`存储与分类` / `记忆浏览` / `融合`。

---

## 1. 设计优化：先修正原稿中的平台事实

原需求是一份高质量的产品契约，但其中若干 API 名称与机制不属于当前 DSH 0.2.x。直接照抄会得到“文档正确、运行失败”的插件。下面逐项给出平台事实与修订。

| # | 原稿写法 | 平台事实（0.2.x 实测/源码） | v1.0 修订 |
|---|---|---|---|
| 1 | `ctx.settings.register` 注册 `memweave` 命名空间 | `ctx.settings` 是 `SettingsForms`（配置表单投影），**没有 `register`**。插件配置由 Host 插件的 `export const Config`（schemastery）声明，Settings 自动生成表单；持久化用 `ctx.get('configEditor').edit(entry, change)` | 导出 `Config = z.object({ storageRoot, fusion })`；三个标签页通过 Host API 读写配置；`configEditor` 负责写回 profile patch |
| 2 | Client 标签页“调用 Host 半的 `memweave_memory_verify`” | Client 与 Host 之间没有“直接调用工具”的 RPC；工具只面向模型 | Host 暴露同源 `/memweave/api` 路由；路由与工具调用**同一个 core 函数**（`verifyMemory`），验证按钮确实走 Host 半逻辑 |
| 3 | `dsh.client` “指向 `./client`” | 实际解析规则：`package.json.exports["./client"]` 给出浏览器脚本路径；`dsh.client = { platform, inject, external, immediately }`。该脚本必须是 classic script，调用 `window.__ModuleLoader__.load({ id, factory })`，不能是裸 ESM | `exports["./client"] = "./client/index.js"`；`client/index.js` 自己注册 factory，内部 `require('react')` |
| 4 | `patches/aggregate.yaml` 的 `optional: true` 由安装器跳过缺失包 | Loader patch **没有 `optional` 行语义**；缺失包的行会变成 failed fiber（不阻断其它行，但留下失败记录） | 默认 patch 只插自身；`aggregate.yaml` 作为声明式单一事实来源；`scripts/prepare-aggregate.mjs` 检查本机已安装包，只把可用行写入可安装的 `aggregate/cordis.patch.yml`，实现“缺失即跳过”的等价效果 |
| 5 | 分类点击“跳转并预置筛选” | 设置标签页由 shell 内部状态控制，未向注册者暴露 `setActiveTab`；读取/操作宿主 DOM 被明令禁止 | 分类卡在本页内展开该分类的记忆明细（真正的跳转语义），同时把筛选写入共享 UI store；用户切到“记忆浏览”时自动消费该筛选 |
| 6 | `workspaceOf(exec)` | 工具调用可取 `exec.agent.session.header.cwd`；设置页请求没有 agent | 工具：session cwd → `.memweave/`；API：最近一次工具调用看到的 workspace → Host 启动目录，并在 UI 明示来源，避免假装知道 |
| 7 | `anti_pattern` 无 `antiPatterns` → `INVALID_ARGUMENT`；同时 `rationale required` | `rationale` 在 schema 层 required 时，空串仍能到达 `execute` | schema 保持 required；`execute` 额外做 trim 空校验，抛 `HarnessError('INVALID_ARGUMENT')` |
| 8 | `invalid` 后 `<0.3` 才 `disputed` | 置信度 ≥0.3 时状态如何未定义 | 明确：≥0.3 保持原状态（`candidate` 仍候选，`verified` 仍验证），只降置信度；`superseded` 拒绝验证 |
| 9 | 检索默认池只含 `verified`，但 `disputed` 要“降权并附警示” | 两个规则在检索入口冲突 | 检索池严格按 `verified`（+可选 `candidate`）；`disputed` 的低置信度、警示文案由列表页与详情页呈现。`disputed` 不会静默回到检索池 |
| 10 | `memweave_decompose` “生成任务网络” | 工具内部不能调用 LLM；调用 LLM 会让工具不确定、不可复现 | 确定性任务骨架生成器：按目标语义生成 6 节点流水线，标注 `human/agent/hybrid`，并注入匹配的反模式；它是“初始骨架”，后续由模型/用户在此基础上调整 |
| 11 | `summaryByType` 只出现五类 | 类型集合固定为 5 | 始终返回五个键（无条目补 0），Client 不需要猜缺失键 |
| 12 | 工具 `execute` 只返回 canonical JSON | `defineTool` 会用 `output.schema` 严格校验 | 所有返回对象字段与 schema 一一对应；不使用 `undefined`，可选值用 `null` |
| 13 | `memweave_memory_verify` 输出 `{memoryId, previousConfidence, newConfidence, newStatus}`，但 render 要求“旧状态 → 新状态” | 原 schema 没有旧状态，render 无法如实渲染 | schema 增加 `previousStatus`（六个字段）；这是对原契约的**必要补全**，不改状态机 |
| 14 | `memweave_loop_record` 输出不含 `metricTarget/metricUnit`，但 render 要求“距目标 … <unit>” | 原 schema 缺目标与单位，render 无法计算 gap | schema 增加 `metricTarget`/`metricUnit` 两个字段；数值来自 Loop 定义 |
| 15 | `pluginKey` “必须是 registry 中的 key” | 参数 enum 会让 DSH 在 execute 前抛 `INVALID_ARGS`，与“可预期失败用 INVALID_ARGUMENT”不完全一致 | 参数用 string + 描述列出允许 key；core 校验并抛 `HarnessError('INVALID_ARGUMENT')` |
| 16 | `loop_start` 的 render 不含 `loopId`，但下一步 `loop_record` 需要它 | 模型只看到 render，看不到 canonical value；不给 id 就切断了 Loop 闭环 | render 增加 `Loop ID：<id>`；`decompose` 增加 `网络 ID` |
| 17 | `find` / `list` 的 render 不含 `memoryId`，但 `verify` 需要它 | 同上：没有 id，模型无法对检索到的记忆调用 verify | 每行增加 `<memoryId>`；这是让生命周期真正可用的必要补全 |

---

## 2. 设计理念 → 工具契约

| 组织进化原则 | 插件里的硬约束 |
|---|---|
| 打破岗位边界，以任务为中心 | 任务网络是基本单元；`memweave_decompose` 生成 `nodes[].executor = human/agent/hybrid`，不出现岗位分类字段 |
| 沉淀隐性知识，构建组织智能 | `judgment` 必须有 `rationale`；`anti_pattern` 必须有 `antiPatterns`（“什么情况下无效”）；`content` 只写判断/反模式，不写操作手册 |
| 设计流程闭环，推动组织进化 | `memweave_loop_start` 强制 `metricName/metricTarget/metricUnit/cadence`；`memweave_loop_record` 三轮起给趋势；没有指标的循环不能创建 |

两条贯穿约束：

- **反模式优先**：`memweave_memory_find` 在 Top N 没有反模式但存在相关反模式时，强制召回得分最高的一条，`antiPatternForced=true`。
- **记忆需验证**：新记忆一律 `candidate`、`confidence=0.5`；只有 `memweave_memory_verify(valid)` 才进入默认检索池。

---

## 3. 总体架构

```
┌──────────────────────────── Browser (Client half) ────────────────────────────┐
│ settings.plugins.tab  ×3                                                     │
│  ├─ memweave-storage  存储与分类（概览、路径、分类下钻）                    │
│  ├─ memweave-memories 记忆浏览（筛选、列表、详情、验证）                    │
│  └─ memweave-fusion   融合（固定适配器、开关、方向、聚合状态）                    │
│            │ fetch /memweave/api/*（同源、loopback 信任围栏）                │
└────────────┼─────────────────────────────────────────────────────────────────┘
             │
┌────────────┴──────────────── Host half (lib/index.js) ───────────────────────┐
│ 10 tools: memweave_*  ──┐                                                   │
│                         ├── core: memory / network / loop / fusion          │
│ HTTP API: /memweave/api ┘                                                   │
│ paths.js: resolveStorageRoot / writeAtomic / cleanupOrphanTmp               │
│ Config: { storageRoot, fusion }  ── configEditor 写回 profile patch         │
│ 存储: <root>/memories/*.json, tasknets/*.json, loops/*.json                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

Host 必需依赖只有 `tools`；`webServer`、`configEditor` 是可选依赖。五个适配器固定内置，不依赖外部兼容插件；缺失 UI 能力时仍可使用工具。

---

## 4. 工程结构

```
dsh-memweave/
├── package.json
├── icon.svg
├── LICENSE
├── README.md
├── DESIGN.md
├── patches/
│   ├── bundle.yaml              # 默认只插自身
│   └── aggregate.yaml           # 声明式聚合清单（非默认 patch）
├── aggregate/
│   ├── package.json             # dsh-memweave-aggregate（独立可安装包）
│   ├── index.js                 # 只注册 memweaveAggregate 服务作为聚合标记
│   └── cordis.patch.yml        # 由 scripts/prepare-aggregate.mjs 生成
├── scripts/
│   └── prepare-aggregate.mjs
├── lib/
│   ├── index.js                 # Host 入口：Config / apply / 10 工具 / 渲染
│   ├── errors.js                # HarnessError 构造、abort 透传
│   ├── paths.js                 # 路径解析、原子写入、孤儿清理
│   ├── model.js                 # 数据模型、ID、格式化
│   ├── store.js                 # memories/tasknets/loops 读写
│   ├── search.js                # TF-IDF + trust + type boost + 强制召回
│   ├── memory.js                # precipitate/verify/find/list core
│   ├── network.js               # decompose core
│   ├── loop.js                  # start/record core
│   ├── fusion.js                # 固定适配器、文件桥接、导入、导出
│   └── api.js                   # /memweave/api 路由 + 信任围栏
├── client/
│   └── index.js                 # classic script：__ModuleLoader__.load(factory)
└── test/
    ├── helpers.mjs
    ├── host.test.mjs
    ├── api.test.mjs
    ├── paths.test.mjs
    ├── client.test.mjs
    └── aggregate.test.mjs
```

---

## 5. 数据模型

### 5.1 记忆条目 `memories/<memoryId>.json`

```json
{
  "id": "mem_m3k2x_9f2a1c",
  "type": "fact | procedure | judgment | anti_pattern | relation",
  "content": "判断或反模式本身",
  "rationale": "为什么有效",
  "antiPatterns": ["什么情况下无效"],
  "scope": { "taskTypes": ["需求澄清"], "conditions": ["多人协作"] },
  "source": { "taskRef": "task-42" },
  "evidence": { "loopRecords": [], "taskCompletions": [] },
  "confidence": 0.5,
  "status": "candidate | verified | disputed | superseded",
  "createdAt": "2026-11-15T00:00:00.000Z",
  "lastVerifiedAt": null,
  "supersededBy": null,
  "verificationLog": [
    { "at": "2026-11-15T01:00:00.000Z", "outcome": "valid", "note": "在任务 42 复现" }
  ]
}
```

> `verificationLog` 是 v1.0 的向后兼容扩展（原模型没有地方保存 `note`）；读取时缺失按 `[]` 处理。其余字段与需求一致。

### 5.2 任务网络 `tasknets/<netId>.json`

```json
{
  "id": "net_m3k2x_ab12cd",
  "goal": "把插件从 0 做到可安装",
  "nodes": [
    { "id": "n1", "task": "澄清目标与验收标准", "dependsOn": [], "executor": "hybrid" }
  ],
  "createdAt": "2026-11-15T00:00:00.000Z"
}
```

### 5.3 Loop `loops/<loopId>.json`

```json
{
  "id": "loop_m3k2x_77aa01",
  "loopName": "每周发布周期",
  "taskRef": "task-42",
  "metric": { "name": "平均交付时长", "target": 3, "unit": "天" },
  "cadence": "daily | weekly | on-demand",
  "records": [
    { "round": 1, "value": 5, "recordedAt": "2026-11-01T00:00:00.000Z", "notes": "首轮基线" }
  ],
  "basedOnMemoryId": null,
  "createdAt": "2026-11-01T00:00:00.000Z"
}
```

### 5.4 状态机

```
                 verify(valid) +0.15
   candidate ────────────────────────► verified
       │                                  │
       │ verify(invalid) -0.25            │ verify(invalid) -0.25
       ▼                                  ▼
   disputed (conf < 0.3)            confidence 降低，状态保持 verified
       │
       └─ verify(inconclusive)：置信度与状态都不变，只更新 lastVerifiedAt

   superseded：被新版本取代；不参与检索；拒绝 verify；保留归档
```

- `candidate` 不进入默认检索池。
- `verified` 进入默认池。
- `disputed` 不进入默认池；列表页可见，附“验证无效”警示。
- `superseded` 不进入检索；列表页可查；`supersededBy` 指向替代者。

---

## 6. 工具契约（10 个）

所有工具：

- `description` 以 `Use when …` 开头；
- `output.schema` 为 `ValueSchemaSpec`，显式对象节点全部 `additionalProperties: false`；
- `execute` 只返回 schema 声明的 canonical JSON；不抛裸字符串、不返回 `{ ok:false }`；
- `execute` 开头与每个关键 await 之后调用 `signal.throwIfAborted()`，取消透传 DSH 的 abort reason；
- `output.render` **恰好一个** `text` 块；
- 可预期失败抛 `HarnessError`：
  - `INVALID_ARGUMENT`：参数互斥/为空、`storageRoot` 相对路径、id 未找到、融合未启用、方向不允许；
  - `INTERNAL_ERROR`：目录不可创建、文件读写失败、配置不能持久化。

### 6.1 `memweave_decompose`

- 参数：`goal`（required）、`context`（optional）。
- 行为：
  - 校验 `goal.trim() !== ''`；
  - 读取 `verified` 反模式，按 goal+context 检索，取前 3 作为 warnings；
  - 生成 6 节点骨架（见 §7），写入 `tasknets/`；
  - 返回 `{ netId, nodes, warnings }`。
- 渲染：无依赖顶格；有依赖缩进并用 `↳`；末尾 `⚠ 避坑提醒：`。

### 6.2 `memweave_precipitate`

- 参数：`type` required；`content` required；`rationale` required；`antiPatterns`、`scopeTaskTypes`、`scopeConditions`、`sourceTaskRef` optional。
- 跨字段校验：
  - `type === 'anti_pattern'` 且 `antiPatterns` 为空 → `INVALID_ARGUMENT`；
  - `type === 'judgment'` 且 `rationale.trim() === ''` → `INVALID_ARGUMENT`。
- 写入：`confidence=0.5`、`status='candidate'`；重叠检测返回 `overlapHint`。
- 渲染：类型中文、内容截断 60、路径（默认根显示 `.memweave/memories/<id>.json`）、重叠提示。

### 6.3 `memweave_memory_find`

- 参数：`query` required；`types` optional；`limit` 默认 5（1–50）；`includeCandidates` 默认 false。
- 返回：`{ results, antiPatternForced }`。
- 渲染：顶部强制召回提示；每行 `[类型] <置信度符号> <memoryId> <content 50> — <rationale 40>`。

### 6.4 `memweave_memory_verify`

- 参数：`memoryId` required；`outcome` enum `valid|invalid|inconclusive`；`note` optional。
- 返回：`{ memoryId, previousConfidence, newConfidence, previousStatus, newStatus }`（`previousStatus` 是为如实渲染“旧 → 新”而补的字段）。
- 行为：
  - 找不到 → `INVALID_ARGUMENT`（message 含“未找到”）；
  - `superseded` → `INVALID_ARGUMENT`；
  - `valid`：`+0.15`，`status='verified'`；
  - `invalid`：`-0.25`，`<0.3` → `disputed`，否则保持原状态；
  - `inconclusive`：不变；
  - 所有 outcome 都刷新 `lastVerifiedAt` 并追加 `verificationLog`。
- 渲染：`<id> <outcome中文>。置信度：<旧> → <新>。状态：<旧> → <新>`（未变时“状态保持 …”）。

### 6.5 `memweave_loop_start`

- 参数：`loopName`、`metricName`、`metricTarget`（number）、`metricUnit`、`cadence` required；`taskRef`、`basedOnMemoryId` optional。
- `basedOnMemoryId` 不存在 → `INVALID_ARGUMENT`。
- 返回 `{ loopId, definition }`；`records=[]`。
- 渲染：`已定义 Loop …（每周）。Loop ID：…。指标：… 目标 … …` + 引用 + 下一步提示。

### 6.6 `memweave_loop_record`

- 参数：`loopId` required；`value` number required；`notes` optional。
- 追加 record；`rounds = records.length`；趋势算法见 §8。
- `basedOnMemoryId` 存在且 `worsening` → warning。
- 返回 `{ loopId, rounds, latestValue, trend, warning, metricTarget, metricUnit }`；后两个字段用于渲染“距目标 … <unit>”。

### 6.7 `memweave_memory_list`

- 参数：`types` optional；`status` 默认 `verified`；`sort` 默认 `last_verified`；`limit` 默认 20（1–100）；`offset` 默认 0；`summary` 默认 false。
- 行为：遍历 `memories/`；按类型/状态筛选；`summary` 时只返回计数；否则排序分页；顺带清理超过 1 小时的孤儿 `.tmp.*`。
- `summaryByType` 始终五个键。
- 渲染：概览或 `类型 | memoryId | content | 置信度符号 | status` 分页行 + `共 N 条，当前显示第 X-Y 条`。

### 6.8 `memweave_fusion_status`

- 参数：无。
- 返回 `{ plugins, aggregateBundle }`；每项 `{ key, label, type, detectedBy, available, enabled, direction, detail }`。
- 渲染：`检测到 N 个记忆适配器，A 个可用，M 个已启用` + 每行 + 聚合状态。

### 6.9 `memweave_import`

- 参数：`pluginKey` required（string；core 校验必须是 registry 中的 key，否则 `INVALID_ARGUMENT`）；`dryRun` 默认 false。
- 前置：fusion 配置中该 key `enabled && direction ∈ {read,both}`，否则 `INVALID_ARGUMENT`。
- 行为：在 workspace 下按 registry 的 marker/扩展名找文件；md 每条文件一条，json 提取记录；转成 `fact`、`confidence=0.4`、`status=candidate`；按内容去重；单次上限 500。
- `dryRun`：只返回 samples，不写入。
- 渲染：dryRun “将导入 N 条（跳过 M 条），示例：…”；否则“已导入 N 条，跳过 M 条”。

### 6.10 `memweave_export`

- 参数：`pluginKey` required；`statusFilter` 默认 `verified`；`limit` 默认 50（1–200）。
- 前置：fusion 配置中 `enabled && direction ∈ {write,both}`，否则 `INVALID_ARGUMENT`。
- 行为：按 registry 的 `exportFormat` 生成 markdown/json；只写 `workspace/.memweave-exports/<pluginKey>-<timestamp>.<ext>`。
- 渲染：`已导出 N 条为 <format>，路径：<path>`。

---

## 7. 任务网络生成算法（确定性）

输入：`goal`、`context`。输出 6 节点：

| id | task | executor | dependsOn |
|---|---|---|---|
| n1 | 澄清「goal 30」的目标、边界与验收标准（有 context 时附“已知上下文”） | hybrid | [] |
| n2 | 调研现状、依赖与约束（按目标关键词细化） | agent | [n1] |
| n3 | 设计可验证的方案与任务分解 | hybrid | [n1, n2] |
| n4 | 实施并产出可检查物（按关键词选“实现/撰写/修复”动词） | agent | [n3] |
| n5 | 验证结果、复盘偏差（含审批/决策关键词时改为 human 人工评审） | hybrid / human | [n4] |
| n6 | 沉淀记忆并关闭 Loop | agent | [n5] |

- “任务为中心”的体现：节点是带依赖的任务，不是岗位；`executor` 只回答“谁执行更合适”。
- 确定性生成保证同一 goal/context 得到同一骨架，便于测试与复现；模型可在会话中基于骨架继续细化（v1 没有更新网络的工具，避免未定义写入路径）。

---

## 8. 检索与趋势算法

### 8.1 检索打分

```
score = tfidf_cosine(query, doc) × trust_factor × type_boost
trust_factor = confidence × (1 + 0.6 × (freshness − 0.5))
freshness = clamp(1 − ageDays(lastVerifiedAt ?? createdAt) / 90, 0, 1)
type_boost = anti_pattern 1.3 / judgment 1.1 / procedure 1.0 / fact 0.9 / relation 0.8
```

- 分词：拉丁/数字按词；CJK 连续串取二元组（单字串取单字）。
- `doc = content + rationale + antiPatterns + scope.taskTypes`。
- IDF 在本次检索语料上计算；查询无有效 token 或全为 0 分 → 空结果。
- 过滤：默认 `verified`；`includeCandidates` 追加 `candidate`；`disputed/superseded` 永不进入。
- `types` 在打分前过滤。
- 强制召回：若 Top N 无 `anti_pattern`，且存在 `score>0` 的 `anti_pattern`，用最高分反模式替换最低分结果（保持 N），`antiPatternForced=true`。

### 8.2 Loop 趋势（越小越好）

取最近三轮 `v1,v2,v3`：

```
mean = (v1+v2+v3)/3
spread = max−min
if mean > 0 && spread/mean < 0.05        → stable
else if v3 < v1                          → improving
else if v3 > v1                          → worsening
else                                      → stable
```

- `<3` 轮 → `insufficient_data`。
- `gap = metricTarget − latestValue`；渲染允许负值（表示已超出目标）。
- `basedOnMemoryId` 存在且 `worsening` → warning 提示复核该记忆；记忆不存在时创建阶段即拒绝，不会留下悬空引用。

---

## 9. 融合层

### 9.1 原则

1. 不 import 其他插件运行时值；
2. 不修改其他插件配置；
3. 不劫持其他插件工具；
4. 不自动探测服务、工具、安装态或市场；只在显式导入/导出时读取 workspace 文件；
5. 缺失文件即返回空结果，`dispose` 只影响自己；
6. 五个记忆适配器固定内置，不随任何巡检或市场任务增删。

### 9.1.1 为什么不做自动检测

自动检测没有改变记忆核心能力，却引入了不必要的状态来源：已安装但无数据、工具名相同、profile 路径差异都会让“可用”变得不可预期。现在融合页只表达五个固定适配器的开关和方向；插件发现与安装交给 DSH 的插件市场/插件管理器。

### 9.2 固定适配器注册表（fusion.js 硬编码）

| key | label | type | marker | 扩展名 | 默认方向 | 导出格式 |
|---|---|---|---|---|---|---|
| dsh-memory-xfy | 内置适配器 · xfy | memory | `.dsh-memory` | `.md` | read | markdown |
| dsh-memory-plus | 内置适配器 · memory-plus | memory | `.dsh-memory` | `.json` | read | json |
| dsh-cue-bank | 内置适配器 · cue-bank | memory | `.dsh-cue-bank` | `.json` | read | json |
| dsh-task-memory | 内置适配器 · task-memory | memory | `.dsh-task-memory` | `.md` | read | markdown |
| dsh-graphmemory | 内置适配器 · graphmemory | memory | `.dsh-graphmemory` | `.json` | read | json |

- `detectFusion()` 只读取配置开关，返回 `detectedBy='builtin'`、`available=true`；不做任何外部探测。
- 详情固定为 `内置适配器就绪；启用后可导入或导出`，不输出缺失路径。
- 可用不代表存在可导入数据；导入仍需要匹配文件。

### 9.3 导入

- 仅当配置 `enabled` 且方向含 `read`。
- 文件查找：在 workspace 下按 marker 目录搜索（深度 5，跳过 `node_modules/.git/dist/build/.memweave/.memweave-exports`），每个 marker 目录再递归收集扩展名匹配文件（最多 500）。
- 解析：
  - `.md`：去 YAML frontmatter，正文前 200 字；
  - `.json`：数组 / `memories|entries|items|records` 数组 / 单对象；字段 `content|text|memory|body|value|title`；
  - 有效类型透传，否则 `fact`；导入的 `anti_pattern` 若没有反模式说明，降级为 `fact`，避免把违反契约的数据写进库；
  - 去重：内容规范化后与已有记忆及本次批次比较。
- 写入 `confidence=0.4`、`status='candidate'`、`rationale='从 <key> 导入'`。
- `dryRun` 绝不写盘。

### 9.4 导出

- 仅当 `enabled` 且方向含 `write`。
- 只写 `workspace/.memweave-exports/`；不写其他插件目录。
- 文件名 `<pluginKey>-<YYYYMMDD-HHmmss>.<md|json>`。
- 导出内容保留 `content/rationale/antiPatterns/scope/confidence/status/lastVerifiedAt`。

### 9.5 聚合包

- `patches/aggregate.yaml` 是声明式清单；不是默认 patch。
- `scripts/prepare-aggregate.mjs`：
  - 读取清单；
  - 通过 `createRequire` 检查每个包是否安装；
  - 已安装 → 写入 `aggregate/cordis.patch.yml`；未安装 → 跳过并打印；
  - **不重复插入 `dsh-memweave` 行**（独立 bundle 已提供，重复会触发 Loader duplicate entry id），始终保留 `memweave-aggregate` 标记行。
- `aggregate/` 是独立包 `dsh-memweave-aggregate`，默认导出 `MemweaveAggregate` 服务（`memweaveAggregate`），供 `memweave_fusion_status` 判定 `aggregateBundle=true`。
- 安装聚合包 = 安装一个只做“组合声明 + 标记”的 bundle；被聚合插件的配置、运行时、工具都不被改写。
- 明确限制：当前 DSH 不支持“同一 bundle 多 patch 按参数选择”，因此聚合不是 `dsh plugin add --patch aggregate`；而是安装独立的 `aggregate/` 包。这个等价方案保留了“缺失即跳过、独立安装不受影响”的验收语义。

### 9.6 自动学习

- 默认关闭，显式开启；监听 `session/event` 的所有非流式事件，写入脱敏后的 `sessions/<id>.jsonl` 归档。
- 历史回填通过 `sessionQuery.listSessions()` / `readSession()`，归档事件并为每个会话生成一条摘要；单次有界（默认 50，最多 500）。
- 用户消息提取器只保留含长期决定/纠正信号的句子；写入 `judgment`/`procedure`，带 `session:<id>` 来源。
- 脱敏规则覆盖私钥、常见 API key、Bearer token、password/token/secret 键值；归档单事件上限 30,000 字符。
- 明确强语气决定在实时会话可自动 `verified`；历史回填和会话摘要统一写 `candidate`。
- `scope` 可按 cwd/消息文本限定项目或技能；不自动注入每轮对话。

---

## 10. 配置与持久化

### 10.1 Config

```js
export const Config = z.object({
  storageRoot: z.string().default('').description('组织记忆存储根目录的绝对路径。留空则使用当前 workspace 的 .memweave/ 目录。'),
  autoLearn: z.object({
    enabled: z.boolean().default(false),
    scope: z.string().default(''),
    autoVerify: z.boolean().default(true),
    historyLimit: z.number().default(50),
  }).default({ enabled: false, scope: '', autoVerify: true, historyLimit: 50 }),
  fusion: z.dict(z.object({
    enabled: z.boolean().default(false),
    direction: z.union(['read', 'write', 'both']).default('read'),
  })).default({}).description('融合开关：{ "<pluginKey>": { enabled, direction } }'),
})
```

- Settings 会为插件行自动生成配置表单（原生能力）。
- 三个自定义标签页通过 `/memweave/api/settings` 与 `/memweave/api/fusion` 写配置。
- 写回使用 `ctx.get('configEditor').edit(ctx.fiber.entry, current => next)`；普通字段变更会重启插件（DSH 生命周期规则），因此写完后的客户端刷新需要容忍一次短暂的接口不可用。

### 10.2 `storageRoot` 解析优先级

1. 非空且绝对 → 使用；不是绝对 → `HarnessError('INVALID_ARGUMENT')`；
2. 空 + 工具调用有 `exec.agent.session.header.cwd` → `<cwd>/.memweave`；
3. 空 + 设置页/API 调用 → 最近一次 `session/event` 观察到的 workspace；重启后还可从可选的 `workspaceRegistry` 最近更新记录恢复；
4. 仍未知 → `process.cwd()`（Host 启动目录）；
5. 返回 `{ root, source }`，UI 显示来源，绝不把 fallback 伪装成用户配置。

绝对路径判定同时接受 POSIX `/…`、Windows 盘符 `C:\…`/`C:/…`、UNC `\\…`，避免跨平台误判。

### 10.3 原子写入

```
tmp = <targetDir>/<targetName>.tmp.<12 hex>
fd = open(tmp, 'wx', 0o600)
write → close → rename(tmp, target)
失败：best-effort unlink(tmp)
```

- 不 fsync（v1 明确不做）。
- `.tmp.*` 超过 1 小时由 `memweave_memory_list` 顺带清理。
- 单文件写入是原子的；跨文件操作不是事务，后写覆盖先写（每个 memory/loop/net 文件由一个写入者拥有）。

---

## 11. Host API（设置页数据通道）

前缀：`/memweave/api`。仅接受 loopback / trusted host；拒绝跨站 `sec-fetch-site: cross-site` 与异源 `Origin`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/snapshot` | 存储概览：配置根、有效根、来源、五类计数、状态计数、融合状态 |
| GET | `/memories?status=&types=&query=&offset=&limit=` | 分页列表（含筛选后的 total） |
| GET | `/memory?id=` | 单条详情 |
| POST | `/verify` | `{ memoryId, outcome, note }` → 与工具同一 core |
| POST | `/settings` | `{ storageRoot }` → configEditor |
| POST | `/fusion` | `{ key, enabled, direction }` → configEditor |

响应统一 `{ ok: true, ... }` 或 `{ ok: false, error: { code, message } }`。  
`INVALID_ARGUMENT` → 400，其余 → 500。请求体上限 64 KiB。

---

## 12. Client 半设计

### 12.1 注册

`client/index.js` 是 classic script：

```js
window.__ModuleLoader__.load({
  id: 'dsh-memweave',
  factory(require) {
    const React = require('react')   // 模块作用域解析一次
    ...
    return { inject: ['slots', 'locale'], apply(ctx) { ... } }
  }
})
```

`apply` 内：

- `ctx.locale.register('memweave', { zh, en })`；
- 三次 `ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ id, order, label, locale:'memweave' }, Component))`：
  - `memweave-storage` / order 10 / `存储与分类`
  - `memweave-memories` / order 20 / `记忆浏览`
  - `memweave-fusion` / order 30 / `融合`

### 12.2 纪律

- 注册值是函数组件，返回 `ReactNode`；`require('react')` 只在 factory 模块作用域执行一次。
- 根节点不写 `height:100%` / `overflow-y:auto`；滚动交给设置外壳。
- 不用视口媒体查询；窄屏用 `container-type: inline-size` + `@container`。
- 标签页首次选中时由 shell 挂载，切换保持挂载（shell 行为）；组件在 `useEffect` 挂载时拉数据。
- 验证按钮只调 `/memweave/api/verify`，不读写文件。
- 融合开关/方向只调 `/memweave/api/fusion`，不直接改其他插件配置。
- 不读取/操作宿主 DOM，不替换应用根节点。
- 文案走 locale 字典；颜色用宿主 token（`--dsw-alias-*`）并提供 fallback。

### 12.3 三个页面

**存储与分类**

- 顶部：有效存储根、来源标签（已配置 / 会话 workspace / 最近会话 / Host 启动目录）、目录存在状态。
- 路径输入 + 保存/清除；相对路径在前端先做提示，Host 仍会二次拒绝。
- 五张分类卡：事实/程序/判断/反模式/关系；点击后在本页展开该分类明细（预置筛选），并把筛选写入共享 UI store，供“记忆浏览”首次挂载时消费。
- 状态概览：verified/candidate/disputed/superseded 计数。
- 刷新按钮；错误横幅。

**记忆浏览**

- 筛选：状态（默认 verified）、类型多选、关键词、每页 50。
- 列表：类型、内容摘要、置信度符号、状态、最近验证时间。
- 详情：完整 content、rationale、antiPatterns、scope、source、evidence summary、verificationLog。
- 验证：valid / invalid / inconclusive + note，提交后刷新列表与详情。
- 空态/加载态/错误态。

**融合**

- `GET /snapshot` 的 `fusion` 段；每项一行：label、方向、状态、开关、方向选择器。
- 聚合包状态：`聚合包已启用` / `独立安装`。
- 兼容性声明固定一行；开关/方向变更调用 `/fusion`，成功后刷新。

---

## 13. 错误、取消与并发

| 场景 | 行为 |
|---|---|
| `exec.signal` 已 abort | `signal.throwIfAborted()`，透传 DSH abort reason |
| `storageRoot` 相对路径 | `HarnessError('INVALID_ARGUMENT')` |
| memoryId/loopId/netId 不存在 | `HarnessError('INVALID_ARGUMENT')`，message 含“未找到” |
| 融合未启用/方向不允许 | `HarnessError('INVALID_ARGUMENT')`，说明需要开启哪个方向 |
| 目录/文件读写失败 | `HarnessError('INTERNAL_ERROR', { cause })` |
| 单条记忆 JSON 损坏 | 跳过并计数；不因一条坏数据让整次 list 失败 |
| 并发写同一 memory | 原子 rename，后写覆盖；`verify` 以读取时版本为准（v1 不做乐观锁） |
| 配置写入冲突 | `configEditor` 抛错 → 原样返回错误给 UI |

---

## 14. 测试计划

- `paths.test.mjs`：原子写入、相对路径拒绝、孤儿清理、绝对路径判定。
- `host.test.mjs`：
  - 注册 10 个工具；所有 description 以 `Use when` 开头；
  - 每个 output.schema 用 `validateJsonSchemaValue` 校验实际返回值；
  - 每个 render 恰好 1 个 text 块；
  - 记忆生命周期：precipitate → find（默认无）→ verify(valid) → find（有）→ verify(invalid) → disputed；
  - 反模式强制召回；
  - Loop 三轮趋势（improving/worsening/stable）；
  - list 的 summaryByType 五键与分页；
  - 未知 id / 相对 storageRoot 的 HarnessError code。
- `client.test.mjs`：VM 中执行 client bundle，捕获 `__ModuleLoader__.load`，断言 factory、inject、三个 tab 的 id/order/label。
- `aggregate.test.mjs`：`prepare-aggregate` 在缺包时跳过、在模拟已安装时纳入；生成 patch 是合法 YAML 结构。

---

## 15. 验收标准映射

| 验收 | 实现 |
|---|---|
| 1 三个标签页可见 | client 注册 `memweave-storage/memories/fusion`，order 10/20/30 |
| 2 绝对路径生效、清除回退 | Config `storageRoot` + resolve 优先级；工具与 API 共用 |
| 3 分类概览五类、点击跳转预置筛选 | 存储页五卡 + 本页下钻 + 共享筛选 |
| 4 列表+详情+验证按钮 | 记忆浏览页 + `/api/verify` → `verifyMemory` |
| 5 融合页覆盖五个内置适配器、开关写 settings | fusion registry + `/api/fusion` → configEditor |
| 6 fusion_status 返回 plugins/aggregateBundle | `detectFusion` + `ctx.get('memweaveAggregate')` |
| 7 import dryRun 不写、正式写 candidate/0.4 | `importFromPlugin` |
| 8 export 只写 `.memweave-exports/` | `exportToPlugin` |
| 9 七个工具 render 单文本块 | 每个 render 返回 `[{type:'text'}]`；测试断言 |
| 10 相对 storageRoot 抛 INVALID_ARGUMENT | `resolveStorageRoot` |
| 11 聚合 optional 行缺失时跳过 | `prepare-aggregate.mjs` 的等价实现；文档说明平台限制 |

---

## 16. 已知限制与 v1.1 预留

- **无更新任务网络的工具**：v1 只创建网络；v1.1 可加 `memweave_network_update`（append/rewire）。
- **`superseded` 无自动入口**：v1 的 `precipitate` 只返回重叠提示，不自动取代旧记忆；该状态留给未来版本或手工维护，检索永远排除它。
- **无自动同步**：导入导出只在显式调用时发生。
- **无跨文件事务**：单文件原子，批量导入中途失败会留下已写入的部分（返回 imported/skipped 让用户知情）。
- **无向量检索**：v1 用 TF-IDF；中文以二元组缓解分词问题。v1.1 可接 embedding，但必须保留可解释的 sort 依据。
- **无 agent/turn-stopping 钩子**：`apply` 末尾只留注释块，不注册 `ctx.on('agent/...')`。
- **设置写入会重启插件**：DSH 对普通 Config 字段的生命周期规则；UI 已做一次重试。
- **聚合不是单 patch 切换**：受 Loader 能力限制，改用独立聚合包 + 生成器。

---

## 17. 安装与验证

```powershell
# 1) 本地安装到 desktop profile
#    plugin_manager -> install_bundle -> target = E:\...\skill-work\dsh-memweave
# 2) 重启或等待 HMR，打开 设置 → 插件
# 3) 三个标签页出现：存储与分类 / 记忆浏览 / 融合
# 4) 用模型调用 memweave_decompose 等工具，或直接打开页面
```

Host 半明文可读，不打包、不混淆；Client 半不引入外部 UI 库，仅 `require('react')` 与宿主 token。

---

## 18. 设计取舍记录（ADR 摘要）

1. **为什么不用 `ctx.settings.register`**：不存在该 API；Config 是 DSH 官方插件配置面，且自动进入 Settings。自定义页仍能通过 configEditor 写同一份配置。
2. **为什么 Client 不直接读文件**：浏览器没有文件系统权限；同源 API 是 token-lens 等已安装插件验证过的模式，且能复用 Host core。
3. **为什么不用 `ctx.remote`**：需要生成式 Remote 面与构建链；本插件以 Host 函数 + 前缀路由即可满足，减少构建复杂度。
4. **为什么反模式强制召回替换最低分而不是追加**：返回条数上限是契约（limit），追加会破坏 limit；替换保证“反模式一定被看到”且条数不变。
5. **为什么 verify 的 note 存 `verificationLog`**：原模型无 note 字段；日志数组向后兼容，且保留了“为什么这样验证”的审计线索。
6. **为什么融合导出不写对方目录**：写对方私有目录等于隐式修改其他插件状态；只写自己的导出区，由用户搬运。
