// 汇总同一份小红书数据（n8n 第 61 次运行）的几种跑法：n8n 当时的结果、LangGraph 关掉返工、开着返工。
// 用法：node tools/compare.mjs   → 打印 Markdown 表；demo-page.mjs 也用 compareRows()
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HERE } from "../graph.mjs";

const N8N_RUN = path.join(HERE, "..", "data", "runs", "2026-10-17_0804_run.json");

function row(name, run, graph) {
    const ev = run.evaluation;
    const attempts = graph?.attempts || [{ failed: ev.rule_checks.filter((c) => !c.pass).map((c) => c.id) }];
    return {
        name,
        drafts: attempts.map((a) => (a.failed.length ? a.failed.join(" ") : "全过")).join(" → "),
        final_failed: ev.rule_checks.filter((c) => !c.pass).map((c) => c.id).join(" ") || "无",
        grade: `${ev.grade} / ${ev.score}`,
        level: run.report?.level?.verdict || "（没生成）",
        secs: graph ? Math.round(attempts.reduce((s, a) => s + (a.ms || 0), 0) / 1000) : "—",
    };
}

export function compareRows() {
    const rows = [];
    if (fs.existsSync(N8N_RUN)) rows.push(row("n8n（当时）", JSON.parse(fs.readFileSync(N8N_RUN, "utf8")), null));
    for (const d of fs.readdirSync(path.join(HERE, "data")).filter((x) => x.startsWith("replay-")).sort()) {
        const runs = path.join(HERE, "data", d, "runs");
        if (!fs.existsSync(runs)) continue;
        const f = fs.readdirSync(runs);
        const run = f.find((x) => x.endsWith("_run.json"));
        const graph = f.find((x) => x.endsWith("_graph.json"));
        if (!run || !graph) continue;
        const g = JSON.parse(fs.readFileSync(path.join(runs, graph), "utf8"));
        rows.push(row(`LangGraph 返工上限 ${g.opts.maxRevisions}`, JSON.parse(fs.readFileSync(path.join(runs, run), "utf8")), g));
    }
    return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log("| 跑法 | 各稿没过的规则 | 最终没过 | 评级 / 分 | 分档 | 研判用时（秒） |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const r of compareRows()) console.log(`| ${r.name} | ${r.drafts} | ${r.final_failed} | ${r.grade} | ${r.level} | ${r.secs} |`);
}
