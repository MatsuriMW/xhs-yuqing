// 把一个品牌目录里最新的一次运行做成博客 demo 页：index.html（概览）+ report/index.html（完整报告）。
// 用法：node tools/demo-page.mjs data/live/特斯拉 ~/Dropbox/HEXO/myblog/source/demo/yuqing-langgraph
// 样式沿用上一版小红书 demo（/demo/xhs-yuqing/）的配色和版式，两页互相链接。
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { compareRows } from "./compare.mjs";

const [brandDir, outDir] = process.argv.slice(2);
if (!brandDir || !outDir) throw new Error("用法：node tools/demo-page.mjs <品牌输出目录> <页面输出目录>");
const runsDir = path.join(brandDir, "runs");
const id = fs.readdirSync(runsDir).filter((f) => f.endsWith("_graph.json")).sort().at(-1).replace(/_graph\.json$/, "");
const read = (f) => fs.readFileSync(path.join(runsDir, `${id}${f}`), "utf8");
const run = JSON.parse(read("_run.json"));
const g = JSON.parse(read("_graph.json"));
const md = read("_研判报告.md");
const card = JSON.parse(fs.readFileSync(path.join(brandDir, "feishu-preview.json"), "utf8"));

const { config: c, metrics: m, report: R, evaluation: ev } = run;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
// 去掉报告里的引用记号（概览页只摘结论，出处在完整报告里）
const plain = (s) => esc(String(s || "").replace(/\s*\[r:[^\]]*\]/g, "").replace(/（\[c_[^)]*\)(、\[c_[^)]*\))*）/g, "").replace(/\s+/g, " ").trim());
const pct = (x) => (x == null ? "—" : `${x}%`);
const plan = m.platform_plan;
const counts = plan?.counts || {};
const maxRel = Math.max(1, ...Object.values(counts).map((x) => x.relevant_in_window));
const date = run.run.run_at_local;
const UNIT = { B站: "个视频", 知乎: "个回答", 小红书: "篇笔记" };

const flow = [
    ["选平台", "LangChain 判断人群画像 → 规则表定比重", `${esc(plan.audience.gender)}、${plan.audience.highly_educated ? "本科及以上为主" : "学历不限"} → 主平台 <b>${esc(plan.primary)}</b>${plan.acting_primary !== plan.primary ? `（本次由 ${esc(plan.acting_primary)} 代替）` : ""}`,
        plan.platforms.map((p) => `${esc(p.name)} ${Math.round(p.weight * 100)}%，${p.status === "抓取" ? `每词 ${p.per_keyword} ${UNIT[p.name]}` : esc(p.status)}`)],
    ["判模式", "LangChain 看指标摘要判断事件 / 日常", g.mode ? `<b>${esc(g.mode.mode)}模式</b>${g.mode.event ? `：${esc(g.mode.event)}` : ""}（置信度 ${esc(g.mode.confidence)}）` : "未判断", (g.mode?.evidence || []).map(esc)],
    ["写研判、过规则", "19 条代码规则没过就带着问题返工，最多 2 次", g.attempts.map((a) => `第 ${a.n} 稿 ${a.failed.length ? `没过 ${a.failed.join(" ")}` : "规则全过"}`).join(" → "),
        g.attempts.map((a) => `${a.kind}，${a.ms ? Math.round(a.ms / 1000) + " 秒" : "—"}${a.usage ? `，${Math.round(a.usage.total_tokens / 1000)}k tokens` : ""}`)],
    ["人工复核", "出报告前停下（interrupt），进程可以退出，之后从检查点接着跑", g.reviews.map((r) => (r.action === "approve" ? "通过" : r.action === "revise" ? "打回重写" : "未设复核")).join(" → ") || "—",
        g.reviews.flatMap((r) => r.notes || []).map((x) => `写回背景：${esc(x)}`)],
    ["推送", "按飞书卡片格式生成通知（未接真实群）", g.notified ? `${g.notified.alert ? "需要关注" : "日常简报"}（只生成预览）` : "—", [`用量 ${g.cost ? Math.round(g.cost.total / 1000) + "k tokens" : "—"}`]],
];

const diffRows = [
    ["平台", "只抓小红书", "按人群画像选主平台、分比重：小红书 / B站 / 知乎"],
    ["研判模式", "一种写法", "先判断事件还是日常，两种写法"],
    ["规则没过", "扣分、封顶评级", "带着没过的规则返工，最多 2 次"],
    ["人工复核", "事后改配置，下一轮生效", "出报告前停下；打回时写回背景、当场重写"],
    ["中断", "从头跑", "每步存检查点，停在复核时可以退出、之后接着跑"],
    ["走势", "只比前一窗口", "带上同一品牌之前几次运行的摘要"],
    ["通知", "无", "生成飞书格式的卡片（还没接群），按规则表分「需要关注」和「日常简报」"],
    ["业务代码", "src/ 里的 Code 节点", "同一份文件原样复用，同一份数据逐字段对拍一致"],
];

const cardHtml = (() => {
    const head = { ...card.card.header, title: { ...card.card.header.title, content: card.card.header.title.content.replace("（待复核）", "") } };
    const body = card.card.elements[0].text.content;
    const foot = card.card.elements[2].elements[0].content.replace(/\n复核：.*$/s, ""); // 复核命令是本机用的，公开页不放
    const lark = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    return `<div class="fs"><div class="fs-h ${head.template}">${esc(head.title.content)}</div><div class="fs-b">${lark(body)}</div><div class="fs-f">${lark(foot.replace(/报告：\S+/, "报告：完整报告链接"))}</div></div>`;
})();

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>多平台舆情研判 Demo</title>
<meta name="description" content="舆情研判工作流的 LangGraph 版：按人群画像选平台（B站 / 知乎 / 小红书）、判断事件还是日常、规则没过自动返工、出报告前停下等人工复核、飞书推送。示例：${esc(c.brand)}，${esc(date)}。">
<style>
  :root { color-scheme: light; --page: #f6f5f1; --surface: #fcfcfb; --ink: #1f1f1d; --ink-2: #55544f; --ink-3: #8a8984; --rule: #e6e4de; --blue: #2a78d6; --blue-soft: #dbe8f8; --red: #e34948; --red-soft: #f8dedc; --green: #2f8f5b; --violet: #4a3aa7; --neutral-soft: #ecebe6; --accent-bg: #f1f5fb; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.7 -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 48px 24px 80px; }
  .eyebrow { font-size: 13px; letter-spacing: .08em; color: var(--ink-3); }
  h1 { font-size: 34px; line-height: 1.3; margin: 8px 0 12px; }
  h2 { font-size: 22px; margin: 0 0 6px; }
  h3 { font-size: 15px; margin: 0 0 10px; font-weight: 600; color: var(--ink-2); }
  p { margin: 0 0 12px; }
  a { color: var(--blue); }
  .lede { font-size: 17px; color: var(--ink-2); max-width: 760px; }
  .note { font-size: 13px; color: var(--ink-3); }
  .toplinks { font-size: 14px; margin-top: 12px; display: flex; gap: 18px; flex-wrap: wrap; }
  section { margin-top: 56px; }
  .sec-head { margin-bottom: 20px; max-width: 760px; }
  .sec-head p { color: var(--ink-2); }
  .card { background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 20px 22px; }
  .grid { display: grid; gap: 16px; }
  .grid > * { min-width: 0; }
  .g4 { grid-template-columns: repeat(4, 1fr); }
  .g2 { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 860px) { .g4 { grid-template-columns: repeat(2, 1fr); } .g2 { grid-template-columns: 1fr; } }
  @media (max-width: 520px) { .wrap { padding: 32px 16px 64px; } h1 { font-size: 27px; } }
  .stat .label { font-size: 13px; color: var(--ink-2); }
  .stat .value { font-size: 22px; font-weight: 700; line-height: 1.35; margin-top: 4px; }
  .stat .sub { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
  .flow { display: grid; gap: 10px; }
  .step { display: grid; grid-template-columns: 220px 1fr; gap: 4px 24px; }
  @media (max-width: 640px) { .step { grid-template-columns: 1fr; } }
  .step .n { font-size: 12px; color: var(--blue); font-weight: 700; letter-spacing: .06em; }
  .step .t { font-weight: 700; margin: 2px 0 2px; }
  .step .how { font-size: 12px; color: var(--ink-3); margin-bottom: 8px; }
  .step .res { font-size: 14px; margin-bottom: 6px; }
  .step .res b { color: var(--violet); }
  .step ul { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); }
  .hbars { display: grid; gap: 10px; }
  .hbar { display: grid; grid-template-columns: 4.5em 1fr 9em; align-items: center; gap: 10px; font-size: 13px; }
  .hbar .name { color: var(--ink-2); text-align: right; }
  .hbar .track { height: 14px; }
  .hbar .fill { height: 100%; border-radius: 0 4px 4px 0; background: var(--blue); min-width: 2px; }
  .hbar .num { font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid var(--rule); padding: 8px 10px; text-align: left; vertical-align: top; }
  th { color: var(--ink-3); font-weight: 500; font-size: 12px; }
  .table-scroll { overflow-x: auto; }
  td.old { color: var(--ink-3); }
  tr.now td { font-weight: 600; }
  .verdict .k { font-size: 13px; color: var(--ink-2); }
  .verdict .v { font-size: 20px; font-weight: 700; margin: 4px 0 6px; }
  .verdict .why { font-size: 14px; color: var(--ink-2); }
  ul.plain { margin: 0; padding-left: 18px; font-size: 14px; color: var(--ink-2); }
  .fs { max-width: 520px; background: #fff; border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; font-size: 14px; line-height: 1.65; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .fs-h { padding: 10px 14px; color: #fff; font-weight: 600; }
  .fs-h.red { background: #d83931; } .fs-h.green { background: #2ea121; }
  .fs-b { padding: 12px 14px; }
  .fs-f { padding: 8px 14px 12px; font-size: 12px; color: var(--ink-3); border-top: 1px solid var(--rule); }
  .score { display: grid; grid-template-columns: 7em 1fr 3.4em; gap: 10px; align-items: center; font-size: 13px; margin-bottom: 8px; }
  .score .track { height: 10px; background: var(--neutral-soft); border-radius: 99px; overflow: hidden; }
  .score .fill { height: 100%; background: var(--blue); border-radius: 99px; }
  .score .name { color: var(--ink-2); text-align: right; }
  footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--rule); font-size: 13px; color: var(--ink-3); }
  footer p { margin-bottom: 6px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="eyebrow">舆情研判 · LangGraph 多平台版 · ${esc(date)}</div>
  <h1>${esc(c.brand)}：B站 + 知乎的舆情研判</h1>
  <p class="lede">上一版是 n8n 定时抓小红书。这一版把编排换成 LangGraph：先按品牌人群画像决定以哪个平台为主，再判断现在是「出了事」还是「日常」，规则检查没过就让模型带着问题返工，出报告前停下来等人复核，最后生成一条推送卡片。编码、指标、规则、评级还是同一份代码。</p>
  <div class="toplinks"><a href="/demo/xhs-yuqing/">← 上一版：小红书 · n8n · 人工复核纠错</a><a href="report/">完整研判报告 →</a><a href="https://github.com/MatsuriMW/xhs-yuqing">源码（GitHub）</a></div>
</header>

<section>
  <div class="grid g4">
    <div class="card stat"><div class="label">分档</div><div class="value">${esc(R?.level?.verdict)}</div><div class="sub">四档之一，按证据定</div></div>
    <div class="card stat"><div class="label">走势阶段</div><div class="value">${esc(R?.trend?.stage)}</div><div class="sub">快照 ${m.run.snapshots} 次</div></div>
    <div class="card stat"><div class="label">风险量级</div><div class="value">传播${esc(m.levels.spread)} · 情绪${esc(m.levels.emotion)} · 内容${esc(m.levels.content)}</div><div class="sub">三维度各自分级，取最高</div></div>
    <div class="card stat"><div class="label">自动评测</div><div class="value">${esc(ev.grade)} 级 · ${ev.score} 分</div><div class="sub">规则 ${ev.rule_checks.filter((x) => x.pass).length}/${ev.rule_checks.length} 通过</div></div>
  </div>
</section>

<section>
  <div class="sec-head"><h2>这一轮流程里发生了什么</h2><p>五个环节都是这次真实运行的记录（来自运行留下的 <code>_graph.json</code>）。</p></div>
  <div class="flow">
${flow.map(([t, how, res, items], i) => `    <div class="card step"><div><div class="n">0${i + 1}</div><div class="t">${t}</div><div class="how">${how}</div></div><div><div class="res">${res}</div>${items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>` : ""}</div></div>`).join("\n")}
  </div>
</section>

<section>
  <div class="sec-head"><h2>两个平台各说了什么</h2><p>窗口（过去 ${esc(m.window)}）内指向${esc(c.brand)}的记录数和其中负面占比，按平台拆开。比重决定每个平台抓多少，研判时以主平台为准，其他平台用来判断是否跨平台扩散。</p></div>
  <div class="card">
    <div class="hbars">
${Object.entries(counts).map(([p, x]) => `      <div class="hbar"><div class="name">${esc(p)}</div><div class="track"><div class="fill" style="width:${(x.relevant_in_window / maxRel) * 100}%"></div></div><div class="num">${x.relevant_in_window} 条 · 负面 ${pct(x.negative_pct)}</div></div>`).join("\n")}
    </div>
    <p class="note" style="margin-top:12px">总样本：${Object.entries(counts).map(([p, x]) => `${esc(p)} ${x.notes} ${UNIT[p]} / ${x.records} 条记录`).join("；")}。B站借登录态抓评论（每页 20 条、带 IP 属地）；知乎回答当「笔记」，评论不带属地。</p>
  </div>
</section>

<section>
  <div class="sec-head"><h2>研判结论</h2><p>完整报告每句都挂着原话出处，这里只摘结论。</p></div>
  <div class="grid g2">
    <div class="card verdict"><div class="k">是否形成舆情</div><div class="v">${esc(R?.level?.verdict)}</div><div class="why">${plain(R?.level?.reason)}</div></div>
    <div class="card verdict"><div class="k">对业务的参考 · 下一步</div><div class="v">${plain(R?.business?.next_step)}</div><div class="why">${plain(R?.business?.next_step_reason)}</div></div>
    <div class="card"><h3>升级信号</h3><ul class="plain">${(R?.trend?.escalate_if || []).map((x) => `<li>${plain(x)}</li>`).join("")}</ul></div>
    <div class="card"><h3>降温信号</h3><ul class="plain">${(R?.trend?.cool_if || []).map((x) => `<li>${plain(x)}</li>`).join("")}</ul></div>
  </div>
</section>

<section>
  <div class="sec-head"><h2>历次运行</h2><p>同一品牌目录下之前几次运行的摘要会交给研判模型，走势不再只看一张快照。</p></div>
  <div class="card table-scroll"><table>
    <tr><th>时间（北京）</th><th>分档</th><th>阶段</th><th>负面占比</th><th>相关记录</th><th>评测</th></tr>
${(m.history || []).map((h) => `    <tr><td>${esc(new Date(Date.parse(h.run_at) + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " "))}</td><td>${esc(h.level)}</td><td>${esc(h.stage)}</td><td>${pct(h.negative_pct)}</td><td>${h.relevant_records ?? "—"}</td><td>${esc(h.grade)}</td></tr>`).join("\n")}
    <tr class="now"><td>本次</td><td>${esc(R?.level?.verdict)}</td><td>${esc(R?.trend?.stage)}</td><td>${pct(m.emotion.negative_pct)}</td><td>${m.emotion.n_records}</td><td>${esc(ev.grade)}</td></tr>
  </table></div>
</section>

<section>
  <div class="sec-head"><h2>推送卡片（预览）</h2><p>工作流会按飞书群机器人的卡片格式生成一条通知，这里是本次生成的预览；还没接真实的群。卡片先写结论，再「为什么提醒」、数字、平台、下一步、自查、历次。「需要关注」由规则表定：分档到舆情前夜以上、事件模式、高敏比前一窗口多、分档比上次高，任一条成立。</p></div>
  ${cardHtml}
</section>

<section>
  <div class="sec-head"><h2>和 n8n 版比</h2><p>业务代码同一份：用 n8n 那次小红书运行（10-17 08:04）每一步的真实输入在 LangGraph 里重跑，输出逐字段一致，指标完全相同。不同的只在编排，以及模型每次写得不一样。</p></div>
  <div class="card table-scroll"><table>
    <tr><th></th><th>n8n 版</th><th>LangGraph 版</th></tr>
${diffRows.map(([k, a, b]) => `    <tr><td>${k}</td><td class="old">${a}</td><td>${b}</td></tr>`).join("\n")}
  </table></div>
  <div class="card table-scroll" style="margin-top:16px">
    <h3>同一份小红书数据重放 ${compareRows().length} 次</h3>
    <table><tr><th>跑法</th><th>各稿没过的规则</th><th>评级 / 分</th><th>分档</th></tr>
${compareRows().map((r) => `    <tr><td>${esc(r.name)}</td><td>${esc(r.drafts)}</td><td>${esc(r.grade)}</td><td>${esc(r.level)}</td></tr>`).join("\n")}
    </table>
    <p class="note" style="margin-top:10px">首稿编造记录 ID（R4）的情况时有发生，不返工就被封顶 C 级；返工是出错时兜底，不拉高平均分。同一份数据模型打分在 80 多分上下浮动、分档会在两档之间摇摆，所以单次分数只说明过没过红线。</p>
  </div>
</section>

<section>
  <div class="sec-head"><h2>这份研判的自动评测</h2><p>另一个模型（DeepSeek V4 Pro）按七个维度打分，再扣掉没过的软规则。</p></div>
  <div class="card">
${ev.dims.map((d) => `    <div class="score"><div class="name">${esc(d.name)}</div><div class="track"><div class="fill" style="width:${(d.score / d.max) * 100}%"></div></div><div class="num">${d.score}/${d.max}</div></div>`).join("\n")}
  </div>
</section>

<footer>
  <p>数据：B站、知乎公开内容，${esc(date)} 抓取；只存用户 ID 的哈希，不存昵称。原话和链接见<a href="report/">完整报告</a>。</p>
  <p>研判和评测维度改写自初五的 Chuwu-PR-OS（MIT）。编码、研判 DeepSeek V4 Flash，评测 DeepSeek V4 Pro。</p>
</footer>
</div>
</body>
</html>
`;

const reportHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.brand)}舆情研判报告 · ${esc(date)}</title>
<style>
  body { margin: 0; background: #f6f5f1; color: #1f1f1d; font: 15px/1.75 -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; overflow-wrap: anywhere; }
  @media (max-width: 520px) { .wrap { padding: 28px 16px 64px; } }
  a { color: #2a78d6; } h1 { font-size: 26px; line-height: 1.35; } h2 { font-size: 20px; margin-top: 36px; } h3 { font-size: 16px; }
  blockquote { margin: 0; padding: 8px 14px; background: #fcfcfb; border-left: 3px solid #2a78d6; color: #55544f; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; display: block; overflow-x: auto; }
  th, td { border-bottom: 1px solid #e6e4de; padding: 6px 8px; text-align: left; vertical-align: top; }
  code { font-size: 12px; } .back { font-size: 14px; }
</style></head>
<body><div class="wrap"><p class="back"><a href="../">← 回到概览</a></p>
${marked.parse(md)}
</div></body></html>
`;

fs.mkdirSync(path.join(outDir, "report"), { recursive: true });
fs.writeFileSync(path.join(outDir, "index.html"), html);
fs.writeFileSync(path.join(outDir, "report", "index.html"), reportHtml);
console.log(`${id} → ${outDir}/index.html、report/index.html`);
