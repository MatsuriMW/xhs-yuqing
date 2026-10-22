// 舆情研判的 LangGraph 编排。业务代码（编码、指标、规则、评级）全部是 ../src 的原文件，经 n8n.mjs 跑；
// 这里只管 n8n 版做不到或做起来别扭的几件事：
//   1. 按人群画像选平台、分比重（router.mjs）；判断是事件还是日常，两种写法（modes.mjs）
//   2. 编码批次并行扇出（Send）
//   3. 规则检查没过就带着问题让模型返工，最多 maxRevisions 次（条件边绕回）
//   4. 出报告前停下等人复核（interrupt），复核意见写回「人工核实的背景」，打回就重写研判
//   5. 每一步存检查点（SqliteSaver），停在复核时进程可以退出，之后从断点接着跑
//   6. 用的人关心的：品牌配置放文件里、历次走势、分平台拆分、每次花多少 token、飞书推送（分「需要关注」和「日常简报」）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Annotation, StateGraph, Send, interrupt, START, END } from "@langchain/langgraph";
import { runCode } from "./n8n.mjs";
import { deepseek } from "./llm.mjs";
import { classifyAudience, planPlatforms, weightingNote } from "./router.mjs";
import { classifyMode, modeNote } from "./modes.mjs";
import { fetchBilibili } from "./sources/bilibili.mjs";
import { fetchZhihu } from "./sources/zhihu.mjs";
import { bilibiliBrowserGet } from "./sources/opencli.mjs";
import { buildCard, alertOf, sendFeishu } from "./notify.mjs";
import { fetchXhs, mcpCaller, replayCaller } from "./sources/xhs.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNFIXABLE = new Set(["R0", "R4b"]); // 采集不全重写也补不回来；ID 写短已自动补全

const last = (a, b) => (b === undefined ? a : b);
const State = Annotation.Root({
    opts: Annotation({ reducer: last, default: () => ({}) }),
    // n8n 各节点的输出，按节点名存；值为 null 表示用完丢掉（检查点不必一直带着全量记录）
    n: Annotation({ reducer: (a, b) => Object.fromEntries(Object.entries({ ...a, ...b }).filter(([, v]) => v !== null)), default: () => ({}) }),
    plan: Annotation({ reducer: last, default: () => null }),
    mode: Annotation({ reducer: last, default: () => null }),
    coding: Annotation({ reducer: (a, b) => (b === null ? [] : a.concat(b)), default: () => [] }),
    messages: Annotation({ reducer: last, default: () => [] }),   // 研判对话，返工时接着说
    feedback: Annotation({ reducer: last, default: () => null }), // 规则没过时给模型的修改意见
    revisions: Annotation({ reducer: last, default: () => 0 }),
    attempts: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
    reviews: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
    written: Annotation({ reducer: last, default: () => [] }),
    cost: Annotation({ reducer: last, default: () => null }),
    notified: Annotation({ reducer: last, default: () => null }),
});

const fixtureOf = (id) => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", `${id}.json`), "utf8"));
const plainItems = (arr) => arr.flat().map(({ json }) => ({ json }));
const platformName = (s) => (s.plan ? s.plan.platforms.filter((p) => p.status === "抓取").map((p) => p.name).join("、") || "B站" : "小红书");
const run = (s, file, args) => runCode(file, { ...args, platform: platformName(s) });

function withNotes(config, notes) {
    if (!notes.length) return config;
    const context_notes = [...new Set([...(config.context_notes || []), ...notes])];
    // 和 01_config.js 拼 CONTEXT_NOTES 的写法一致
    return { ...config, context_notes, prompt_vars: { ...config.prompt_vars, CONTEXT_NOTES: context_notes.map((x) => `- ${x}`).join("\n") } };
}
// 人工复核写回的背景，存在本次的输出目录里，同一目录下一次运行也会带上（重放和正式运行互不影响）
const notesFile = (s) => path.join(s.opts.outDir, "context_notes.json");
const savedNotes = (s) => (fs.existsSync(notesFile(s)) ? JSON.parse(fs.readFileSync(notesFile(s), "utf8")) : []);

// 品牌文件（--brand-file）：在 01_config.js 定义完 config、算提示词变量之前合并进去，提示词变量照常由 01 算。
// 顶层字段直接替换；industry、thresholds 这类对象只覆盖写了的键
export const injectBrand = (brand) => (js) => js.replace("const I = config.industry;", `for (const [k, v] of Object.entries(${JSON.stringify(brand)})) {
  config[k] = v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object' ? { ...config[k], ...v } : v;
}
const I = config.industry;`);

async function config(s) {
    if (s.opts.replay) return { n: { 配置: plainItems(fixtureOf(s.opts.replay)["配置"]) } }; // 重放用 n8n 当时的配置，不带后来写回的背景
    const brand = s.opts.brandFile ? JSON.parse(fs.readFileSync(s.opts.brandFile, "utf8")) : null;
    let items = await runCode("01_config.js", { input: [{ json: {} }], transform: brand ? injectBrand(brand) : undefined });
    // 每个品牌一个输出目录：增量状态、编码缓存、写回的背景、历次结果都按品牌分开
    const opts = { ...s.opts, outDir: s.opts.outDir || path.join(HERE, "data", "live", items[0].json.config.brand) };
    const notes = savedNotes({ opts });
    items = items.map(({ json }) => ({ json: { ...json, config: withNotes(json.config, notes) } }));
    return { opts, n: { 配置: items } };
}

async function route(s) {
    if (s.opts.replay) return { plan: null }; // 重放只有小红书一个平台，和 n8n 版一致，不做路由
    const { config: c } = s.n.配置[0].json;
    const audience = s.opts.audience || (await classifyAudience(c));
    return { plan: planPlatforms(audience, { live: s.opts.live }) };
}

async function fetchData(s) {
    const configItems = s.n.配置;
    const { config: c, run: r } = configItems[0].json;
    let parts;
    if (s.opts.replay) {
        parts = [await fetchXhs({ configItems, callTool: replayCaller(fixtureOf(s.opts.replay)).callTool })];
    } else {
        parts = [];
        for (const p of s.plan.platforms.filter((x) => x.status === "抓取")) {
            let got;
            // B站默认借 Chrome 的登录态（每页 20 条评论、带 IP 属地，评论翻到 comment_limit）；--bili-anon 走不登录的公开接口（每个视频 3 条热评）
            if (p.name === "B站") {
                got = await fetchBilibili(s.opts.biliAnon
                    ? { keywords: c.keywords, perKeyword: p.per_keyword }
                    : { keywords: c.keywords, perKeyword: p.per_keyword, commentPages: Math.ceil(c.comment_limit / 20), get: bilibiliBrowserGet() });
            } else if (p.name === "知乎") got = await fetchZhihu({ keywords: c.keywords, perKeyword: p.per_keyword, commentLimit: c.comment_limit });
            else if (p.name === "小红书") {
                const mcp = await mcpCaller();
                try { got = await fetchXhs({ configItems, callTool: mcp.callTool, perKeyword: p.per_keyword }); } finally { await mcp.close(); }
            }
            got.search_log = got.search_log.map((x) => ({ ...x, keyword: `${p.name}：${x.keyword}` }));
            parts.push(got);
        }
    }
    const cat = (k) => parts.flatMap((x) => x[k]);
    const structured = {
        run: r, config: c, notes: cat("notes"), records: cat("records"), fetch_errors: cat("fetch_errors"), search_log: cat("search_log"),
        official: parts[0]?.official || { configured: [], seen_in_search: [] },
    };
    return { n: { 结构化: [{ json: structured }] } };
}

async function diff(s) {
    let binary = null;
    if (s.opts.replay) binary = Buffer.from(JSON.stringify(fixtureOf(s.opts.replay)["增量对比"][0][0].json.state));
    else if (fs.existsSync(path.join(s.opts.outDir, "state.json"))) binary = fs.readFileSync(path.join(s.opts.outDir, "state.json"));
    return { n: { 增量对比: await run(s, "04_diff_state.js", { nodes: { 结构化: s.n.结构化 }, binary }) } };
}

async function batches(s) {
    const d = s.n.增量对比[0].json;
    return { n: { 切批: d.has_new ? await run(s, "05_coding_batches.js", { input: s.n.增量对比 }) : [] }, coding: null };
}
const fanOut = (s) => (s.n.切批.length ? s.n.切批.map(({ json }, i) => new Send("code_batch", { ...s, batch: { i, body: json.body } })) : "merge");

async function codeBatch(s) {
    const { i, body } = s.batch;
    // 重放：用 n8n 当时这一批的编码结果（05 是确定性的，第 i 批就是当时的第 i 批）
    const json = s.opts.replay ? fixtureOf(s.opts.replay)["编码 DeepSeek"].flat()[i].json : await deepseek(body);
    return { coding: [{ i, json }] };
}

const tokens = (resps) => resps.reduce((n, j) => n + (j?.usage?.total_tokens || 0), 0);

async function merge(s) {
    const responses = [...s.coding].sort((a, b) => a.i - b.i).map(({ json }) => ({ json }));
    const merged = await run(s, "06_merge_coding.js", { input: responses, nodes: { 增量对比: s.n.增量对比, "编码 DeepSeek": responses } });
    return { n: { 合并编码: merged, 结构化: null, 增量对比: null, 切批: null }, coding: null, cost: { coding: tokens(s.coding.map((x) => x.json)) } };
}

async function aggregate(s) {
    const [{ json }] = await run(s, "07_aggregate.js", { input: s.n.合并编码 });
    if (s.plan) {
        // 07 里平台写死成单平台；按实际抓到的平台和比重改写
        // 分平台拆开：总条数、窗口内指向本机构的条数和其中负面占比，跨平台扩散有数可依
        const W = Date.parse(json.metrics.run.run_at) - 24 * 3600e3 * (json.config.window_days || 1);
        const counts = {};
        for (const r of json.records) {
            const c = (counts[r.platform] ||= { notes: 0, records: 0, relevant_in_window: 0, negative_in_window: 0 });
            c.records++;
            if (r.kind === "笔记") c.notes++;
            if (r.code?.target === "本机构" && r.time && Date.parse(r.time) >= W) {
                c.relevant_in_window++;
                if (r.code.sentiment === "负面") c.negative_in_window++;
            }
        }
        for (const c of Object.values(counts)) c.negative_pct = c.relevant_in_window ? Math.round((c.negative_in_window / c.relevant_in_window) * 100) : null;
        const covered = Object.keys(counts);
        json.metrics.run.platforms = covered;
        json.metrics.spread.platforms_covered = covered;
        json.metrics.spread.cross_platform = covered.length > 1
            ? `已覆盖 ${covered.map((p) => `${p} ${counts[p].records} 条`).join("、")}；未覆盖：${s.plan.platforms.filter((p) => !counts[p.name]).map((p) => p.name).join("、") || "无"}`
            : `只覆盖了 ${covered[0] || "（无）"}；${s.plan.platforms.filter((p) => !counts[p.name]).map((p) => `${p.name}${p.status === "抓取" ? "没抓到数据" : p.status}`).join("、")}`;
        json.metrics.platform_plan = { ...s.plan, counts };
    }
    if (!s.opts.replay) {
        // 历次走势：同一品牌目录下之前几次运行的摘要（10_finalize 写的 _summary.json），研判和推送都用
        const runs = path.join(s.opts.outDir, "runs");
        json.metrics.history = fs.existsSync(runs)
            ? fs.readdirSync(runs).filter((f) => f.endsWith("_summary.json")).sort().slice(-8)
                .map((f) => JSON.parse(fs.readFileSync(path.join(runs, f), "utf8")))
                .map((h) => ({ run_at: h.run_at, grade: h.grade, level: h.level, stage: h.stage, negative_pct: h.negative_pct, relevant_records: h.relevant_records }))
            : [];
    }
    return { n: { 聚合研判指标: [{ json }], 合并编码: null } };
}

// 事件还是日常：命令行指定了就用指定的；重放默认不判断（保持和 n8n 一致），其余让模型看指标摘要判断
async function judgeMode(s) {
    if (s.opts.mode) return { mode: { ...s.opts.mode, evidence: s.opts.mode.evidence || ["命令行指定"], confidence: "高" } };
    if (s.opts.replay) return { mode: null };
    return { mode: await classifyMode(s.n.聚合研判指标[0].json) };
}

async function writeReport(s) {
    // 请求体每次都由 08 重新拼（复核写回背景后提示词会变），返工时在它后面接上「上一稿 + 修改意见」
    const [{ json: req }] = await run(s, "08_report_request.js", { input: s.n.聚合研判指标 });
    let messages = req.body.messages;
    if (s.plan) {
        const counts = s.n.聚合研判指标[0].json.metrics.platform_plan.counts;
        messages = [messages[0], { role: "system", content: weightingNote(s.plan, counts) }, ...messages.slice(1)];
    }
    if (s.mode) messages = [messages[0], { role: "system", content: modeNote(s.mode) }, ...messages.slice(1)];
    if (s.feedback && s.messages.length) {
        const prev = s.n["研判 DeepSeek"][0].json.choices?.[0]?.message?.content || "";
        messages = [...s.messages, { role: "assistant", content: prev }, { role: "user", content: s.feedback }];
    }
    const resp = await deepseek({ ...req.body, messages });
    return { messages, n: { "研判 DeepSeek": [{ json: resp }] } };
}

async function ruleCheck(s) {
    const out = await run(s, "09_rule_check.js", { input: s.n["研判 DeepSeek"], nodes: { 聚合研判指标: s.n.聚合研判指标 } });
    const checks = out[0].json.rule_checks;
    const failed = checks.filter((c) => !c.pass);
    const fixable = failed.filter((c) => !UNFIXABLE.has(c.id));
    const resp = s.n["研判 DeepSeek"][0].json;
    const attempt = {
        n: s.attempts.length + 1, kind: s.feedback ? "返工" : s.reviews.length ? "复核后重写" : "首稿",
        failed: failed.map((c) => c.id), parse_error: out[0].json.report_parse_error || "", ms: resp._ms ?? null, usage: resp.usage || null,
    };
    const retry = fixable.length > 0 && s.revisions < (s.opts.maxRevisions ?? 2);
    const feedback = retry
        ? `规则检查没通过，请逐条修正后重新输出完整的 JSON（结构和字段不变，其余内容尽量保留）：\n${fixable.map((c) => `- ${c.id} ${c.name}：${c.detail}`).join("\n")}`
        : null;
    return { n: { 规则检查: out }, attempts: [attempt], feedback, revisions: retry ? s.revisions + 1 : s.revisions };
}
const afterRules = (s) => (s.feedback ? "write_report" : "judge");

async function judge(s) {
    const rc = s.n.规则检查[0].json;
    const json = rc.skip_judge ? { error: { message: "研判没生成，跳过评测" } } : await deepseek(rc.body);
    return { n: { "评测 DeepSeek Pro": [{ json }] } };
}

async function finalize(s) {
    const out = await run(s, "10_finalize.js", { input: s.n["评测 DeepSeek Pro"], nodes: { 聚合研判指标: s.n.聚合研判指标, 规则检查: s.n.规则检查 } });
    // 每次花多少：编码 + 每一稿研判 + 评测（画像和模式判断两次小调用没算）
    const report = s.attempts.reduce((n, a) => n + (a.usage?.total_tokens || 0), 0);
    const judgeTokens = tokens([s.n["评测 DeepSeek Pro"][0].json]);
    const coding = s.cost?.coding || 0;
    return { n: { 评级与报告: out }, cost: { coding, report, judge: judgeTokens, total: coding + report + judgeTokens } };
}

// 飞书推送：先写卡片预览；配了 Webhook 才发。--notify alert 只在「需要关注」时发，off 不发
async function notify(s) {
    const files = s.n.评级与报告.map((x) => x.json);
    const runRecord = JSON.parse(files.find((f) => f.kind === "run").text);
    runRecord.metrics = s.n.聚合研判指标[0].json.metrics; // 带上 history、platform_plan（10 写 run.json 时已包含，这里保险）
    const reportPath = path.join(s.opts.outDir, files.find((f) => f.kind === "report").path);
    const card = buildCard({ run: runRecord, mode: s.mode, cost: s.cost, reportPath, reviewCommand: s.opts.review ? s.opts.reviewCommand : null });
    fs.mkdirSync(s.opts.outDir, { recursive: true });
    fs.writeFileSync(path.join(s.opts.outDir, "feishu-preview.json"), JSON.stringify(card, null, 2));
    const policy = s.opts.notify || "always";
    const { alert } = alertOf(runRecord, s.mode);
    if (s.opts.replay || policy === "off" || (policy === "alert" && !alert)) return { notified: { status: "按设置不发", alert } };
    return { notified: { ...(await sendFeishu(card)), alert } };
}

// 人工复核：停下来，把评级和报告交给人。恢复时传 { action: "approve" } 或 { action: "revise", notes: ["核实过的背景", ...] }
function review(s) {
    if (!s.opts.review) return { reviews: [{ action: "skip" }] };
    const files = s.n.评级与报告.map((x) => x.json);
    const run = JSON.parse(files.find((f) => f.kind === "run").text);
    const decision = interrupt({
        grade: run.evaluation.grade, score: run.evaluation.score, level: run.report?.level?.verdict,
        failed_rules: run.evaluation.rule_checks.filter((c) => !c.pass).map((c) => `${c.id} ${c.name}`),
        issues: run.evaluation.issues, report_md: files.find((f) => f.kind === "report").text,
    });
    if (decision?.action !== "revise" || !decision.notes?.length) return { reviews: [{ action: "approve" }] };
    // 写回：存进 context_notes.json（下一次运行也带上），本次改配置后重写研判
    fs.mkdirSync(s.opts.outDir, { recursive: true });
    fs.writeFileSync(notesFile(s), JSON.stringify([...new Set([...savedNotes(s), ...decision.notes])], null, 2));
    const [{ json }] = s.n.聚合研判指标;
    return {
        reviews: [{ action: "revise", notes: decision.notes }],
        n: { 聚合研判指标: [{ json: { ...json, config: withNotes(json.config, decision.notes) } }] },
        messages: [], feedback: null, revisions: 0,
    };
}
const afterReview = (s) => (s.reviews.at(-1).action === "revise" ? "write_report" : "write");

async function write(s) {
    const dir = s.opts.outDir;
    const written = [];
    let runDir = "";
    for (const { json: f } of s.n.评级与报告) {
        const p = path.join(dir, f.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f.text);
        written.push(p);
        if (f.kind === "run") runDir = f.path.replace(/_run\.json$/, "");
    }
    // 编排层的记录：路由结果、每一稿的规则结果和用时、复核动作。n8n 版没有这一份
    const trace = path.join(dir, `${runDir}_graph.json`);
    fs.writeFileSync(trace, JSON.stringify({ opts: { ...s.opts, outDir: undefined }, plan: s.plan, mode: s.mode, cost: s.cost, notified: s.notified, attempts: s.attempts, reviews: s.reviews }, null, 2));
    written.push(trace);
    return { written };
}

export function buildGraph() {
    return new StateGraph(State)
        .addNode("config", config)
        .addNode("route", route)
        .addNode("fetch", fetchData)
        .addNode("diff", diff)
        .addNode("batches", batches)
        .addNode("code_batch", codeBatch)
        .addNode("merge", merge)
        .addNode("aggregate", aggregate)
        .addNode("judge_mode", judgeMode)
        .addNode("write_report", writeReport)
        .addNode("rule_check", ruleCheck)
        .addNode("judge", judge)
        .addNode("finalize", finalize)
        .addNode("notify", notify)
        .addNode("review", review)
        .addNode("write", write)
        .addEdge(START, "config")
        .addEdge("config", "route")
        .addEdge("route", "fetch")
        .addEdge("fetch", "diff")
        .addEdge("diff", "batches")
        .addConditionalEdges("batches", fanOut, ["code_batch", "merge"])
        .addEdge("code_batch", "merge")
        .addEdge("merge", "aggregate")
        .addEdge("aggregate", "judge_mode")
        .addEdge("judge_mode", "write_report")
        .addEdge("write_report", "rule_check")
        .addConditionalEdges("rule_check", afterRules, ["write_report", "judge"])
        .addEdge("judge", "finalize")
        .addEdge("finalize", "notify")
        .addEdge("notify", "review")
        .addConditionalEdges("review", afterReview, ["write_report", "write"])
        .addEdge("write", END);
}
