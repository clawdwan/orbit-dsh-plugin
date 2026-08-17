// ============================================================
// dsh-orbit — 「越做越会做」的反思层
// ------------------------------------------------------------
// 核心原语是「环」（一次实验）= 假设 + 决策 + 任务 + done_when + 结果。
// 根环 = DSH 原生 goal；环存 ctx.storage.domain（宿主级共享）。
// 内环纠偏 / 外环复盘 / 元环沉淀（playbook，过用户门）。
// ============================================================

import { Service } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { orbitDomain, normalizeTrack } from "./domain.js";

const LOOSE_OUTPUT = {
  schema: { type: "object", additionalProperties: true, properties: {} },
  render: (_args, value) => {
    const text =
      value && typeof value.message === "string"
        ? value.message
        : JSON.stringify(value ?? {}, null, 2);
    return [{ type: "text", text }];
  },
};

/** 解析 JSON 字符串数组参数（容错）。 */
function parseJsonArray(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 当前会话最后事件的 seq（用于 evidence 指针）。 */
function currentSeq(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events) || events.length === 0) return 0;
  const last = events[events.length - 1];
  return typeof last?.seq === "number" ? last.seq : 0;
}

function ok(message, extra) {
  return { ok: true, message, ...(extra ?? {}) };
}
function fail(message) {
  return { ok: false, message };
}

class OrbitController extends Service {
  static inject = ["tools", "systemPrompt", "storage", "goals", "llm", "timer"];

  #domainPromise = null;
  #distillProvider;
  #distillModel;
  #distillIntervalSeconds;
  #notifyUrl;
  #notifyTargetId;

  constructor(ctx, config = {}) {
    super(ctx, "orbit");

    // 蒸馏模型：可配置，默认 flash（蒸馏是单次 JSON 提取，不需要强推理）。
    this.#distillProvider = typeof config.distillProvider === "string" && config.distillProvider ? config.distillProvider : "deepseek-official";
    this.#distillModel = typeof config.distillModel === "string" && config.distillModel ? config.distillModel : "deepseek-v4-flash";
    // 定时蒸馏：可配置间隔（秒），默认 7 天；0 或未设则禁用。
    this.#distillIntervalSeconds = Number.isFinite(config.distillIntervalSeconds) && config.distillIntervalSeconds > 0
      ? config.distillIntervalSeconds
      : 604800;
    // 通知（可选）：配了 url+targetId 就推送，否则只写 pending、靠 agent 对话时对接。
    this.#notifyUrl = typeof config.notifyUrl === "string" && config.notifyUrl ? config.notifyUrl : null;
    this.#notifyTargetId = typeof config.notifyTargetId === "string" && config.notifyTargetId ? config.notifyTargetId : null;

    // 定时：定期自动蒸馏全部 track（回调里闭环，不依赖 agent turn）。
    ctx.interval(() => {
      this.autoDistill().catch((err) => {
        try { ctx.logger?.("orbit")?.warn?.("autoDistill 失败: %o", err); } catch {}
      });
    }, this.#distillIntervalSeconds * 1000);

    ctx.systemPrompt.section({
      name: "orbit:policy",
      order: 60,
      text: () => `## Orbit（反思层）

收到**有决策密度的多步任务**时，先建一个 goal，然后把它拆成一次次的「实验」（环）逐环推进：
1. 开始一步：orbit_ring_create(task=做什么, done_when=客观完成判据, assumption=假设, reason=为什么这么想, critical=是否不可逆/对外)；
2. 做完记录：orbit_ring_close(ring_id, done_when_met=判据是否达标, findings/risks)；
3. 需要时纠偏：orbit_ring_review(ring_id, alignment=aligned|partial|drifted, assumption_broke, affects_future)；
4. goal 收口时复盘：orbit_reflect(summary, what_worked/failed, plan_gaps, done_when_quality, would_do_differently)；
5. 复盘后若有成品经验，用 orbit_experience_add 逐条沉淀（必填 action/evidence/invalidates_when/scope）；
6. 下次同类任务时，orbit_ring_create 会自动注入匹配的参考经验。

简单任务（一句话查询/单步）不要建 goal、不要用环，直接执行即可。

**待审提醒**：每次对话开始或有 pending 待审经验时，主动提醒用户「有 N 条待审经验，回复 review 查看并裁决」。用户说 review 后，用 orbit_review(action="list") 列出 pending，再按用户「收/改/拒」用 orbit_review(action="apply") 应用。

**通知配置引导**：orbit 支持每周自动蒸馏后推送提醒到某个飞书群。若用户想开启，问用户要飞书群 id，然后改 cordis.patch.yml 里 dsh-orbit 的 config，填 notifyUrl（桥的 /send 地址）和 notifyTargetId（飞书群 id）。未配置也照常工作，只是没有主动推送。`,
    });

    ctx.tools.register(defineTool({
      name: "orbit_ring_create",
      description:
        "开始一次「实验」（一个任务环）：设定假设、客观完成判据(done_when)，记录轨迹起点。critical=true 的环会先弹确认卡。要求当前有 active goal。",
      parameters: {
        task: { type: "string", required: true, description: "这一步要做什么" },
        done_when: { type: "string", required: true, description: "客观完成判据：一个可观测的事实，达成即算完成" },
        assumption: { type: "string", description: "这一步依赖的假设（可空）" },
        reason: { type: "string", description: "当时为什么这么想/这么决定（一句，可空）" },
        critical: { type: "boolean", description: "是否不可逆/对外操作，true 时执行前需确认" },
        track: { type: "string", description: "语义轨道 research|analysis|trade|query|config|other" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const goal = this.ctx.goals.get(agent);
        if (!goal) return fail("没有 active goal，请先建 goal（create_goal）再开始环");
        const domain = await this.domain();

        const ring = {
          ring_id: `ring_${randomUUID().slice(0, 8)}`,
          goal_id: goal.id,
          track: normalizeTrack(args.track),
          assumption: typeof args.assumption === "string" ? args.assumption.trim() : "",
          reason: typeof args.reason === "string" ? args.reason.trim() : "",
          task: args.task.trim(),
          done_when: args.done_when.trim(),
          critical: args.critical === true,
          status: args.critical === true ? "awaiting_approval" : "running",
          result: null,
          review: null,
          evidence: { session_id: agent.session.id, seq_start: currentSeq(agent), seq_end: null },
          distilled_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (ring.critical) {
          const approved = await askApproval(this.ctx, agent, exec.signal, ring);
          if (!approved) {
            ring.status = "skipped";
            await domain.table("rings").put(ring.ring_id, ring);
            return ok(`关键环节「${ring.task}」未获批准，已跳过。`, { ring });
          }
          ring.status = "running";
        }

        await domain.table("rings").put(ring.ring_id, ring);
        const pb = domain.table("playbooks").get(ring.track);
        const hint = pb ? injectExperiences(pb, agent.session.id) : "";
        const base = `已开始环 ${ring.ring_id}（track=${ring.track}）。\n判据: ${ring.done_when}`;
        return ok(hint ? `${base}\n\n${hint}` : base, { ring });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_ring_close",
      description: "结束一次实验，记录结果（判据是否达标）与轨迹终点。",
      parameters: {
        ring_id: { type: "string", required: true },
        done_when_met: { type: "boolean", required: true, description: "done_when 判据是否达成" },
        summary: { type: "string", description: "结果总结" },
        findings: { type: "string", description: '发现的 JSON 字符串数组，如 ["发现A"]' },
        risks: { type: "string", description: '风险信号的 JSON 字符串数组' },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const domain = await this.domain();
        const ring = domain.table("rings").get(args.ring_id);
        if (!ring) return fail(`环 ${args.ring_id} 不存在`);
        if (ring.status === "awaiting_approval") return fail("该环正在等待用户确认，先批准再关闭");

        const findings = parseJsonArray(args.findings);
        const risks = parseJsonArray(args.risks);
        if (findings === null || risks === null) return fail("findings/risks 必须是 JSON 字符串数组");

        ring.result = {
          done_when_met: args.done_when_met === true,
          summary: typeof args.summary === "string" ? args.summary : "",
          findings: findings.filter((f) => typeof f === "string"),
          risks: risks.filter((r) => typeof r === "string"),
        };
        ring.status = args.done_when_met === true ? "completed" : "failed";
        ring.evidence.seq_end = currentSeq(agent);
        ring.updated_at = new Date().toISOString();
        await domain.table("rings").put(ring.ring_id, ring);

        return ok(
          args.done_when_met === true
            ? `环 ${ring.ring_id} 完成（判据达标）。`
            : `环 ${ring.ring_id} 判据未达标，标记 failed。`,
          { ring },
        );
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_ring_review",
      description: "内环纠偏：完成后评估这一步是否对齐目标、假设是否破裂、是否影响后续。",
      parameters: {
        ring_id: { type: "string", required: true },
        alignment: { type: "string", required: true, enum: ["aligned", "partial", "drifted"], description: "对齐程度" },
        assumption_broke: { type: "boolean", required: true, description: "假设是否破裂" },
        affects_future: { type: "boolean", required: true, description: "是否产生会影响后续的新事实" },
        next_focus: { type: "string", description: "下个环节应聚焦的新方向" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const domain = await this.domain();
        const ring = domain.table("rings").get(args.ring_id);
        if (!ring) return fail(`环 ${args.ring_id} 不存在`);

        ring.review = {
          alignment: args.alignment,
          assumption_broke: args.assumption_broke === true,
          affects_future: args.affects_future === true,
          next_focus: typeof args.next_focus === "string" && args.next_focus.trim() ? args.next_focus.trim() : null,
        };
        ring.updated_at = new Date().toISOString();
        await domain.table("rings").put(ring.ring_id, ring);

        return ok(`已记录纠偏（alignment=${args.alignment}）。`, { ring });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_reflect",
      description:
        "外环复盘：goal 收口时，聚合本 goal 的所有环做结构化复盘，并提议把教训并入该 track 的 playbook（需用户批准）。",
      parameters: {
        summary: { type: "string", required: true, description: "本次收口的总结" },
        what_worked: { type: "string", description: '有效的做法 JSON 数组' },
        what_failed: { type: "string", description: '失败的/假设破裂的 JSON 数组' },
        plan_gaps: { type: "string", description: '规划时漏掉的 JSON 数组' },
        done_when_quality_good: { type: "string", description: '设得好的判据 JSON 数组' },
        done_when_quality_poor: { type: "string", description: '设得差的判据 JSON 数组' },
        would_do_differently: { type: "string", description: '下次会怎么改 JSON 数组' },
        track: { type: "string", description: "复盘归属的 track（缺省从本 goal 的环推断）" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const goal = this.ctx.goals.get(agent);
        const domain = await this.domain();

        // 聚合本 goal 的环
        const rings = [];
        for (const [, ring] of domain.table("rings").entries()) {
          if (goal && ring.goal_id === goal.id) rings.push(ring);
        }
        if (rings.length === 0) return fail("当前 goal 下没有环，无法复盘");

        const track = normalizeTrack(args.track ?? dominantTrack(rings));
        const reflection = {
          reflection_id: `refl_${randomUUID().slice(0, 8)}`,
          goal_id: goal ? goal.id : "(no-goal)",
          track,
          summary: args.summary,
          what_worked: arrOr(args.what_worked),
          what_failed: arrOr(args.what_failed),
          plan_gaps: arrOr(args.plan_gaps),
          done_when_quality: {
            good: arrOr(args.done_when_quality_good),
            poor: arrOr(args.done_when_quality_poor),
          },
          would_do_differently: arrOr(args.would_do_differently),
          created_at: new Date().toISOString(),
        };
        await domain.table("reflections").put(reflection.reflection_id, reflection);
        return ok(
          `已复盘并写入 reflection ${reflection.reflection_id}。\n` +
          `若有值得沉淀的成品经验，用 orbit_experience_add 逐条添加（需 experience/action/evidence/invalidates_when/scope）。`,
          { reflection },
        );
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_experience_add",
      description:
        "把一条「成品经验」沉淀进 playbook（过用户门）。反废话三必填：action(下次具体做什么)、evidence(依据哪些环)、invalidates_when(何时失效)。scope=global 通用 / session 仅当前会话。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道" },
        experience: { type: "string", required: true, description: "经验表述（一句）" },
        action: { type: "string", required: true, description: "下次具体做什么不同的事（必填）" },
        evidence: { type: "string", required: true, description: '依据的 ring_id JSON 数组，如 ["ring_xxx"]' },
        invalidates_when: { type: "string", required: true, description: "什么情况下这条经验会被推翻（必填）" },
        scope_kind: { type: "string", enum: ["global", "session"], description: "适用域，默认 global" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const domain = await this.domain();
        const track = normalizeTrack(args.track);

        // 反废话三必填校验
        const action = (args.action ?? "").trim();
        const invalidates = (args.invalidates_when ?? "").trim();
        const evidence = parseJsonArray(args.evidence);
        if (!action) return fail("action 必填：经验必须落到一个具体动作");
        if (!invalidates) return fail("invalidates_when 必填：必须说明何时失效，否则是废话");
        if (evidence === null || evidence.length === 0) return fail("evidence 必填：必须引用至少一个真实环");

        const scopeKind = args.scope_kind === "session" ? "session" : "global";
        const entry = {
          id: `exp_${randomUUID().slice(0, 8)}`,
          experience: (args.experience ?? "").trim(),
          action,
          evidence: evidence.filter((e) => typeof e === "string"),
          invalidates_when: invalidates,
          scope: { kind: scopeKind, id: scopeKind === "session" ? agent.session.id : null },
          version: 1,
          status: "active",
          created_at: new Date().toISOString(),
        };

        // 过用户门
        const approved = await askApproval(this.ctx, agent, exec.signal, {
          task: `沉淀经验到 track=${track} 的 playbook`,
          done_when: `经验「${entry.experience || "(未命名)"}」并入 playbook`,
          title: "沉淀经验",
        });
        if (!approved) return ok("经验未获批准，已丢弃。", { entry: null });

        const pb = domain.table("playbooks").get(track) ?? {
          track,
          entries: [],
          revision: 0,
          updated_at: new Date().toISOString(),
        };
        pb.entries = [...pb.entries, entry];
        pb.revision = (pb.revision || 0) + 1;
        pb.updated_at = new Date().toISOString();
        await domain.table("playbooks").put(track, pb);
        return ok(`已沉淀经验到 track=${track}（revision=${pb.revision}）。`, { entry });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_distill",
      description:
        "离线蒸馏(可手动触发):读某 track 积累的环,直接调模型分析(不经 agent turn),产出经验候选(存 pending,待用户 review)。默认增量(只蒸已闭环且未蒸过的环);full=true 强制全量重蒸。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道" },
        full: { type: "boolean", description: "true=强制全量重蒸(忽略已蒸馏标记),默认 false 增量" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args, exec) => {
        const agent = requireAgent(exec);
        const track = normalizeTrack(args.track);
        try {
          const r = await this.distillTrackCore(track, agent.session.id, { full: args.full === true });
          if (r.skipped) return ok(`track=${track} 没有「已闭环且未蒸馏」的环(可能都已蒸过,或用 full=true 全量重蒸)。`);
          if (r.count === 0) return ok("蒸馏完成,未产出候选经验(可能数据不足或全被三必填过滤)。");
          return ok(`蒸馏完成,产出 ${r.count} 条候选经验(状态=pending,待用户 review)。\n\n${formatEntries(r.candidates)}`, { candidates: r.candidates });
        } catch (e) {
          return fail(`蒸馏失败: ${e?.message || e}`);
        }
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_playbook",
      description: "读取某 track 的 playbook（结构化经验条目：经验/动作/依据/失效条件/适用域），供同类新任务规划时参考。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道 research|analysis|trade|query|config|other" },
      },
      output: LOOSE_OUTPUT,
      execute: async (args) => {
        const domain = await this.domain();
        const track = normalizeTrack(args.track);
        const pb = domain.table("playbooks").get(track);
        if (!pb) return ok(`track=${track} 还没有 playbook。`, { track, playbook: null });
        return ok(formatPlaybook(pb), { track, playbook: pb });
      },
    }));

    ctx.tools.register(defineTool({
      name: "orbit_review",
      description:
        "review 过门：列出某 track 的 pending 候选经验（供用户审阅），或应用用户的收/改/拒裁决（accept→active、reject→rejected、modify→改后 active）。",
      parameters: {
        track: { type: "string", required: true, description: "语义轨道" },
        action: { type: "string", enum: ["list", "apply"], description: "list=列出待审,apply=应用裁决" },
        decisions: { type: "string", description: 'apply 时的裁决 JSON 数组，形如 [{"id":"exp_x","decision":"accept|reject|modify","modified":{...}}]' },
      },
      output: LOOSE_OUTPUT,
      execute: async (args) => {
        const domain = await this.domain();
        const track = normalizeTrack(args.track);
        const pb = domain.table("playbooks").get(track);
        if (!pb) return ok(`track=${track} 还没有 playbook。`);

        if (args.action !== "apply") {
          const pending = pb.entries.filter((e) => e.status === "pending");
          if (pending.length === 0) return ok(`track=${track} 没有待审(pending)经验。`);
          return ok(`track=${track} 有 ${pending.length} 条待审经验：\n\n${formatEntries(pending)}`);
        }

        const decisions = parseJsonArray(args.decisions);
        if (decisions === null) return fail("decisions 必须是 JSON 数组");

        let accepted = 0, rejected = 0, modified = 0;
        for (const d of decisions) {
          if (!d || typeof d !== "object") continue;
          const entry = pb.entries.find((e) => e.id === d.id && e.status === "pending");
          if (!entry) continue;
          if (d.decision === "reject") {
            entry.status = "rejected";
            rejected++;
          } else if (d.decision === "modify" && d.modified && typeof d.modified === "object") {
            if (typeof d.modified.experience === "string" && d.modified.experience.trim()) entry.experience = d.modified.experience.trim();
            if (typeof d.modified.action === "string" && d.modified.action.trim()) entry.action = d.modified.action.trim();
            if (typeof d.modified.invalidates_when === "string" && d.modified.invalidates_when.trim()) entry.invalidates_when = d.modified.invalidates_when.trim();
            entry.version = (entry.version || 1) + 1;
            entry.status = "active";
            modified++;
          } else {
            entry.status = "active";
            accepted++;
          }
        }
        pb.updated_at = new Date().toISOString();
        await domain.table("playbooks").put(track, pb);
        return ok(`已应用裁决：收 ${accepted}、拒 ${rejected}、改 ${modified}。`);
      },
    }));
  }

  /** 惰性打开 storage domain（避免 init 时序问题，首次使用时 open）。 */
  domain() {
    if (!this.#domainPromise) {
      this.#domainPromise = this.ctx.storage.domain.open(orbitDomain);
    }
    return this.#domainPromise;
  }

  /** 蒸馏某 track（核心，供 orbit_distill 与定时共用）。返回 { skipped?, count, candidates }。 */
  async distillTrackCore(track, sessionId, { full = false } = {}) {
    const domain = await this.domain();
    const allRings = [];
    for (const [, ring] of domain.table("rings").entries()) {
      if (ring.track === track) allRings.push(ring);
    }
    if (allRings.length === 0) return { skipped: true, count: 0, candidates: [] };

    // 增量：默认只蒸「已闭环(status completed/failed)且未蒸馏过」的环；full=true 时全量。
    const rings = full
      ? allRings
      : allRings.filter((r) => (r.status === "completed" || r.status === "failed") && r.distilled_at == null);
    if (rings.length === 0) return { skipped: true, count: 0, candidates: [] };

    const pb = domain.table("playbooks").get(track);
    const existingActive = pb
      ? pb.entries.filter((e) => e.status === "active").map((e) => e.experience)
      : [];

    const target = { provider: this.#distillProvider, model: this.#distillModel };
    const prompt = buildDistillPrompt(track, rings, existingActive);
    const text = await runLlm(this.ctx, target, prompt, sessionId ?? "(orbit-auto)");

    const candidates = parseCandidates(text);
    if (candidates === null) {
      throw new Error(`模型输出无法解析为经验 JSON。原始输出(截断):\n${text.slice(0, 800) || "(空)"}`);
    }

    const valid = [];
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const action = String(c.action ?? "").trim();
      const invalidates = String(c.invalidates_when ?? "").trim();
      const evidence = Array.isArray(c.evidence) ? c.evidence.filter((e) => typeof e === "string") : [];
      if (!action || !invalidates || evidence.length === 0) continue; // 反废话三必填
      const scopeKind = c.scope_kind === "session" && sessionId ? "session" : "global";
      valid.push({
        id: `exp_${randomUUID().slice(0, 8)}`,
        experience: String(c.experience ?? "").trim(),
        action,
        evidence,
        invalidates_when: invalidates,
        scope: { kind: scopeKind, id: scopeKind === "session" ? sessionId : null },
        version: 1,
        status: "pending",
        created_at: new Date().toISOString(),
      });
    }

    // 回写蒸馏标记：无论产出多少候选，都把处理过的环标 distilled_at，避免下次重复蒸馏。
    const distilledAt = new Date().toISOString();
    for (const ring of rings) {
      ring.distilled_at = distilledAt;
      await domain.table("rings").put(ring.ring_id, ring);
    }

    if (valid.length > 0) {
      const newPb = pb ?? { track, entries: [], revision: 0, updated_at: new Date().toISOString() };
      newPb.entries = [...newPb.entries, ...valid];
      newPb.updated_at = new Date().toISOString();
      await domain.table("playbooks").put(track, newPb);
    }
    return { count: valid.length, candidates: valid };
  }

  /** 定时自动蒸馏全部 track，并通知收件 session。 */
  async autoDistill() {
    const domain = await this.domain();
    const tracks = new Set();
    for (const [, ring] of domain.table("rings").entries()) tracks.add(ring.track);
    if (tracks.size === 0) return;

    let total = 0;
    const perTrack = [];
    for (const track of tracks) {
      try {
        const r = await this.distillTrackCore(track, null);
        if (r.count > 0) { total += r.count; perTrack.push(`${track}:+${r.count}`); }
      } catch (e) {
        try { this.ctx.logger?.("orbit")?.warn?.(`track=${track} 蒸馏失败: ${e?.message || e}`); } catch {}
      }
    }
    if (total > 0) await this.notifyInbox(total, perTrack);
  }

  /** 通知（可选增强）：配了 url+targetId 就 HTTP 推送到接口；否则静默（靠 agent 对话对接）。 */
  async notifyInbox(total, perTrack) {
    if (!this.#notifyUrl || !this.#notifyTargetId) return;
    const text = `orbit 定时蒸馏完成：产出 ${total} 条待审经验（${perTrack.join(", ")}）。回复「review」查看并裁决。`;
    try {
      const res = await fetch(this.#notifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId: this.#notifyTargetId, text }),
      });
      if (!res.ok) {
        try { this.ctx.logger?.("orbit")?.warn?.(`通知推送失败 http=${res.status}`); } catch {}
      }
    } catch (e) {
      // 通知是 best-effort，失败不影响主链
      try { this.ctx.logger?.("orbit")?.warn?.(`通知推送失败: ${e?.message || e}`); } catch {}
    }
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function requireAgent(exec) {
  const agent = exec?.agent;
  if (agent === undefined) throw new Error("orbit_* 工具需要一个调用 agent");
  return agent;
}

function arrOr(raw) {
  const v = parseJsonArray(raw);
  return v === null ? [] : v.filter((x) => typeof x === "string");
}

function dedupe(list) {
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))];
}

function dominantTrack(rings) {
  const counts = {};
  for (const r of rings) counts[r.track] = (counts[r.track] || 0) + 1;
  let best = "other", bestN = -1;
  for (const [t, n] of Object.entries(counts)) if (n > bestN) { best = t; bestN = n; }
  return best;
}

/** 把一条经验格式成可读文本。 */
function formatExperience(e, i) {
  const scope = e.scope?.kind === "session" ? `会话 ${e.scope.id}` : "通用";
  return [
    `${i}. 【经验】${e.experience}`,
    `   → 动作: ${e.action}`,
    `   依据: ${e.evidence.join(", ")}`,
    `   失效: ${e.invalidates_when}`,
    `   适用: ${scope}`,
  ].join("\n");
}

/** 把 playbook 内容格式成可读文本（供 orbit_playbook 返回）。 */
function formatPlaybook(pb) {
  const active = pb.entries.filter((e) => e.status === "active");
  if (active.length === 0) return `track=${pb.track} 的 playbook（revision=${pb.revision}）暂无活跃经验。`;
  const lines = [`track=${pb.track} 的 playbook（revision=${pb.revision}），${active.length} 条活跃经验：`];
  active.forEach((e, i) => lines.push(formatExperience(e, i + 1)));
  return lines.join("\n");
}

/** 判断一条经验是否适用于当前会话。 */
function matchScope(entry, sessionId) {
  if (entry.status !== "active") return false;
  if (entry.scope?.kind === "session") return entry.scope.id === sessionId;
  return true; // global
}

/** 从 playbook 里挑出适用当前会话的活跃经验，限量格式成「参考经验」注入文本。 */
function injectExperiences(pb, sessionId) {
  const matched = pb.entries.filter((e) => matchScope(e, sessionId)).slice(0, 3);
  if (matched.length === 0) return "";
  const lines = [`参考经验（track=${pb.track}）：`];
  matched.forEach((e, i) => lines.push(formatExperience(e, i + 1)));
  return lines.join("\n");
}

/** 把一批条目格式成可读文本。 */
function formatEntries(entries) {
  return entries.map((e, i) => formatExperience(e, i + 1)).join("\n");
}

/** 插件内直接调模型（不经 agent turn），返回拼好的文本。 */
async function runLlm(ctx, target, prompt, sessionId) {
  const messages = [createUserMessage({
    content: [{ type: "text", text: prompt }],
    source: { kind: "plugin", plugin: "dsh-orbit" },
  })];
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: 2000,
    sessionId,
    purpose: "orbit.distill",
    reasoningEffort: "off", // 蒸馏要干净 JSON，关推理
  };
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const blocks = assembler.blocks();
  return blocks
    .filter((b) => b.type === "text" || b.type === "reasoning")
    .map((b) => b.text)
    .join("");
}

/** 构建蒸馏 prompt：把环的客观字段喂给模型，要求产出结构化经验。 */
function buildDistillPrompt(track, rings, existingActive) {
  const ringData = rings.map((r) => ({
    id: r.ring_id,
    task: r.task,
    done_when: r.done_when,
    assumption: r.assumption,
    done_when_met: r.result?.done_when_met ?? null,
    assumption_broke: r.review?.assumption_broke ?? null,
    alignment: r.review?.alignment ?? null,
  }));
  const existing = existingActive.length
    ? `\n已沉淀的活跃经验(避免重复):\n- ${existingActive.join("\n- ")}`
    : "";
  return [
    "你是「任务经验蒸馏器」。分析某轨道上积累的任务环(每次实验的客观记录)，提炼出可复用的成品经验。",
    "",
    `轨道 track: ${track}`,
    "环数据:",
    JSON.stringify(ringData, null, 2),
    existing,
    "",
    "要求:",
    "- 去重、提炼、合并，只产出真正可复用的经验(不是对单个环的复述)",
    "- 每条必须可动作(action:下次具体做什么不同的事)、可证伪(invalidates_when:何时失效)、有依据(evidence:引用的环 id)",
    "- scope_kind 填 global(通用)或 session(仅当前会话)",
    "- 禁止「正确的废话」(不可动作/不可证伪的话，如『注重质量』『要及时反馈』)",
    "",
    "只输出 JSON 数组(不要输出 JSON 以外的任何文字):",
    '[{"experience":"经验一句","action":"具体动作","evidence":["ring_id"],"invalidates_when":"何时失效","scope_kind":"global"}]',
  ].join("\n");
}

/** 从模型输出里提取经验数组(容错:兼容裸数组、markdown 围栏、对象包裹)。 */
function parseCandidates(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim();
  // 1. 裸数组
  let m = t.match(/\[[\s\S]*\]/);
  if (m) {
    try { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; } catch {}
  }
  // 2. 对象包裹 { experiences|entries|candidates|items: [...] }
  m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (Array.isArray(obj)) return obj;
      for (const k of ["experiences", "entries", "candidates", "items", "results"]) {
        if (Array.isArray(obj[k])) return obj[k];
      }
    } catch {}
  }
  return null;
}

/** 通过 native user-questions 请求确认（关键环 / playbook 合并共用）。 */
async function askApproval(ctx, agent, signal, target) {
  const interaction = ctx.get("userQuestions");
  if (interaction === undefined) return false; // fail-closed
  try {
    const answer = await interaction.ask({
      questions: [{
        id: "orbit-approve",
        header: "Orbit 确认",
        question: `确认「${target.title ?? target.task}」?`,
        detail: target.done_when ? `判据: ${target.done_when}` : undefined,
        options: [
          { label: "批准", description: "允许" },
          { label: "拒绝", description: "跳过/丢弃" },
        ],
        intent: { kind: "orbit-approve", approve: "批准" },
      }],
      agent,
      signal,
    });
    const item = (answer?.answers || []).find((a) => a.id === "orbit-approve");
    return item?.selected?.length === 1 && item.selected[0] === "批准";
  } catch (cause) {
    if (cause instanceof UserQuestionError && cause.code === "ASK_CANCELLED") return false;
    throw cause;
  }
}

export { OrbitController, OrbitController as default };
