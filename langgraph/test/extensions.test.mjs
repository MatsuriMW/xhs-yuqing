// 用的人关心的几样：品牌文件、提醒分级、飞书签名和卡片
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { runCode } from "../n8n.mjs";
import { injectBrand } from "../graph.mjs";
import { alertOf, buildCard, sign } from "../notify.mjs";

test("品牌文件：顶层字段替换，industry 只覆盖写了的键，提示词变量跟着变", async () => {
    const brand = JSON.parse(fs.readFileSync(new URL("../brands/小米汽车.json", import.meta.url), "utf8"));
    const [{ json }] = await runCode("01_config.js", { input: [{ json: {} }], transform: injectBrand({ ...brand, industry: { audience: "车主和准车主" } }) });
    assert.equal(json.config.brand, "小米汽车");
    assert.deepEqual(json.config.keywords, brand.keywords);
    assert.equal(json.config.prompt_vars.BRAND_CONTEXT, brand.brand_context);
    assert.equal(json.config.prompt_vars.AUDIENCE, "车主和准车主");
    assert.equal(json.config.industry.name, "汽车"); // 没写的键保留
    assert.equal(json.config.prompt_vars.CONTEXT_NOTES, "- 无");
});

const fakeRun = (over = {}) => ({
    config: { brand: "某品牌" },
    metrics: { window: "24 小时", change: { records: 10, prev_window_records: 8, negative: 2, prev_window_negative: 2, high_voltage: 0, prev_window_high_voltage: 0 }, emotion: { negative_pct: 20 }, history: [], ...over.metrics },
    report: { level: { verdict: "尚未形成舆情", reason: "量小 [r:n_1]" }, trend: { stage: "阶段暂不可判断" }, business: { next_step: "观察即可", self_check: [] }, ...over.report },
    evaluation: { grade: "B", score: 80, rule_checks: [{ pass: true }, { pass: false }] },
});

test("提醒分级：平常是日常简报；分档到舆情前夜、事件模式、高敏变多、分档比上次高都要提醒", () => {
    assert.equal(alertOf(fakeRun(), { mode: "日常" }).alert, false);
    assert.equal(alertOf(fakeRun({ report: { level: { verdict: "舆情前夜" } } }), null).alert, true);
    assert.equal(alertOf(fakeRun(), { mode: "事件", event: "某事" }).alert, true);
    const hv = fakeRun({ metrics: { change: { records: 10, prev_window_records: 8, negative: 2, prev_window_negative: 2, high_voltage: 3, prev_window_high_voltage: 1 } } });
    assert.match(alertOf(hv, null).reasons[0], /高敏 1 → 3/);
    const up = fakeRun({ metrics: { history: [{ run_at: "2026-10-21T00:00:00Z", level: "传播证据不足，暂不可分档" }] } });
    assert.equal(alertOf(up, null).alert, true);
});

test("飞书签名：key 是「时间戳\\n密钥」，对空串 HmacSHA256 再 base64", () => {
    const want = crypto.createHmac("sha256", "1700000000\nabc").update("").digest("base64");
    assert.equal(sign("1700000000", "abc"), want);
});

test("卡片：红绿分级、引用记号去掉、待复核时带复核命令", () => {
    const card = buildCard({ run: fakeRun(), mode: { mode: "日常" }, cost: { total: 12345 }, reportPath: "/x.md", reviewCommand: "node run.mjs resume t --approve" });
    assert.equal(card.card.header.template, "green");
    assert.match(card.card.header.title.content, /日常简报（待复核）/);
    const text = card.card.elements[0].text.content;
    assert.ok(!text.includes("[r:"));
    assert.match(card.card.elements[2].elements[0].content, /12k tokens.*复核：node run.mjs resume t --approve/s);
});
