// AgentKey 返回转成 xiaohongshu-mcp 格式后，02、03 能照常解析：完整正文、IP 属地、评论和楼中楼都在。
// 数据是 2026-10-23 真调一次搜索 / 图文详情 / 评论的返回（fixtures/agentkey/，含小红书原文，不进仓库）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runCode } from "../n8n.mjs";
import { fetchXhs } from "../sources/xhs.mjs";
import { toFeeds, toDetail, creditsNeeded } from "../sources/agentkey.mjs";

const DIR = new URL("../fixtures/agentkey/", import.meta.url);
const has = fs.existsSync(new URL("search.json", DIR));
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, DIR), "utf8"));

test("AgentKey 的搜索、详情、评论经 02、03 解析成笔记和记录", { skip: !has }, async () => {
    const search = load("search.json"), detail = load("detail.json"), comments = load("comments.json");
    const configItems = (await runCode("01_config.js")).filter((x) => x.json.kind === "search").slice(0, 1);
    const callTool = async (name) => ({ json: name === "search_feeds" ? { feeds: toFeeds(search) } : toDetail(detail, [comments]) });
    const out = await fetchXhs({ configItems, callTool, perKeyword: 1 });

    assert.equal(out.fetch_errors.length, 0);
    assert.equal(out.notes.length, 1);
    const [n] = out.notes;
    assert.equal(n.note_id, "6ad94ca6000000001400c400");
    assert.equal(n.ip, "United States");
    assert.equal(n.interact.shared, 1303);
    assert.equal(n.time, new Date(1792625830 * 1000).toISOString());
    assert.equal(n.search_ranks[0].rank, 1);

    const body = out.records.find((r) => r.kind === "笔记");
    assert.match(body.text, /安全气囊好像也没有弹出来/); // 搜索结果里的正文只有 60 字，这句来自详情
    const cs = out.records.filter((r) => r.kind !== "笔记");
    assert.deepEqual(cs.map((r) => r.kind), ["评论", "回复", "评论"]);
    assert.equal(cs[1].parent, "c_6ad94e7f000000000d022400");
    assert.ok(cs.every((r) => r.ip === "United States" && r.user && r.platform === "小红书"));
});

test("积分估算：每个关键词搜一次，每篇详情一次 + 评论每 10 条一页，每次 2 积分", () => {
    assert.equal(creditsNeeded({ keywords: 3, notes: 9, commentLimit: 30 }), 2 * (3 + 9 * 4));
    assert.equal(creditsNeeded({ keywords: 1, notes: 1, commentLimit: 5 }), 2 * (1 + 2));
});
