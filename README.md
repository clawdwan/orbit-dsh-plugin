# Orbit

> 一个让 Agent「越做越会做」的反思层 —— 运行在 DeepSeek Harness（DSH）上的插件。

Orbit 不管理任务（那是看板/工作流的事），不记世界事实（那是记忆的事），不记工具用法（那是技能的事）。**它只做一件事：把 Agent 每次「假设→决策→任务→结果」的过程记录成可追溯的证据链，蒸馏成可复用的经验，让下一次同类任务规划得更好。**

---

## 核心概念

### 环（一次实验）

Orbit 的最小原语是「环」——每做一步，就是做一次实验：

```
假设（我们假设/决定了什么）→ 决策（为什么这么想）→ 任务（做什么）
  → done_when（客观尺子）→ 结果（尺子达标没、假设成立没、发现什么）
```

- 根环 = DSH 原生 goal（任务的生命线）
- 叶子环 = 一个具体任务（一个 todo 项，不是一次 tool call）

### 经验（成品，反废话）

从环里蒸馏出的经验，必须满足**三必填**，否则拒收：

| 字段 | 含义 | 为什么能反废话 |
|---|---|---|
| `action` | 下次具体做什么不同的事 | 没有可动作项 = 废话 |
| `evidence` | 依据哪些环（可回放） | 逼它回到真实数据 |
| `invalidates_when` | 何时会被推翻 | 不可证伪 = 废话 |

经验还带**两层适用域**：`track`（语义轨道：研究/分析/交易/查询/配置/其他）+ `scope`（全局 / 某会话）。

### 闭环

```
环(记录) → 纠偏 → 复盘 → 蒸馏(pending) → review 收/改/拒 → active → 下次建环自动注入
```

---

## 安装

```sh
dsh plugin --profile web add github:clawdwan/orbit-dsh-plugin
```

重启 `dsh web` 即可。安装后第一次对话，Agent 会主动引导你配置通知（可选）。

## 配置（都在 cordis.patch.yml 里，全部可选）

```yaml
config:
  distillIntervalSeconds: 604800   # 定时蒸馏间隔（秒），默认 7 天
  distillProvider: deepseek-official  # 蒸馏模型 provider
  distillModel: deepseek-v4-flash     # 蒸馏模型，默认 flash（蒸馏要干净 JSON，已自动关推理）
  notifyUrl: "http://127.0.0.1:3081/send"   # 通知接口（可选，配了才推送）
  notifyTargetId: "oc_xxx"                    # 通知目标 id（可选，接口实现方定义）
```

- **不配置任何东西**：Orbit 也完整工作——蒸馏、pending、review、注入全靠 Agent 在对话里对接。
- **配了 notify**：定时蒸馏后主动推送提醒到指定目标（如飞书群），体验更好。

---

## 工具（8 个）

| 工具 | 作用 |
|---|---|
| `orbit_ring_create` | 开始一次实验（设假设 + 客观判据） |
| `orbit_ring_close` | 结束实验，记录结果（判据是否达标） |
| `orbit_ring_review` | 内环纠偏（对齐度 / 假设破裂 / 影响后续） |
| `orbit_reflect` | 外环复盘（goal 收口时总结教训） |
| `orbit_experience_add` | 手动沉淀一条成品经验（过门） |
| `orbit_distill` | 离线蒸馏（flash 直调模型，增量，full=true 全量） |
| `orbit_review` | review 过门（list 待审 / apply 收改拒） |
| `orbit_playbook` | 读某 track 的 playbook |

---

## 工作原理

1. **记录**：Agent 用 `orbit_ring_create/close/review` 把每步记成「环」（假设 + 判据 + 结果），持久化在 `ctx.storage.domain`（宿主级共享）。
2. **蒸馏**：定时（或手动）把「已闭环且未蒸馏」的环，用 flash 模型直接分析（不经 agent turn），产出结构化经验候选（pending）。
3. **review 过门**：用户收/改/拒，收下的进 playbook（active，可版本化回退）。
4. **注入**：下次建同类环时，自动注入匹配 track+scope 的活跃经验，让规划起点更高。

### 关键设计

- **增量蒸馏**：每个环带 `distilled_at` 标记，蒸过就不再重复蒸。
- **反废话三必填**：`action/evidence/invalidates_when` 缺失的经验被机械拒收。
- **通知可选**：不配置也能工作，配置了多一层主动推送。
- **平台无关**：Orbit 只认 DSH 原生抽象（goal / storage / session），通知走通用 HTTP 接口。

---

## 设计文档

- [docs/01-product-design.md](docs/01-product-design.md) — 产品定位
- [docs/02-v1-technical.md](docs/02-v1-technical.md) — v1 技术设计
- [docs/03-v2-evolution.md](docs/03-v2-evolution.md) — v2 进化（蒸馏/沉淀）

## License

[Apache-2.0](LICENSE)
