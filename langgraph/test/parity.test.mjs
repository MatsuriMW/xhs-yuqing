// 对拍：用 n8n 第 61 次运行（2026-10-17 08:04，特斯拉）每一步的真实输入，经 n8n.mjs 重跑 ../src 的代码，
// 输出要和 n8n 当时记下的逐字段一致。证明 LangGraph 版跑的是同一套业务逻辑。
// 没有 fixtures/61.json 时跳过（它含小红书原文，不进仓库；用 tools/extract-n8n-run.mjs 61 生成）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runCode } from "../n8n.mjs";

const FIX = new URL("../fixtures/61.json", import.meta.url);
const has = fs.existsSync(FIX);
const R = has ? JSON.parse(fs.readFileSync(FIX, "utf8")) : {};
const items = (name) => R[name].flat().map(({ json }) => ({ json }));
const json = (arr) => JSON.parse(JSON.stringify(arr.map((x) => x.json)));

test("02 拆解笔记列表", { skip: !has }, async () => {
    const out = await runCode("02_parse_feeds.js", { input: items("搜索笔记"), nodes: { 配置: items("配置") } });
    assert.deepEqual(json(out), json(items("拆解笔记列表")));
});

test("03 结构化", { skip: !has }, async () => {
    const out = await runCode("03_structure.js", { input: items("抓取详情和评论"), nodes: { 拆解笔记列表: items("拆解笔记列表"), 配置: items("配置") } });
    assert.deepEqual(json(out), json(items("结构化")));
});

test("04 增量对比", { skip: !has }, async () => {
    const state = items("增量对比")[0].json.state;
    const out = await runCode("04_diff_state.js", { nodes: { 结构化: items("结构化") }, binary: Buffer.from(JSON.stringify(state)) });
    assert.deepEqual(json(out), json(items("增量对比")));
});

test("05 切批", { skip: !has }, async () => {
    const out = await runCode("05_coding_batches.js", { input: items("增量对比") });
    assert.deepEqual(json(out), json(items("切批")));
});

test("06 合并编码 + 07 聚合研判指标", { skip: !has }, async () => {
    const merged = await runCode("06_merge_coding.js", { input: items("编码 DeepSeek"), nodes: { 增量对比: items("增量对比"), "编码 DeepSeek": items("编码 DeepSeek") } });
    assert.deepEqual(json(merged), json(items("合并编码")));
    const agg = await runCode("07_aggregate.js", { input: merged });
    assert.deepEqual(json(agg), json(items("聚合研判指标")));
});

test("08 构造研判请求", { skip: !has }, async () => {
    const out = await runCode("08_report_request.js", { input: items("聚合研判指标") });
    assert.deepEqual(json(out), json(items("构造研判请求")));
});

test("09 规则检查（抽检样本是随机的，只比规则结果）", { skip: !has }, async () => {
    const [out] = json(await runCode("09_rule_check.js", { input: items("研判 DeepSeek"), nodes: { 聚合研判指标: items("聚合研判指标") } }));
    const [want] = json(items("规则检查"));
    assert.deepEqual(out.rule_checks, want.rule_checks);
    assert.deepEqual(out.report, want.report);
});

test("10 评级与报告", { skip: !has }, async () => {
    const out = await runCode("10_finalize.js", { input: items("评测 DeepSeek Pro"), nodes: { 聚合研判指标: items("聚合研判指标"), 规则检查: items("规则检查") } });
    assert.deepEqual(json(out), json(items("评级与报告")));
});
