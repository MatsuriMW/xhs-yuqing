// 小红书数据源：照搬 n8n 版的抓取顺序——逐个关键词 search_feeds（官方号走 user_profile）→ 02 拆解笔记列表 →
// 逐篇 get_feed_detail → 03 结构化，两步解析直接跑 ../src 的代码。
// callTool 可以换：线上先走 AgentKey，积分不够换 MediaCrawler（fetchXhsLive）；测试时换成 n8n 执行记录的重放，不碰小红书。
import { runCode } from "../n8n.mjs";
import { agentkeyCaller, creditsNeeded, QuotaError } from "./agentkey.mjs";
import { mediacrawlerCaller } from "./mediacrawler.mjs";

// configItems：01_config.js 的输出（每个关键词 / 官方号一项）；perKeyword 覆盖 max_notes_per_keyword
export async function fetchXhs({ configItems, callTool, perKeyword }) {
    if (perKeyword != null) for (const it of configItems) it.json.config = { ...it.json.config, max_notes_per_keyword: perKeyword };
    const { config } = configItems[0].json;

    const searched = [];
    for (const { json: c } of configItems) {
        searched.push(c.kind === "profile"
            ? await callTool("user_profile", { user_id: c.account.user_id, xsec_token: c.account.xsec_token })
            : await callTool("search_feeds", Object.keys(c.config.search_filters || {}).length ? { keyword: c.keyword, filters: c.config.search_filters } : { keyword: c.keyword }));
    }
    const metas = await runCode("02_parse_feeds.js", { input: searched, nodes: { 配置: configItems } });

    const details = [];
    for (const { json: m } of metas) {
        details.push(m.empty ? { json: {} } : await callTool("get_feed_detail", {
            feed_id: m.note_id, xsec_token: m.xsec_token, load_all_comments: true, limit: config.comment_limit, click_more_replies: config.click_more_replies,
        }));
    }
    const [{ json: s }] = await runCode("03_structure.js", { input: details, nodes: { 拆解笔记列表: metas, 配置: configItems } });
    return {
        notes: s.notes, records: s.records.map((r) => ({ ...r, platform: "小红书" })),
        fetch_errors: s.fetch_errors, search_log: s.search_log, official: s.official,
    };
}

// 线上：先走 AgentKey；剩余积分不够这一轮（按关键词数、篇数、评论条数估），或者抓到一半用完，整轮换 MediaCrawler 重抓
export async function fetchXhsLive({ configItems, perKeyword }) {
    const { config: c } = configItems[0].json;
    const keywords = configItems.filter((x) => x.json.kind === "search").map((x) => x.json.keyword);
    const n = perKeyword ?? c.max_notes_per_keyword;
    const need = creditsNeeded({ keywords: keywords.length, notes: keywords.length * n, commentLimit: c.comment_limit });
    let why;
    const ak = await agentkeyCaller();
    try {
        const have = await ak.remaining();
        if (have >= need) {
            try {
                const got = await fetchXhs({ configItems, callTool: ak.callTool, perKeyword });
                return { ...got, via: `AgentKey，花了 ${ak.spent()} 积分` };
            } catch (e) {
                if (!(e instanceof QuotaError)) throw e;
                why = `AgentKey 积分中途用完（已花 ${ak.spent()}）`;
            }
        } else why = `AgentKey 剩 ${have} 积分，这一轮约要 ${need}`;
    } finally {
        await ak.close();
    }
    console.log(`小红书：${why}，改用 MediaCrawler`);
    const mc = await mediacrawlerCaller({ keywords, perKeyword: n, commentLimit: c.comment_limit });
    return { ...(await fetchXhs({ configItems, callTool: mc.callTool, perKeyword })), via: `MediaCrawler（${why}）` };
}

// 测试用：按调用顺序重放 n8n 某次执行里「搜索笔记」「抓取详情和评论」的返回
export function replayCaller(fixture) {
    const queues = { search_feeds: fixture["搜索笔记"].flat(), user_profile: (fixture["抓取官方号主页"] || []).flat(), get_feed_detail: fixture["抓取详情和评论"].flat() };
    const calls = [];
    const callTool = async (name, args) => {
        calls.push({ name, args });
        const next = queues[name].shift();
        if (!next) throw new Error(`重放记录里没有更多的 ${name}`);
        return { json: next.json };
    };
    return { callTool, calls };
}
