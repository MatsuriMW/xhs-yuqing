// 小红书数据源离线验证：用 n8n 第 61 次执行录下的 MCP 返回重放，不连小红书。
// 要求：调用的工具和参数跟 n8n 当时一样，产出的笔记和记录跟 n8n 的「结构化」一致（只多一个 platform 字段）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchXhs, replayCaller } from "../sources/xhs.mjs";

const FIX = new URL("../fixtures/61.json", import.meta.url);
const has = fs.existsSync(FIX);

test("小红书数据源按 n8n 的顺序和参数调用 MCP，结果一致", { skip: !has }, async () => {
    const R = JSON.parse(fs.readFileSync(FIX, "utf8"));
    const configItems = R["配置"].flat().map(({ json }) => ({ json }));
    const { callTool, calls } = replayCaller(R);
    const out = await fetchXhs({ configItems, callTool });

    const want = R["结构化"][0][0].json;
    assert.deepEqual(out.notes, want.notes);
    assert.deepEqual(out.records.map(({ platform, ...r }) => r), want.records);
    assert.ok(out.records.every((r) => r.platform === "小红书"));
    // 02 会写出 error: undefined，存成 JSON 后就没了，所以按 JSON 比
    assert.deepEqual(JSON.parse(JSON.stringify(out.search_log)), want.search_log);

    const metas = R["拆解笔记列表"].flat().map((x) => x.json);
    assert.deepEqual(calls.filter((c) => c.name === "search_feeds").map((c) => c.args.keyword), want.config.keywords);
    assert.deepEqual(calls.filter((c) => c.name === "get_feed_detail").map((c) => c.args.feed_id), metas.map((m) => m.note_id));
});
