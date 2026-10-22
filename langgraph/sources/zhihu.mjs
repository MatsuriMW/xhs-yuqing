// 知乎数据源：借 Chrome 的登录态（OpenCLI 的知乎命令，只用只读的 search / answer-detail / answer-comments），
// 输出和 ../src/03_structure.js 一样形状的 notes / records。回答当「笔记」处理（note_type 为「回答」），标题用问题标题。
// 知乎不给 IP 属地；专栏文章先跳过（只记进搜索日志）。用户只存哈希（知乎这里拿到的是昵称）。
import { opencli } from "./opencli.mjs";

const hash = (s) => {
    if (!s) return "";
    let h = 0x811c9dc5;
    for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return "u" + h.toString(16).padStart(8, "0");
};
const answerId = (url) => url.match(/answer\/(\d+)/)?.[1];
const BG = ["--window", "background"]; // 在后台窗口里读，不抢用户的浏览器

// call：opencli 调用（测试时可换掉）；commentLimit：每个回答取几条一级评论（各带最多 3 条回复）
export async function fetchZhihu({ keywords, perKeyword = 8, commentLimit = 30, call = opencli }) {
    const picked = new Map(); // answer id → { keyword, ranks }
    const searchLog = [];
    const fetchErrors = [];
    for (const keyword of keywords) {
        let list = [];
        try {
            list = await call(["zhihu", "search", keyword, "-f", "json", "--limit", "20", ...BG]);
        } catch (e) {
            fetchErrors.push({ note_id: `搜索：${keyword}`, error: String(e.message).slice(0, 200) });
        }
        let taken = 0;
        list.forEach((x) => {
            const id = x.type === "answer" ? answerId(x.url) : null;
            if (!id) return;
            const hit = picked.get(id);
            if (hit) return void hit.ranks.push({ keyword, rank: x.rank });
            if (taken >= perKeyword) return;
            taken++;
            picked.set(id, { keyword, ranks: [{ keyword, rank: x.rank }] });
        });
        searchLog.push({ keyword, kind: "search", returned: list.length, taken, skipped_articles: list.filter((x) => x.type !== "answer").length });
    }

    const notes = [];
    const records = [];
    for (const [id, { keyword, ranks }] of picked) {
        let a;
        try {
            a = await call(["zhihu", "answer-detail", id, "-f", "json", ...BG]);
            a = Array.isArray(a) ? a[0] : a;
        } catch (e) {
            fetchErrors.push({ note_id: id, error: String(e.message).slice(0, 200) });
            continue;
        }
        const interact = { liked: Number(a.votes) || 0, collected: 0, comment: Number(a.comments) || 0, shared: 0 };
        const title = a.question_title || "";
        notes.push({
            note_id: id, keyword, source: "搜索", official: false, search_ranks: ranks, note_type: "回答", title, url: a.url,
            author: hash(a.author), time: a.created_at || "", ip: "", interact, interact_total: interact.liked + interact.comment,
        });
        records.push({
            rid: `n_${id}`, kind: "笔记", note_id: id, note_title: title, url: a.url, note_type: "回答", official: false, platform: "知乎",
            text: [title, a.content].filter(Boolean).join("\n").slice(0, 1500),
            user: hash(a.author), time: a.created_at || "", ip: "", likes: interact.liked,
        });
        let comments = [];
        try {
            comments = await call(["zhihu", "answer-comments", id, "-f", "json", "--limit", String(commentLimit), "--replies-limit", "3", ...BG]);
        } catch (e) {
            // 没有评论的回答，opencli 报 EMPTY_RESULT，不算抓取失败
            if (!/EMPTY_RESULT/.test(e.message)) fetchErrors.push({ note_id: id, error: `评论：${String(e.message).slice(0, 180)}` });
        }
        for (const c of comments) {
            if (!c.content) continue;
            records.push({
                rid: `c_${c.id}`, kind: c.depth > 0 ? "回复" : "评论", note_id: id, note_title: title, url: a.url, official: false, platform: "知乎",
                parent: c.depth > 0 && c.parent_id ? `c_${c.parent_id}` : "", text: String(c.content).slice(0, 600),
                user: hash(c.author), time: c.created_at || "", ip: "", likes: Number(c.likes) || 0,
            });
        }
    }
    return { notes, records, fetch_errors: fetchErrors, search_log: searchLog, official: { configured: [], seen_in_search: [] } };
}
