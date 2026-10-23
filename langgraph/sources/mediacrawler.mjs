// 小红书后备：AgentKey 积分不够时用 MediaCrawler（https://github.com/NanmiCoder/MediaCrawler，装在 ~/claude/MediaCrawler）。
// 它用自己的账号登录抓，有风控风险，所以只当后备，量和 AgentKey 那条一样（每词几篇、每篇 comment_limit 条一级评论、不展开楼中楼）。
// 先整轮跑一次 MediaCrawler 的关键词搜索，读它写的 jsonl，再按 xiaohongshu-mcp 的格式回答 callTool，02、03 的解析不用改。
// 浏览器：MediaCrawler 自己拉起一个 Chrome（资料目录在它的 browser_data/ 下，第一次要扫码登录，之后复用），
// 调试端口改成 9333——它默认去接 9222 上开着的 Chrome，那是 Boss 直聘专用的那个。
// 它存的数据没有 IP 属地，作者 ID 是它算好的哈希（03 再哈希一次，只用来数独立用户，不影响）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const MC_DIR = process.env.MEDIACRAWLER_DIR || path.join(os.homedir(), "claude", "MediaCrawler");

// 改几项没有命令行参数的设置再跑它的 main.py：CDP 端口、请求间隔（默认 2 秒，放宽到 5 秒）、
// 排序（它默认按点赞，改成综合，和 AgentKey、n8n 版一样记「公众先看到的」排名），
// 以及每词篇数——它搜索时每个关键词至少抓满一页 20 篇（详情 + 评论），这里把每页搜索结果截到 MC_PER_KEYWORD 篇
const LAUNCH = `import os, sys, runpy, config
config.ENABLE_CDP_MODE = True
config.CDP_CONNECT_EXISTING = False
config.CDP_DEBUG_PORT = 9333
config.CRAWLER_MAX_SLEEP_SEC = 5
config.SORT_TYPE = "general"
from media_platform.xhs.client import XiaoHongShuClient
_search = XiaoHongShuClient.get_note_by_keyword
async def _capped(self, *a, **k):
    r = await _search(self, *a, **k)
    if r and r.get("items"):
        r["items"] = [i for i in r["items"] if i.get("model_type") not in ("rec_query", "hot_query")][:int(os.environ["MC_PER_KEYWORD"])]
    return r
XiaoHongShuClient.get_note_by_keyword = _capped
sys.argv = ["main.py"] + sys.argv[1:]
runpy.run_path("main.py", run_name="__main__")`;

const readJsonl = (dir, kind) => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith(`search_${kind}_`)).sort()
        .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];

// contents / comments：MediaCrawler 的 jsonl 记录。返回和 xiaohongshu-mcp 同样格式的 callTool
export function mediacrawlerTool({ contents, comments }) {
    const interact = (n) => ({ likedCount: n.liked_count, collectedCount: n.collected_count, commentCount: n.comment_count, sharedCount: n.share_count });
    const byNote = {};
    for (const c of comments) (byNote[c.note_id] = byNote[c.note_id] || []).push(c);
    const callTool = async (name, args) => {
        if (name === "search_feeds") {
            const feeds = contents.filter((n) => n.source_keyword === args.keyword).map((n) => ({
                id: n.note_id, xsecToken: n.xsec_token, modelType: "note",
                noteCard: { type: n.type, displayTitle: n.title, user: { userId: n.creator_hash }, interactInfo: interact(n) },
            }));
            return { json: { feeds, count: feeds.length } };
        }
        if (name === "get_feed_detail") {
            const n = contents.find((x) => x.note_id === args.feed_id);
            if (!n) return { json: { error: "MediaCrawler 没抓到这篇的详情" } };
            return {
                json: {
                    data: {
                        note: { noteId: n.note_id, title: n.title, desc: n.desc, type: n.type, time: n.time, ipLocation: "", user: { userId: n.creator_hash }, interactInfo: interact(n) },
                        comments: {
                            list: (byNote[n.note_id] || []).filter((c) => !c.parent_comment_id).map((c) => ({
                                id: c.comment_id, content: c.content, createTime: c.create_time, likeCount: c.like_count, ipLocation: "", userInfo: { userId: c.creator_hash }, subComments: [],
                            })),
                        },
                    },
                },
            };
        }
        return { json: { error: `MediaCrawler 版没有实现 ${name}` } };
    };
    return { callTool };
}

export async function mediacrawlerCaller({ keywords, perKeyword, commentLimit, timeoutMs = 30 * 60 * 1000 }) {
    if (!fs.existsSync(path.join(MC_DIR, "main.py"))) throw new Error(`没找到 MediaCrawler：${MC_DIR}（README 的「小红书」一节有安装步骤）`);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "mediacrawler-"));
    await run("uv", ["run", "python", "-c", LAUNCH,
        "--platform", "xhs", "--lt", "qrcode", "--type", "search", "--keywords", keywords.join(","),
        "--crawler_max_notes_count", String(perKeyword), "--get_comment", "yes", "--get_sub_comment", "no",
        "--max_comments_count_singlenotes", String(commentLimit), "--max_concurrency_num", "1",
        "--save_data_option", "jsonl", "--save_data_path", out,
    ], { cwd: MC_DIR, timeout: timeoutMs, maxBuffer: 64 << 20, env: { ...process.env, MC_PER_KEYWORD: String(perKeyword) } });
    const dir = path.join(out, "xhs", "jsonl");
    const tool = mediacrawlerTool({ contents: readJsonl(dir, "contents"), comments: readJsonl(dir, "comments") });
    fs.rmSync(out, { recursive: true, force: true }); // 里面是抓来的原文，读完就删
    return tool;
}
