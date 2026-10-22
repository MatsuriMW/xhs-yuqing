// 两种研判模式：事件模式（事情已经发生，看走势）和日常模式（没有触发事件，做常规体检）。
// 先让模型看指标摘要判断是哪种（LangChain 结构化输出），再按模式给研判模型补一段写法要求。报告结构和规则检查不变，只改侧重。
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { deepseekKey } from "./llm.mjs";

const Mode = z.object({
    mode: z.enum(["事件", "日常"]),
    event: z.string().nullable().describe("事件模式时一句话说清是什么事；日常模式为 null"),
    evidence: z.array(z.string()).describe("两三条判断依据，引用摘要里的数字或标题"),
    confidence: z.enum(["高", "中", "低"]),
});

const prompt = ChatPromptTemplate.fromMessages([
    ["system", `你是舆情分析师。根据一次监测的指标摘要，判断品牌「{brand}」现在处在哪种状态：
- 事件：有一件具体的事（发布、事故、投诉、言论、政策、竞品对比等）在近期集中引发讨论，窗口内的量、负面或高压线明显跟这件事有关。
- 日常：没有一件事在主导讨论，内容分散在产品使用、口碑、玩梗、旧话题上，窗口内的变化属于日常波动。
注意：窗口内量多不等于有事件，要看讨论是否集中在同一件事上；只有旧账被零星翻出也算日常。拿不准时选「日常」、置信度「低」。
只输出 JSON：{{"mode": "事件" | "日常", "event": 事件模式时一句话说清是什么事，日常模式为 null, "evidence": ["两三条依据"], "confidence": "高" | "中" | "低"}}`],
    ["human", "{summary}"],
]);

// 从 07 的指标和记录里挑判断要用的东西，压成一段短文本
export function summarize(d) {
    const m = d.metrics;
    const W = Date.parse(m.run.run_at) - 24 * 3600e3 * (d.config.window_days || 1);
    const inWindow = d.records.filter((r) => r.kind === "笔记" && r.time && Date.parse(r.time) >= W && r.code?.target === "本机构")
        .sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10);
    const hv = Object.entries(m.content.high_voltage || {}).filter(([, v]) => typeof v === "number" && v > 0);
    return [
        `窗口：过去 ${m.window}；平台：${(m.run.platforms || []).join("、")}`,
        `窗口变化：相关记录 ${m.change.records} 条（前一窗口 ${m.change.prev_window_records}），负面 ${m.change.negative}（前一窗口 ${m.change.prev_window_negative}），高敏 ${m.change.high_voltage}（前一窗口 ${m.change.prev_window_high_voltage}）`,
        `情绪：负面占比 ${m.emotion.negative_pct}%，强负面 ${m.emotion.intense_negative} 条，语气 ${JSON.stringify(m.emotion.tone)}，集体经验召回 ${m.emotion.collective_recall}`,
        `话题（负面里）：${JSON.stringify(m.content.topics_in_negative)}；高压线：${hv.length ? hv.map(([k, v]) => `${k} ${v}`).join("、") : "无"}`,
        `动员最高 ${m.mobilization.max} 级；三维度风险：${JSON.stringify(m.levels)}`,
        `窗口内新发、指向本品牌的高赞内容：\n${inWindow.map((r) => `- ${r.note_title}（${r.likes} 赞，${r.time.slice(0, 10)}）`).join("\n") || "- 无"}`,
        `各关键词搜索前列：\n${(m.visibility?.search_surface || []).map((s) => `- ${s.keyword}：${s.top.slice(0, 3).map((t) => t.title).join(" / ")}`).join("\n")}`,
    ].join("\n");
}

export async function classifyMode(d, { model = "deepseek-flash" } = {}) {
    const llm = new ChatDeepSeek({ model, apiKey: deepseekKey(), temperature: 0 });
    return prompt.pipe(llm.withStructuredOutput(Mode, { name: "mode", method: "jsonMode" })).invoke({ brand: d.config.brand, summary: summarize(d) });
}

// 给研判模型的写法要求
const HISTORY = "metrics.history 是同一品牌之前几次运行的摘要（时间、分档、阶段、负面占比、相关条数），判断走势时要和它对比；为空说明是第一次运行，走势只能看窗口内外的对比。";

export function modeNote(m) {
    return `${modeText(m)}\n${HISTORY}`;
}

function modeText(m) {
    if (m.mode === "事件") {
        return [
            `本次按「事件模式」研判：事件是「${m.event}」（判断依据：${m.evidence.join("；")}）。`,
            "重点写走势：「过去变化」一节围绕这件事写窗口内新增了什么；「走势研判」要给出阶段判断的依据，升级条件和降温条件写成下一个窗口能观测到的具体信号（哪个平台、什么内容、什么量级）；",
            "「对业务的参考」侧重回应时机和口径要先核实什么；和这件事无关的旧话题只作背景，不要混进事件叙事。",
        ].join("\n");
    }
    return [
        `本次按「日常模式」研判：目前没有一件事在主导讨论（判断依据：${m.evidence.join("；")}）。`,
        "重点做常规体检：口碑的基本面（正负面结构、主要话题、谁在说）、公众实际看到的版本、潜在风险的苗头（高压线、旧账复用、对比里落下风的点），以及需要自查的项目；",
        "分档按证据写，没有集中讨论就不要为了写走势硬造一个事件叙事；「走势研判」写清日常波动的范围，升级条件写成需要预警的信号。",
    ].join("\n");
}
