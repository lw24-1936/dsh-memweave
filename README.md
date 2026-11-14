# 织忆 · dsh-memweave

> 把任务、判断、反模式与可衡量 Loop 织成可验证、可检索、可融合的组织记忆。

织忆是一个 DeepSeek Harness（DSH）插件：Host 半提供 10 个 `memweave_*` 工具，Client 半在 **设置 → 插件** 中贡献三个标签页——“存储与分类”“技能浏览”“融合”。

- 设计文档：[DESIGN.md](./DESIGN.md)
- License：MIT

---

## 为什么是“织忆”

三个组织进化原则直接落到工具契约上：

1. **以任务为中心**：`memweave_decompose` 生成任务网络，节点只标 `human/agent/hybrid`，不预设岗位。
2. **沉淀隐性知识**：`judgment` 必须说明“为什么有效”，`anti_pattern` 必须说明“什么情况下无效”。
3. **流程闭环**：Loop 必须有指标、目标、单位、节奏；三轮起给趋势。

两条贯穿约束：

- **反模式优先**：检索结果里没有反模式、但存在相关反模式时，强制召回最高分的一条。
- **记忆需验证**：新记忆是 `candidate`，不进入默认检索池；`memweave_memory_verify(valid)` 后才进入 `verified`。

---

## 安装

### 独立安装（默认）

在 DSH 的 `plugin_manager` 中：

- `action: install_bundle`
- `target: E:\projectWorkspace\ai-work\deepseek-harness\skill-work\dsh-memweave`（本目录绝对路径）

安装后：

1. 打开 **设置 → 插件**，应看到三个标签页：`存储与分类` / `技能浏览` / `融合`。
2. 模型侧应能调用 10 个 `memweave_*` 工具。
3. 默认存储位置：当前会话 workspace 下的 `.memweave/`。

> DSH 的普通 Config 字段变更会重启插件。保存存储路径后若页面短暂报“读取失败”，等一秒点“重试”即可。

### 可选聚合层

DSH 0.2.x 的 Loader patch **没有 `optional: true` 行语义**，所以本仓库不把兼容插件直接塞进默认 patch。聚合层是一个独立包：

```powershell
# 1) 先安装 dsh-memweave（上面的 install_bundle）
# 2) 生成只包含“本机已安装”的兼容行的 patch
node scripts/prepare-aggregate.mjs --profile C:\Users\24193\.dsh\profiles\desktop
# 3) 把 aggregate\ 目录作为第二个 bundle 安装
#    plugin_manager -> install_bundle -> target = ...\dsh-memweave\aggregate
```

`aggregate/cordis.patch.yml` 只声明“聚合标记 + 已安装的兼容插件”行；**不会重复插入 `dsh-memweave`**（那会造成 Loader 重复 id）。所以聚合是独立安装之上的加法层，不修改被聚合插件的配置、运行时或工具。`memweave_fusion_status` 会通过 `memweaveAggregate` 服务报告 `aggregateBundle: true`。

---

## 工具

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `memweave_decompose` | 把模糊目标拆成任务网络并注入反模式警告 | 确定性 6 节点骨架；节点带 `dependsOn` 与 `executor` |
| `memweave_precipitate` | 沉淀事实/程序/判断/反模式/关系 | `anti_pattern` 必须有 `antiPatterns`；`judgment` 必须有 `rationale` |
| `memweave_memory_find` | 检索相关记忆 | 默认只搜 `verified`；反模式强制召回 |
| `memweave_memory_verify` | 标记有效/无效/未定 | `valid` +0.15；`invalid` −0.25，低于 0.3 转 `disputed` |
| `memweave_loop_start` | 定义可衡量 Loop | 指标名/目标/单位/节奏必填 |
| `memweave_loop_record` | 记录一轮并给趋势 | 三轮起才有趋势；越小越好 |
| `memweave_memory_list` | 浏览/分类计数/分页 | `summaryByType` 始终五类 |
| `memweave_fusion_status` | 兼容插件与聚合状态 | 只读探测；缺失即降级 |
| `memweave_import` | 从兼容插件导入 | 仅在显式调用时；`dryRun` 不写盘 |
| `memweave_export` | 导出为兼容格式 | 只写 `.memweave-exports/`，不写对方目录 |

### 一次典型闭环

```text
memweave_decompose("把插件做到可安装")
  → memweave_loop_start("发布周期", metric=交付时长, target=3天, cadence=weekly)
  → 做完一轮：memweave_loop_record(loopId, 5)
  → 复盘后沉淀：memweave_precipitate(type=judgment, content=..., rationale=...)
  → 下一轮验证：memweave_memory_verify(memoryId, "valid", "在任务 42 复现")
  → 三轮后：memweave_loop_record 返回 improving / worsening / stable
```

---

## 设置页

### 存储与分类

- 显示当前存储根、来源（已配置 / 会话 workspace / 最近会话 / Host 启动目录）与目录状态。
- 输入绝对路径保存；清除回退到 `workspace/.memweave/`。相对路径会被 Host 拒绝。
- 五类计数卡：事实 / 程序 / 判断 / 反模式 / 关系。
- 点击分类：本页展开该分类明细，并为“技能浏览”预置筛选。
- 状态分布：已验证 / 候选 / 有争议 / 已取代。

### 技能浏览

- 状态、类型、关键词筛选；分页（每页 50）。
- 列表 + 详情：内容、理由、反模式、适用范围、来源、证据、验证日志。
- 验证按钮：有效 / 无效 / 未定，可填备注；与工具共用同一 Host core。

### 融合

- 列出 5 个已知兼容插件：`dsh-memory-xfy`、`dsh-memory-plus`、`dsh-cue-bank`、`dsh-task-memory`、`dsh-graphmemory`。
- 每项显示检测方式（文件 / 服务 / 工具）、是否可用、融合方向。
- 开关与方向写回插件 Config（`storageRoot` 与 `fusion` 两个字段）。
- 底部固定兼容性声明。

---

## 存储格式

```
<root>/
├── memories/<memoryId>.json
├── tasknets/<netId>.json
└── loops/<loopId>.json
```

原子写入：同目录 `wx` 独占临时文件 + `rename`；超过 1 小时的孤儿 `.tmp.*` 由列表操作顺带清理。单文件写入原子，跨文件不是事务。

记忆状态：

```
candidate ──verify(valid)──► verified
    │                           │
    └──verify(invalid)──► disputed（conf < 0.3）
                                │
superseded：被新版本取代，不参与检索，保留归档
```

---

## 融合边界

织忆**不会**：

- import 其他插件的运行时值；
- 修改其他插件的配置；
- 劫持其他插件的工具；
- 自动同步、自动导入或自动导出；
- 写入其他插件的私有目录。

它只做：`ctx.get(serviceName)` 可选探测、工具名探测、workspace 下公开记忆文件的只读扫描；导入/导出只在用户显式调用时发生。导出只写 `workspace/.memweave-exports/`。

---

## 开发

```powershell
cd E:\projectWorkspace\ai-work\deepseek-harness\skill-work\dsh-memweave
node --test test
node --check lib/index.js
node --check client/index.js
node scripts/prepare-aggregate.mjs --profile <profile-dir>
```

本地测试需要一个能解析 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/schemastery` 的 `node_modules`（本机由 DSH profile 的共享 SDK 目录提供；仓库不提交 `node_modules`）。

Host 半保持明文可读，不打包、不混淆；Client 半不引入外部 UI 库，只用宿主模块表里的 React 与主题 token。

---

## 已知限制

- v1 没有“更新任务网络”的工具；网络创建后在会话中细化。
- 检索用 TF-IDF + 中文二元组，不含向量检索。
- 设置保存会重启插件（DSH 普通 Config 字段的生命周期规则）。
- 聚合不是“单 patch 按参数切换”；受 Loader 能力限制，采用独立聚合包 + 生成器。
- `memweave_decompose` 是确定性骨架，不调用 LLM；它不是“自动完成任务分解”的替代品，而是任务网络的起点。
