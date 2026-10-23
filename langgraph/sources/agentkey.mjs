// 小红书走 AgentKey（第三方数据接口，按次扣积分，不用自己的账号，没有封号风险）。
// 对外和 xhs.mjs 的 mcpCaller 一样是 callTool(name, args)，返回值转成 xiaohongshu-mcp 的格式，02、03 的解析不用改。
// 用到三个 TikHub 接口，每次 2 积分：搜索（一页 20 篇）、图文 / 视频详情（完整正文、IP 属地）、一级评论（一页 10 条，带楼中楼）。
// 积分不够时抛 QuotaError，由图里换 MediaCrawler 重抓。密钥读环境变量 AGENTKEY_TOKEN，没有就读钥匙串 agentkey-token。
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOOL = {
    search: "TikHub/search_notes_api_v1_xiaohongshu_app_v2_search_notes_get",
    image: "TikHub/get_image_note_detail_api_v1_xiaohongshu_app_v2_get_image_note_detail_get",
    video: "TikHub/get_video_note_detail_api_v1_xiaohongshu_app_v2_get_video_note_detail_get",
    comments: "TikHub/get_note_comments_api_v1_xiaohongshu_app_v2_get_note_comments_get",
};
const CREDITS_PER_CALL = 2;

export class QuotaError extends Error {}
const isQuota = (s) => /insufficient|credit|quota|balance|402|余额|额度|积分/i.test(s);

// 一轮要多少积分：每个关键词搜一次，每篇笔记一次详情 + 评论按 10 条一页翻
export function creditsNeeded({ keywords, notes, commentLimit }) {
    return CREDITS_PER_CALL * (keywords + notes * (1 + Math.ceil(commentLimit / 10)));
}

function token() {
    return process.env.AGENTKEY_TOKEN || execFileSync("security", ["find-generic-password", "-s", "agentkey-token", "-w"]).toString().trim();
}

// 把 AgentKey 的返回转成 xiaohongshu-mcp 的格式
export function toFeeds(res) {
    const items = res?.data?.data?.data?.items || [];
    return items.filter((x) => x.model_type === "note" && x.note).map(({ note: n }) => ({
        id: n.id, xsecToken: n.xsec_token, modelType: "note",
        noteCard: {
            type: n.type, displayTitle: n.title,
            user: { userId: n.user?.userid, nickname: n.user?.nickname },
            interactInfo: { likedCount: n.liked_count, collectedCount: n.collected_count, commentCount: n.comments_count, sharedCount: n.shared_count },
        },
    }));
}

const toComment = (c) => ({
    id: c.id, content: c.content, createTime: c.time, likeCount: c.like_count, ipLocation: c.ip_location,
    userInfo: { userId: c.user?.userid }, subComments: (c.sub_comments || []).map(toComment),
});

export function toDetail(detailRes, commentPages) {
    const n = detailRes?.data?.data?.data?.[0]?.note_list?.[0];
    if (!n) return { _text: "AgentKey 详情为空" };
    return {
        data: {
            note: {
                noteId: n.id, title: n.title, desc: n.desc, type: n.type, time: n.time, ipLocation: n.ip_location,
                user: { userId: n.user?.userid },
                interactInfo: { likedCount: n.liked_count, collectedCount: n.collected_count, commentCount: n.comments_count, sharedCount: n.shared_count },
            },
            comments: { list: commentPages.flatMap((p) => p?.data?.data?.data?.comments || []).map(toComment) },
        },
    };
}

export async function agentkeyCaller() {
    const client = new Client({ name: "yuqing-langgraph", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://api.agentkey.app/v1/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${token()}` } },
    }));
    let spent = 0;
    const exec = async (name, params) => {
        const r = await client.callTool({ name: "execute_tool", arguments: { name, params } }, undefined, { timeout: 120000 });
        const text = r.content?.find((c) => c.type === "text")?.text || "";
        if (r.isError) throw new (isQuota(text) ? QuotaError : Error)(`AgentKey ${name.split("/")[0]}：${text.slice(0, 200)}`);
        const j = JSON.parse(text);
        spent += j.credits_charged || 0;
        return j;
    };
    const remaining = async () => (await exec("agentkey_account", {})).credits?.remaining ?? 0;

    const typeOf = {}; // 搜索时记下笔记类型，详情按图文 / 视频走不同接口
    const callTool = async (name, args) => {
        try {
            if (name === "search_feeds") {
                const feeds = toFeeds(await exec(TOOL.search, { keyword: args.keyword }));
                for (const f of feeds) typeOf[f.id] = f.noteCard.type;
                return { json: { feeds, count: feeds.length } };
            }
            if (name === "get_feed_detail") {
                const detail = await exec(typeOf[args.feed_id] === "video" ? TOOL.video : TOOL.image, { note_id: args.feed_id });
                const pages = [];
                let cursor = "";
                for (let got = 0; got < args.limit;) {
                    const p = await exec(TOOL.comments, { note_id: args.feed_id, sort_strategy: "like_count", cursor });
                    pages.push(p);
                    const d = p?.data?.data?.data || {};
                    got += (d.comments || []).length;
                    if (!d.has_more || !d.comments?.length) break;
                    cursor = d.cursor;
                }
                return { json: toDetail(detail, pages) };
            }
            return { json: { error: `AgentKey 版没有实现 ${name}` } };
        } catch (e) {
            if (e instanceof QuotaError) throw e;
            return { json: { error: String(e.message || e) } };
        }
    };
    return { callTool, remaining, spent: () => spent, close: () => client.close() };
}
