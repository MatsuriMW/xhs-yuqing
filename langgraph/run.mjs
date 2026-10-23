// 用法：
//   node run.mjs                              按人群画像路由；默认真抓 B站 和 知乎（借 Chrome 的登录态）；出报告前停下等复核
//   node run.mjs --live B站,小红书            指定这次真抓哪些平台（小红书先走 AgentKey，积分不够换 MediaCrawler）
//   node run.mjs --audience 女性为主,高学历    不让模型判断画像，直接指定（性别：女性为主 | 中性 | 男性为主）
//   node run.mjs --mode 事件 --event "某某事"   不让模型判断模式，直接指定（事件 | 日常）
//   node run.mjs --bili-anon                  B站不借登录态，走公开接口（每个视频只有 3 条热评）
//   node run.mjs --brand-file brands/小米汽车.json   换品牌（品牌、关键词、本机构规则、行业设定都写在文件里）
//   node run.mjs --notify alert               飞书只在「需要关注」时推（默认 always：每次都推，红绿区分；off：不推）
//   node run.mjs --replay 61                  重放 n8n 第 61 次运行的小红书数据（需要 fixtures/61.json），只调 DeepSeek
//   node run.mjs --max-revisions 0            关掉返工循环（等于 n8n 版的一次成稿）
//   node run.mjs --no-review                  不停下复核，直接写文件
//   node run.mjs resume <线程> --approve      复核通过，写报告
//   node run.mjs resume <线程> --note "核实过的背景" [--note ...]   写回背景并重写研判
import fs from "node:fs";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildGraph, HERE } from "./graph.mjs";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const val = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const vals = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));

fs.mkdirSync(path.join(HERE, "data"), { recursive: true });
const saver = SqliteSaver.fromConnString(path.join(HERE, "data", "checkpoints.sqlite"));
const graph = buildGraph().compile({ checkpointer: saver });

let thread, input;
if (argv[0] === "resume") {
    thread = argv[1];
    input = new Command({ resume: flag("--approve") ? { action: "approve" } : { action: "revise", notes: vals("--note") } });
} else {
    const replay = val("--replay");
    const maxRevisions = Number(val("--max-revisions") ?? 2);
    const label = replay ? `replay-${replay}-r${maxRevisions}` : "live";
    thread = `${label}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const aud = val("--audience")?.split(",");
    input = {
        opts: {
            replay, maxRevisions, review: !flag("--no-review"),
            live: (val("--live") || "B站,知乎").split(","),
            biliAnon: flag("--bili-anon"),
            mode: val("--mode") ? { mode: val("--mode"), event: val("--event") || null } : undefined,
            audience: aud ? { gender: aud[0], highly_educated: aud.includes("高学历"), reason: "命令行指定" } : undefined,
            outDir: replay ? path.join(HERE, "data", thread) : undefined, // 正式运行按品牌放 data/live/<品牌>/，在图里定
            brandFile: val("--brand-file") ? path.resolve(val("--brand-file")) : undefined,
            notify: val("--notify") || "always",
            reviewCommand: `node run.mjs resume ${thread} --approve`,
        },
    };
}

const cfg = { configurable: { thread_id: thread } };
const t0 = Date.now();
const out = await graph.invoke(input, cfg);
const s = (await graph.getState(cfg)).values;
const secs = Math.round((Date.now() - t0) / 1000);

if (s.plan) console.log(`路由：${s.plan.audience.gender}，${s.plan.audience.highly_educated ? "本科及以上为主" : "学历不限"} → 主平台 ${s.plan.primary}${s.plan.acting_primary !== s.plan.primary ? `（本次由 ${s.plan.acting_primary} 代替）` : ""}；${s.plan.platforms.map((p) => `${p.name} 比重 ${Math.round(p.weight * 100)}% ${p.status}${p.status === "抓取" ? `（每词 ${p.per_keyword} 个）` : ""}`).join("，")}`);
if (s.mode) console.log(`模式：${s.mode.mode}${s.mode.event ? `（${s.mode.event}）` : ""}，置信度 ${s.mode.confidence}`);
for (const a of s.attempts) console.log(`研判第 ${a.n} 稿（${a.kind}）：${a.failed.length ? `没过 ${a.failed.join(" ")}` : "规则全过"}${a.ms ? `，${Math.round(a.ms / 1000)} 秒` : ""}`);
if (s.cost) console.log(`用量：${s.cost.total} tokens（编码 ${s.cost.coding}，研判 ${s.cost.report}，评测 ${s.cost.judge}）`);
if (s.notified) console.log(`飞书：${s.notified.alert ? "需要关注" : "日常简报"}，${s.notified.status}${s.notified.hint ? `（${s.notified.hint}）` : ""}；卡片预览 ${path.join(s.opts.outDir, "feishu-preview.json")}`);

const pending = out.__interrupt__?.[0]?.value;
if (pending) {
    const preview = path.join(s.opts.outDir, `待复核-${thread}.md`);
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, pending.report_md);
    console.log(`\n停在人工复核（${secs} 秒）：${pending.grade} 级 ${pending.score} 分，分档「${pending.level}」${pending.failed_rules.length ? `，没过的规则：${pending.failed_rules.join("；")}` : ""}`);
    console.log(`报告预览：${preview}`);
    console.log(`通过：node run.mjs resume ${thread} --approve`);
    console.log(`打回：node run.mjs resume ${thread} --note "人工核实过的背景"`);
} else {
    console.log(`\n完成（${secs} 秒），写入：\n${s.written.join("\n")}`);
    // 跑完的线程不会再恢复；每步检查点都带着全量记录，留着会把库撑大
    await saver.deleteThread(thread);
    saver.db.exec("VACUUM"); // SQLite 删了数据不会自己缩小
}
