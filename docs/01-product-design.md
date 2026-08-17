# Orbit 产品设计

> 状态: 1.0 | 日期: 2026-08-14
> Orbit 是 DeepSeek Harness（DSH）上的一个「反思层」插件。

---

## 0. 一句话定位

**Orbit 是一个让 Agent「越做越会做」的反思层——它不管理任务，而是在每次任务内滚动纠偏、封存时复盘、并把教训沉淀成「任务类型 playbook」改进未来的规划。全程以客观的 `done_when` 判据为支点。**

---

## 1. 定位：不是「任务管理」，而是「任务管理之上的反思层」

「任务管理」（看板、工作流、认领、状态流转）在 DSH 生态里已经有很多成熟方案。Orbit 不做这些，它补的是普遍被忽略的一层：

1. **`done_when` 客观完成判据** —— 「算不算完」由一个可观测事实判定，而非主观勾 `done`；
2. **滚动式建设性评估** —— 每个节点完成后问「对齐了吗 / 假设破没 / 后续改吗」；
3. **假设追踪** —— 记录规划时依赖的假设，执行中发现假设破裂就报警。

**结论：Orbit 的生存空间不是「任务管理」，而是「任务管理之上的反思层」。**

### 1.1 边界：简单任务不进 orbit

- 一句话查询、单步操作等无「决策/假设」可反思的任务，agent 直接执行，不建 goal、不建环、不复盘。
- orbit 的价值（纠偏/复盘/沉淀）只存在于有决策密度的多步任务里。

### 1.2 核心叙事：三层学习环

| 环 | 名称 | 问的问题 | 改的是 | 时点 |
|---|---|---|---|---|
| 内环 | **纠偏** | 这一步对齐吗？假设破没？路线改吗？ | 当前任务的 roadmap | 每个节点后 |
| 外环 | **复盘** | 整件事哪里对/错？plan 漏了什么？ | 这次任务的教训 | goal 封存时 |
| 元环 | **沉淀** | 教训怎么变成下次的规划智慧？ | 未来的规划/检查标准 | 复盘后、需批准 |

---

## 2. 核心原语：环（一次实验）

### 2.1 定义

**一个「环」= 一次「实验」**，包含五个要素：

```
假设（我们假设/决定了什么）→ 决策（为什么这么想）→ 任务（做什么）
  → done_when（客观尺子）→ 结果（读数：尺子达标没、假设成立没、发现什么）
```

上一环的「结果/发现」会变成下一环的「前提」。

### 2.2 粒度铁律

**一个环 = 一个具体任务（一个 todo 项），不是一次 tool call。**

- 一个 tool call 是「动作」，没有假设/判据，只是执行；
- 一个任务才是「实验」：多个 tool call 共享一个假设、一把尺子。

证据（轨迹引用）按**任务粒度**存：一个环的指针 `(sessionId, seq 区间)` 覆盖它那整个任务的所有 tool call；
需要深挖时再临时切片到具体 tool call，但切片是临时动作，不是存储单位。

---

## 3. 结构：两层 + 语义 track

### 3.1 两层（深度 2）

```
根环 = DSH 原生 goal（生命线，不自己造）
叶环 = 环（一次实验）
```

「阶段」不设第三层，降级为「标签」或「由 dependencies 的 DAG 自动浮现」。

### 3.2 语义 track（并行只发生在语义层）

并行不是执行上的并行（时间上是顺序的），而是**语义上的并列**：一个 session 里顺序地做研究、分析、开发，
把这三类看成同一棵树的并列分支。

```
执行轴（时间，顺序）：session 一生 = 一串 goal，一次一个 → DSH 原生 goal 管，orbit 不碰
语义轴（类型，轨道）：每个 goal 带一个 track 标签 → orbit 管一个字段
```

- track 取值 = 原 orbit 的 `task_type`（research / analysis / trade / query / config / other）。
- 多个 goal 按 track 分组，组成一棵可导航的树（flowith 式），导航/渲染交给 aura（晚做）。

### 3.3 结构图

```
session（容器）
  ├─ goal A  [track: 研究]  ── 环·环·环
  ├─ goal B  [track: 分析]  ── 环·环·环
  └─ goal C  [track: 开发]  ── 环·环·环
```

---

## 4. 反思三层环的落地

- **纠偏（内环）**：`环.update` 完成后，`环.review` 记录对齐度 / 假设破裂 / 影响后续 / next_focus。
- **复盘（外环）**：goal 封存时，聚合所有环产出结构化复盘（见 §5.3）。
- **沉淀（元环）**：复盘教训按 track 聚合进 playbook（见 §5.2），**进化 = 修改持久化状态，必须过用户确认门**
  （与 critical 门同一原则：自动改规划知识是不可逆写入）。

### 进化闭环

```
done_when（客观尺子）──使能──▶ 复盘（客观评判判据质量）──产出──▶ playbook（更好的判据模板）
        ▲                                                                  │
        └──────────── 下次同 track 新 goal 规划时注入 ◀────────────────────┘
```

---

## 5. 数据结构

### 5.1 环（一次实验）—— 存 `ctx.storage.domain`，key = ring_id

```jsonc
{
  "ring_id": "ring_xxx",
  "goal_id": "goal_xxx",                 // 所属 goal（根）
  "track": "analysis",                    // 语义轴 = task_type
  "assumption": "数据源可用",              // 假设
  "reason": "基于昨日快照正常",            // 当时为什么这么想（轻量一句）
  "task": "拉取 55 只 K 线",               // 做什么
  "done_when": "55 只标的 K 线更新到最新交易日",  // 客观尺子

  "status": "completed",                  // pending/running/awaiting_approval/completed/skipped/failed
  "critical": false,                      // 不可逆/对外 → 关键门（ask_user_question 确认）

  "result": { "done_when_met": true, "findings": ["..."], "risks": ["..."] },

  "review": {                             // 内环纠偏（单环自评）
    "alignment": "aligned",               // aligned/partial/drifted
    "assumption_broke": false,
    "affects_future": false,
    "next_focus": null
  },

  "evidence": { "session_id": "...", "seq_start": 123, "seq_end": 156 },  // 轨迹指针

  "created_at": "...", "updated_at": "..."
}
```

### 5.2 任务类型 playbook（进化输出）—— 存 `ctx.storage.domain`，key = track

```jsonc
{
  "track": "analysis",
  "good_node_patterns": ["先取数 → 算指标 → 出报告"],
  "common_assumptions_to_check": ["数据源可用性", "口径是否一致"],
  "good_done_when_examples": ["'55 只 K 线已更新到最新交易日'"],
  "revision": 3,
  "updated_at": "..."
}
```

### 5.3 复盘（外环输出，goal 封存时）

```jsonc
{
  "goal_id": "...", "track": "analysis", "summary": "...",
  "what_worked": ["..."], "what_failed": ["..."],
  "plan_gaps": ["..."],
  "done_when_quality": { "good": ["判据A"], "poor": ["判据B"] },
  "would_do_differently": ["..."],
  "created_at": "..."
}
```

---

## 6. 运行形式（DSH host 侧 cordis 插件）

**orbit = 一个 DSH host 侧 cordis 插件**（与其他 DSH host 侧 cordis 插件同形态），
`dsh plugin --profile web add orbit` 安装。职责边界：

| 由插件做 | 由 DSH 原生做（不写） |
|---|---|
| 环的 schema + 校验 | 线性日志 = 会话轨迹（带 UI） |
| 环/playbook 的 `ctx.storage.domain` 读写 | 根环生命 = goal（phase 机 + 续轮） |
| `orbit_*` 工具（create/update/review/reflect/close/playbook） | 关键节点确认 = ask_user_question |
| 复盘 + 进化逻辑（在 tool handler 里） | 浅层进度展示 = todo_write 镜像 |
| system prompt 段 | 流程图/复盘皮肤 = aura（未来 client 插件） |

**不是**：独立进程、client UI 插件（那是 aura）、skill（system-prompt 段只是插件的一部分）。

---

## 7. 与 DSH 原生 / 生态的接缝

- **goal**：根环的生命线，orbit 通过 `ctx.goals` seam 挂靠，不重复造 phase 机。
- **轨迹**：环的 evidence 指针指向会话日志（`sessionId + seq 区间`），复用原生轨迹 UI 做「证据回放」。
- **todo_write**：把环的浅层状态镜像成 todo 清单，白拿原生「步骤+状态」UI。
- **storage.domain**：环/playbook 的持久化（schema 校验 + 事件发射 + 并发安全），不碰会话日志（第三方事件类型会崩）、不碰文件 hack。
- **aura**：未来 client 插件，消费「渲染 spec」（= 环树 JSON）画流程图（借鉴 archify 的 typed JSON IR + DAG + 快照对比）。

---

## 8. 差异化（为什么值得做）

| 维度 | 记忆插件 | 看板/工作流 | **orbit** |
|---|---|---|---|
| 记什么 | 世界事实 | 任务状态 | **决策证据链（假设→任务→结果）** |
| 判据 | 无 | 主观 done | **客观 done_when** |
| 评估 | 无 | 无 | **滚动建设性评估** |
| 进化对象 | 记忆/技能 | 无 | **规划智慧（playbook）** |

orbit 只进化「怎么规划、怎么检查」这门手艺；不碰记忆（那是记忆类插件）、不碰技能（那是技能类插件）。

---

## 9. 路线图

| 期 | 内容 | 依赖 |
|---|---|---|
| **v1（核心）** | 环的 schema + 持久化（storage.domain）+ `orbit_*` 工具 + 纠偏（内环）+ 复盘（外环） | 无 |
| **v2（进化）** | 复盘沉淀成 playbook（过用户门）+ 新 goal 规划时注入 playbook | v1 |
| **以后** | 语义 track 的树状导航 + aura 流程图渲染 + 飞书进度卡 | v1/v2 |
