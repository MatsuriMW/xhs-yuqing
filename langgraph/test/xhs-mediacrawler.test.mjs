// MediaCrawler 的 jsonl（字段按它 store/xhs 写出的格式造）经 02、03 解析：按关键词分组、去重、评论挂到笔记下、楼中楼不收。
import test from "node:test";
import assert from "node:assert/strict";
import { runCode } from "../n8n.mjs";
import { fetchXhs } from "../sources/xhs.mjs";
import { mediacrawlerTool } from "../sources/mediacrawler.mjs";

const note = (id, kw, extra = {}) => ({
    note_id: id, type: "normal", title: `标题${id}`, desc: `正文${id}`, time: 1792625830000, creator_hash: `h${id}`,
    liked_count: "1.2万", collected_count: "34", comment_count: "2", share_count: "5", source_keyword: kw, xsec_token: `t${id}`, ...extra,
});
const comment = (id, noteId, parent = "") => ({ comment_id: id, note_id: noteId, content: `评论${id}`, create_time: 1792626303000, creator_hash: `u${id}`, like_count: 3, parent_comment_id: parent });

test("MediaCrawler 的笔记和评论经 02、03 解析成笔记和记录", async () => {
    const configItems = (await runCode("01_config.js")).filter((x) => x.json.kind === "search");
    const [k1, k2] = configItems.map((x) => x.json.keyword);
    const { callTool } = mediacrawlerTool({
        contents: [note("a", k1), note("b", k1), note("a", k2)], // a 两个词都搜到了
        comments: [comment("c1", "a"), comment("c2", "a", "c1"), comment("c3", "b")],
    });
    const out = await fetchXhs({ configItems, callTool, perKeyword: 2 });

    assert.deepEqual(out.notes.map((n) => n.note_id), ["a", "b"]);
    const a = out.notes[0];
    assert.equal(a.interact.liked, 12000);
    assert.deepEqual(a.search_ranks.map((r) => r.keyword), [k1, k2]);
    assert.equal(a.ip, "");
    assert.deepEqual(out.records.map((r) => r.rid), ["n_a", "c_c1", "n_b", "c_c3"]);
    assert.equal(out.fetch_errors.length, 0);
});
