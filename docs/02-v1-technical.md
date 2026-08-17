# Orbit v1 技术设计（原 orbit，改名 orbit）

> 状态: draft | 日期: 2026-08-14
> 上游: `07-dsh-native-design.md`（产品定案）。本文基于对 DSH rc.6 源码查实的 3 个事实
> （storage.domain 宿主级共享 / ctx.goals 挂靠 / 会话事件 seq），给出 v1 落地级技术设计。

---

## 0. 命名

- 产品/插件名从 `orbit` 改为 **`orbit`**（环 + 轨道；根环绕 goal 转，反思=轨道修正）。
- 插件包 `dsh-orbit`，工具 `orbit_*`，storage domain 名 `orbit`。

## 1. 插件形态与骨架（继承自 dsh-contract，改造不重写）

- 一个 host 侧 cordis `Service`：`static inject = ["tools", "systemPrompt"]`（另需 `"goals"` 与 `"storage"` 的访问）。
- 骨架保留：`Service` 结构、`defineTool`、`ask_user_question` 审批门、system prompt 段注入。
- 换掉：文件持久化 → `ctx.storage.domain`；数据模型 contract/nodes → 环（ring）。

## 2. 已查实的 3 个技术事实（设计依据）

| # | 事实 | 落地含义 |
|---|---|---|
| 1 | `ctx.storage.domain` 宿主级共享，`defineDomain` 三表 + zod，写链串行 + 先落盘后改内存 + 发射 `domain/changed` | 环/复盘/playbook 的真相源，跨 session 共享 |
| 2 | `ctx.goals` 服务（`super(ctx,"goals")`），`get(agent)`→`{id,objective,phase,revision}`；封存=phase`complete`，事件 `goal/change` | 根环读 goal；复盘 v1 显式触发、v2 监听 `goal/change` |
| 3 | `SessionEvent={type,seq,time,data}`，`agent.session.id`+`.events`+`.append` | 证据指针 `(sessionId, seqStart, seqEnd)` |

## 3. storage domain spec

```js
// dsh-orbit/lib/domain.js
import { z } from "zod";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";

const RingStatus = z.enum(["running", "awaiting_approval", "completed", "failed", "skipped"]);

export const ringSchema = z.object({
  ring_id: z.string(),
  goal_id: z.string(),            // 所属 goal（根环）
  track: z.string(),              // 语义轨道 = task_type（research/analysis/...）
  assumption: z.string(),         // 假设（可空字符串）
  reason: z.string(),             // 当时为什么这么想（轻量一句，可空）
  task: z.string(),               // 做什么
  done_when: z.string(),          // 客观尺子
  critical: z.boolean(),

  status: RingStatus,
  result: z.object({
    done_when_met: z.boolean(),
    summary: z.string(),
    findings: z.array(z.string()),
    risks: z.array(z.string()),
  }).nullable(),

  review: z.object({              // 内环纠偏（单环自评）
    alignment: z.enum(["aligned", "partial", "drifted"]),
    assumption_broke: z.boolean(),
    affects_future: z.boolean(),
    next_focus: z.string().nullable(),
  }).nullable(),

  evidence: z.object({            // 轨迹指针
    session_id: z.string(),
    seq_start: z.number(),
    seq_end: z.number().nullable(), // 未关闭时为 null
  }),

  created_at: z.string(),
  updated_at: z.string(),
});

export const reflectionSchema = z.object({
  reflection_id: z.string(),
  goal_id: z.string(),
  track: z.string(),
  summary: z.string(),
  what_worked: z.array(z.string()),
  what_failed: z.array(z.string()),
  plan_gaps: z.array(z.string()),
  done_when_quality: z.object({ good: z.array(z.string()), poor: z.array(z.string()) }),
  would_do_differently: z.array(z.string()),
  created_at: z.string(),
});

export const playbookSchema = z.object({
  track: z.string(),
  good_node_patterns: z.array(z.string()),
  common_assumptions_to_check: z.array(z.string()),
  good_done_when_examples: z.array(z.string()),
  revision: z.number(),
  updated_at: z.string(),
});

export const orbitDomain = defineDomain({
  name: "orbit",
  version: 1,
  tables: {
    rings:       { valueSchema: ringSchema },
    reflections: { valueSchema: reflectionSchema },
    playbooks:   { valueSchema: playbookSchema },
  },
});
```

- 打开：构造后 `await ctx.storage.domain.open(orbitDomain)`，用 `ctx.effect` 持有并关闭。
  （`open` 是 async，走 cordis `[Service.init]` 或 `ctx.effect`，细节实现时定。）
- 读取用 `domain.rings.get(ringId)`、写用 `.put` / `.update`；跨 session 自动共享。

## 4. orbit_* 工具面（v1）

| 工具 | 用途 | 关键参数（required 标 *） |
|---|---|---|
| `orbit_ring_create` | 开始一次实验（任务） | `task`* `done_when`* `assumption` `reason` `critical` `track` |
| `orbit_ring_close` | 结束实验，记录结果 | `ring_id`* `done_when_met`* `summary` `findings` `risks` |
| `orbit_ring_review` | 内环纠偏（滚动） | `ring_id`* `alignment`* `assumption_broke`* `affects_future`* `next_focus` |
| `orbit_reflect` | 外环复盘（goal 封存） | `summary`* `what_worked` `what_failed` `plan_gaps` `done_when_quality` `would_do_differently` |
| `orbit_playbook` | 读某 track 的 playbook | `track`* |

关键行为：
- `orbit_ring_create` 记 `seq_start`（当前 session 最后事件 seq）；`critical=true` 时先 `ask_user_question` 弹确认卡，批准才返回「去执行」，否则 status=skipped。
- `orbit_ring_close` 记 `seq_end`、写 `result`、设 status（`done_when_met` → completed/failed）。
- `orbit_ring_review` 写 `review`；`affects_future=true` 且无后续动作时，仅记录（v1 不自动改 roadmap）。
- `orbit_reflect` 聚合当前 goal 的所有环 → 写 reflections 表 → **提议 playbook 更新（pending 态，等用户批准后才落，见 §6）**。

## 5. goal 挂靠

- 根环 = 原生 goal：每个工具 execute 内 `const goal = ctx.goals.get(exec.agent)` 取 `{id, objective, phase}`。
- 环的 `goal_id` 从当前 active goal 来；无 active goal 时 `orbit_ring_create` 提示「先建 goal」。
- 复盘触发：
  - **v1 显式**：agent 调 `update_goal(complete)` 后，同一轮调 `orbit_reflect`。
  - **v2 自动**：`ctx.on("session/event")` 监听 `goal/change`（phase=complete）→ 自动触发复盘。

### 5.1 边界：v1 固定 goal，简单任务不进 orbit（2026-08-14 定案）

- **根固定为 goal**：环必须有 `goal_id`；无 active goal 时不建环，提示先建 goal。
- **简单任务不进 orbit**：一句话查询、单步操作等无「决策/假设」可反思的任务，agent 直接执行，
  不建 goal、不建环、不复盘——orbit 的价值（纠偏/复盘/沉淀）只存在于有决策密度的多步任务里。
- **为什么不现在放宽 scope**：前期数据一致 = 复盘/进化的输入干净；第一版复盘只吃「goal 内环」一种形态，
  「第二次规划更好」才测得准。放宽是加法不是改法（`track` 字段已预留），将来要把根扩成 scope 时不动现有 schema。
- **沉淀统一性靠 `track`**（不靠 scope）：不同 goal 的环只要 `track` 相同，就进同一本 playbook；
  粒度噪声（叶层判据 vs 根层判据）留待将来用「环的 depth 字段」分区，v1 不做。

## 6. 复盘 → playbook 注入（进化，需过门）

```
orbit_reflect 产出 reflection
  → 按 track 聚合「本 goal 的教训」→ 生成 playbook 候选
  → 候选写入 playbooks 表（mark: pending，不直接覆盖）
  → 弹 ask_user_question：『是否把本次教训并入 track=<t> 的 playbook？』
  → 批准 → 合并进 playbook（revision+1）；拒绝 → 丢弃候选
```

- 下次 `orbit_ring_create`（同 track）时，自动把 `playbooks.get(track)` 的
  `good_node_patterns` / `common_assumptions_to_check` / `good_done_when_examples`
  注入到工具返回里，提示 agent 参考（规划起点更高）。
- **进化 = 修改持久化状态，必须过用户门**（与 critical 门同一原则）。

## 7. evidence 指针

- `seq_start`：`orbit_ring_create` 时 `agent.session.events` 最后一个事件的 `seq`（无事件则 0）。
- `seq_end`：`orbit_ring_close` 时同样取当前最后 `seq`。
- 证据回放（v1 不做，v2）：`orbit_playbook`/`orbit_reflect` 里可按 `(session_id, seq 区间)` 切片会话日志。
- 已知边界：手动重建日志会 seq 漂移（事故恢复路径）→ 回放时显式报「证据回放失败」而非静默错。

## 8. todo 镜像（v1 后段，白拿 UI）

- 环的浅层状态 → 维护一份 todo 列表（`task`=环.task，`status`=环.status 映射到 pending/in_progress/completed）。
- 每个环 create/close 后，用 `agent.session.append("todo/write", { todos })` 全量重写（`todo/write` 是白名单事件，安全，复用原生 UI）。
- 这是「可干预面板」的 v1 骨架；完整 DAG 流程图留待 aura（未来 client 插件）。

## 9. 与旧 dsh-contract 的改造映射

| dsh-contract（旧） | dsh-orbit（新） | 动作 |
|---|---|---|
| `lib/index.js` Service 骨架 | `lib/index.js` | 保留骨架，改工具/持久化 |
| `readStoredContract/writeStoredContract`（文件 hack） | `ctx.storage.domain` | 删除，换 domain |
| `foldContract/cloneContract` | `domain.rings.get`（返回即可改，domain 内内存非冻结） | 删除 fold，clone 视需 |
| `contract_create/get/update/review/close` | `orbit_ring_create/close/review/reflect/playbook` | 重写签名与语义 |
| `askApproval`（userQuestions） | 保留 | 迁到 ring_create 的 critical 门 |
| system prompt 段 | 重写 | 环的叙事 + 工具用法 |
| 包名 `dsh-contract` | `dsh-orbit` | 重命名 + 重新 `dsh plugin add` |

## 10. 落地顺序（v1）

1. 建 `packages/dsh-orbit`（从 dsh-contract 改），domain spec + 打开逻辑。
2. 5 个 `orbit_*` 工具 + goal 挂靠 + evidence 指针。
3. `orbit_reflect` 复盘 + playbook 候选（先不做合并门，先落 reflections）。
4. playbook 注入（§6）+ critical 门 + todo 镜像（v1 后段）。
5. 用一个真实 track 做 dogfooding，验证「第二次规划起点更高」（Node 7 的重点目标）。

## 11. 风险与开放问题

1. `domain.open` 的 async 初始化时机（`[Service.init]` vs `ctx.effect`）——实现时验证，失败会 fail-loud。
2. `ctx.goals.get(agent)` 在非 goal 上下文的返回值——需实测「无 active goal」时的形态（null vs throw）。
3. `todo/write` 全量重写的并发：orbit 与 agent 手写 todo 可能互踩——v1 先接受，后续按「orbit 独占 todo 列表」约定。
4. playbook 合并门的产品形态（pending 候选存哪、怎么展示）——实现时细化。
