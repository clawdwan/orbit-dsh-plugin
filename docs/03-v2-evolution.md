# Orbit v2 进化设计：沉淀与蒸馏（Node 9）

> 状态: draft | 日期: 2026-08-14
> 上游: Node 7（产品定案）/ Node 8（v1 技术设计）。本文定义「元环」——如何把积累的环蒸馏成可复用经验，
> 并异步过门（周报 review）后注入回规划。

---

## 0. 一句话

**元环 = 离线（cron）把「环的客观记录」蒸馏成「带证据、可动作、可证伪、带适用域」的成品经验，
经用户周报 review 裁决后版本化入 playbook，下次建环时按当前任务限量注入。**

## 1. 为什么 v1 的「抄文本」不够

v1 的 `playbookCandidate` 把 `what_worked/what_failed` 等自由文本直接切片塞进 playbook，三个问题：
1. **语义错配**：`good_node_patterns` 填了「感想」，不是「结构规律」；
2. **不可审计**：分不清某条经验基于几个真实环，还是 agent 编的；
3. **不可动作**：产出的是「总结」，不是「下次具体做什么不同的事」。

## 2. 沉淀链路总览（一个 cron，两个「时机」）

```
环完成          → 只记录                                        [v1 已有]
goal 封存       → 复盘，存 reflection                           [v1 已有]
cron（每周）    → 一次唤醒 agent：蒸馏（分析积累数据 → 候选存 pending）
                  → 发群消息通知「本周有 N 条经验待审，回 review 查看」
                  → 到此结束，不弹卡、不阻塞                       [新增，元环]
你（异步，任意时间）→ 群里回「review」→ 逐条收/改/拒 → 版本化入 playbook  [过门]
下次 ring_create → 按 track+scope 限量注入                       [v2 已实现]
```

**关键修正**：「蒸馏 + 通知」是**同一个 cron 的一件事**（agent 在收件 session 里一次做完）；
「裁决」不是第二个 cron，而是**用户时机**（看到群消息后随时响应）。这样 cron 在凌晨触发也不会
弹卡阻塞，消息躺在群里等你。

## 3. 蒸馏：计算做骨架，agent 写血肉

| 层 | 谁做 | 产出 | 性质 |
|---|---|---|---|
| 证据统计 | 计算（确定） | 「track=analysis 近 10 环 4 个 assumption_broke，3 个是数据源类」 | 永不幻觉、可复现 |
| 洞察撰写 | agent（语义） | 「分析类任务最常在数据源假设翻车，下次优先验证」 | 有语义，但**每条必须挂证据引用** |

- 增量：cron 只喂「自上次蒸馏以来新增的环 + 当前 playbook 快照」，做增量提炼，不全量重算。
- 按 track 分开各产一版；周报可汇总成一份。

## 4. 反「正确的废话」：三个必填字段

模型对记录做提炼时容易输出「可复述、不可动作」的泛化句。用**结构逼它说人话**：

| 必填字段 | 含义 | 为什么能反废话 |
|---|---|---|
| `action` | 下次建这类环时，具体做什么不同的事 | 没有可动作项 = 经验不成立，直接丢弃 |
| `evidence` | 基于哪几个环（ring_id 引用，可回放） | 逼它回到真实数据上，不能空谈 |
| `invalidates_when` | 什么情况下这条经验会被推翻 | 「注重质量」不可证伪=废话；「连续 10 环无数据源问题」可证伪 |

**缺失 `action` 或 `invalidates_when` 的经验，拒收，不进 playbook。**

## 5. 适用域：两层（track + scope）

经验不是全局通用的，也不能只按 track。两个正交轴：

| 经验类型 | 例子 | scope | 注入给谁 |
|---|---|---|---|
| 通用 | 「分析类任务都该验证数据源」 | `kind: global` | 任何会话的 analysis 任务 |
| 会话特定 | 「这个群的数据源要接飞书 App Secret」 | `kind: session, id: <session_id>` | 仅该会话 |

- **scope 标识 = 群 / 会话**（飞书群 ↔ DSH session 1:1，环的 `evidence.session_id` 即标识）。
- agent 蒸馏时必须给每条经验打「通用 / 会话特定」标，避免把一条项目特定经验张冠李戴注入到别的会话。

## 6. 经验完整 schema（v2 playbook 条目）

```jsonc
{
  "track": "analysis",                                    // 语义轨道
  "scope": { "kind": "global" }                            // 或 { kind: "session", id: "<session_id>" }
  ,
  "experience": "分析类任务最常在数据源假设上翻车",
  "action": "建环时把「数据源可用」列为必查假设",           // 必填：可动作
  "evidence": ["ring_a", "ring_b"],                        // 必填：依据，可回放
  "invalidates_when": "连续 10 环无数据源类 assumption_broke", // 必填：可证伪
  "version": 1,
  "created_by": "distill@2026-08-14",
  "status": "active"                                       // active | rejected | outdated
}
```

## 7. 过门：cron 通知 + 用户时机裁决

- **触发（一个 cron）**：`dsh-schedule` 每周 `every` 到点 → 往「orbit 收件 session」注入一条 prompt。
- **蒸馏 + 通知（同一轮）**：收件 agent 醒来 → 对积累数据做一轮分析（去重/提炼/合并）→ 产出【经验候选】存 pending → 发一条群消息通知，**不弹卡、不阻塞**。
- **裁决（用户时机）**：用户之后在群里回「review」→ agent 逐条呈现「成品经验 + 证据底账」→ 用户收 / 改 / 拒。
- **过门语义**：cron 只产出候选（pending），不直接落 playbook；合并发生在用户 review 之后（守住「进化必须过门」）。

> 为什么不「cron 直接弹卡裁决」：cron 可能在凌晨触发，弹卡会让该轮阻塞数小时等人。正确形态是
> 「通知在线、裁决异步」——消息躺在群里，用户有空再回。

## 8. 注入：限量 + 排序 + scope 匹配

- **限量**：每类 top 3~5，总量 ~200 token 内。
- **排序**：按「对当前任务相关性」——recency + frequency + 与当前 task/assumption 的文本重叠；v1 用笨办法，将来升级向量相似度。
- **scope 匹配**：只注入 `kind: global` 或 `kind: session 且 id==当前会话` 的经验。

## 9. 版本化与可回退

- 每条经验带 `version` + `created_by` + `status`。
- 用户拒绝 → `status: rejected`；后来发现错了 → `status: outdated`（不物理删除，留痕）。
- 重提炼产出新版本，旧版本留痕可查；防止「一条坏经验永久污染 playbook」。

## 10. 实现进度

| # | 内容 | 状态 |
|---|---|---|
| 1 | 经验 schema 升级（结构化条目 + 三必填 + scope） | ✅ 已实现（domain v2） |
| 2 | `orbit_experience_add`（沉淀成品经验，过门） | ✅ 已实现 |
| 3 | `orbit_ring_create` 注入（track+scope 限量） | ✅ 已实现 + dogfooding 验证 |
| 4 | 离线蒸馏（cron：dsh-schedule + agent 分析 → pending） | ⏳ 待做 |
| 5 | 异步过门（cron 通知 + 用户时机 review 收/改/拒） | ⏳ 待做 |
| 6 | 持续 dogfooding（验证注入让第二次规划起点变高） | 进行中 |

**剩余（#4/#5）依赖三个待实证 API**（见 §11）：schedule 创建方法、session.prompt seam、cron 轮次弹卡。

## 11. 技术事实查证结果（2026-08-14）

1. **调度用 `dsh-schedule`，不是 cordis-plugin-timer** ✅
   - `dsh-schedule` = 「agent-scoped durable after/at/every reminders over the session event log」。
   - 三种 kind：`after`（延迟）/ `at`（绝对时刻，IANA tz）/ `every`（固定频率 `everySeconds`）。
   - 每条 schedule 自带 `prompt`（到点注入的文案），存为 `schedule/change` 事件（create/delete/dispatch），**可持久、重启不丢**。
   - 「每周」= `every` + `everySeconds=604800` + `prompt="orbit 周报…"`。
   - ⚠️ 待实证：从插件里创建 schedule 的确切 service 方法名（验证逻辑在 dsh-schedule，触发在 dsh-session，实现时用隔离测试确认）。

2. **主动 prompt 一个 session** ✅（半）
   - `session.prompt` RPC 有 `mode: "queue" | "steer"`；`steer` 走 `agent.steer(message)`（要求 agent running），`queue` 排队到下一轮。
   - 会话用 `ctx.sessions.get(sessionId)` 取得。
   - ⚠️ 待实证：插件内触发 queued prompt 的确切 seam 方法（RPC 实现在 dsh-host-apiproxy）。

3. **cron 轮次能否正常产出通知、用户时机能否裁决** ⚠️ 待实证
   - 简化后：cron 轮**不需要**弹卡——它只需「蒸馏 + 发一条通知消息」，通知经飞书桥回群。
   - 裁决发生在用户时机（群里回「review」），那是普通用户消息触发的轮次，`ask_user_question` 正常可用。
   - ⚠️ 待实证：schedule 注入 prompt 是否能真正起一个 agent 轮、其输出能否经飞书桥回群。

> 结论：架构上三条路都通（dsh-schedule + session.prompt + ask_user_question），剩余是精确方法名，
> 留到 v2 实现时用隔离测试逐个确认。
