// B站数据源：按关键词搜视频，抓视频数据和热门评论，输出和 ../src/03_structure.js 一样形状的 notes / records，
// 下游的编码、指标、研判代码不用改。视频当「笔记」处理（kind 仍是「笔记」，note_type 是「视频」）。
//
// 只用不登录就能访问的公开接口，每个请求间隔 1 秒：
//   搜索   /x/web-interface/search/type   综合排序（公众搜这个词先看到的）和按发布时间（窗口内的新视频）各取一份
//   视频   /x/web-interface/view           点赞、收藏、评论、分享数和简介
//   评论   /x/v2/reply                     按热度。不登录时 B站每个视频只给 3 条热评（连带少量楼中楼），也没有 IP 属地；
//                                           传入 opencli.mjs 的 bilibiliBrowserGet（借 Chrome 的登录态）时每页 20 条、带 IP 属地，按 commentPages 翻页
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 和 03_structure.js 同一个哈希：只用来数独立用户，不存昵称和原始 ID
const hash = (s) => {
    if (!s) return "";
    let h = 0x811c9dc5;
    for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return "u" + h.toString(16).padStart(8, "0");
};
const toIso = (sec) => (sec ? new Date(sec * 1000).toISOString() : "");
const strip = (s) => String(s || "").replace(/<[^>]+>/g, "");

function client({ gapMs = 1000 } = {}) {
    let cookie = "";
    let last = 0;
    return async function get(url, referer = "https://www.bilibili.com/") {
        const wait = last + gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        if (!cookie) {
            // 先开一次首页拿 buvid3，和浏览器第一次访问一样
            const home = await fetch("https://www.bilibili.com/", { headers: { "User-Agent": UA } });
            cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
            await sleep(gapMs);
        }
        const r = await fetch(url, { headers: { "User-Agent": UA, Referer: referer, Cookie: cookie }, signal: AbortSignal.timeout(20000) });
        const j = await r.json();
        if (j.code !== 0) throw new Error(`B站接口 ${j.code} ${j.message || ""}`.trim());
        return j.data;
    };
}

// keywords：关键词列表；perKeyword：每个关键词综合排序和最新各取几个视频；commentPages：评论翻几页（不登录时只有第 1 页有内容）
export async function fetchBilibili({ keywords, perKeyword = 8, commentPages = 1, get = client() }) {
    const picked = new Map(); // bvid → { meta, ranks }
    const searchLog = [];
    const fetchErrors = [];
    for (const keyword of keywords) {
        for (const order of ["totalrank", "pubdate"]) {
            const q = new URLSearchParams({ search_type: "video", keyword, order, page: "1" });
            let list = [];
            try {
                list = (await get(`https://api.bilibili.com/x/web-interface/search/type?${q}`, "https://search.bilibili.com/")).result || [];
            } catch (e) {
                fetchErrors.push({ note_id: `搜索：${keyword}`, error: String(e.message).slice(0, 200) });
            }
            let taken = 0;
            list.forEach((v, i) => {
                const hit = picked.get(v.bvid);
                // 只有综合排序的名次算「公众先看到的」
                if (hit && order === "totalrank") hit.ranks.push({ keyword, rank: i + 1 });
                if (hit || taken >= perKeyword) return;
                taken++;
                picked.set(v.bvid, { v, keyword, source: order === "totalrank" ? "搜索" : "最新", ranks: order === "totalrank" ? [{ keyword, rank: i + 1 }] : [] });
            });
            searchLog.push({ keyword: order === "totalrank" ? keyword : `${keyword}（最新）`, kind: "search", returned: list.length, taken });
        }
    }

    const notes = [];
    const records = [];
    for (const [bvid, { v, keyword, source, ranks }] of picked) {
        let view;
        try {
            view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
        } catch (e) {
            fetchErrors.push({ note_id: bvid, error: String(e.message).slice(0, 200) });
            continue;
        }
        const s = view.stat || {};
        const interact = { liked: s.like || 0, collected: s.favorite || 0, comment: s.reply || 0, shared: s.share || 0 };
        const url = `https://www.bilibili.com/video/${bvid}`;
        const title = view.title || strip(v.title);
        notes.push({
            note_id: bvid, keyword, source, official: false, search_ranks: ranks, note_type: "视频", title, url,
            author: hash(view.owner?.mid), time: toIso(view.pubdate), ip: "", plays: s.view || 0,
            interact, interact_total: interact.liked + interact.collected + interact.comment + interact.shared,
        });
        records.push({
            rid: `n_${bvid}`, kind: "笔记", note_id: bvid, note_title: title, url, note_type: "视频", official: false, platform: "B站",
            text: [title, view.desc].filter(Boolean).join("\n").slice(0, 1500),
            user: hash(view.owner?.mid), time: toIso(view.pubdate), ip: "", likes: interact.liked,
        });
        const replies = [];
        for (let pn = 1; pn <= commentPages; pn++) {
            try {
                const page = (await get(`https://api.bilibili.com/x/v2/reply?type=1&oid=${view.aid}&sort=1&ps=20&pn=${pn}`, url)).replies || [];
                replies.push(...page);
                if (page.length < 20) break;
            } catch (e) {
                fetchErrors.push({ note_id: bvid, error: `评论第 ${pn} 页：${String(e.message).slice(0, 180)}` });
                break;
            }
        }
        const push = (c, parent) => {
            if (!c?.content?.message) return;
            records.push({
                rid: `c_${c.rpid}`, kind: parent ? "回复" : "评论", note_id: bvid, note_title: title, url, official: false, platform: "B站",
                parent: parent ? `c_${parent}` : "", text: String(c.content.message).slice(0, 600),
                user: hash(c.mid), time: toIso(c.ctime), ip: (c.reply_control?.location || "").replace(/^IP属地：/, ""), likes: c.like || 0,
            });
        };
        for (const c of replies) {
            push(c, null);
            for (const sub of c.replies || []) push(sub, c.rpid);
        }
    }
    return { notes, records, fetch_errors: fetchErrors, search_log: searchLog, official: { configured: [], seen_in_search: [] } };
}
