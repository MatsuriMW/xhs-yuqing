// 把各关键词的搜索结果、官方号主页拆成笔记列表，跨关键词去重，每个关键词最多取 max_notes_per_keyword 篇。
// 顺带记下每篇笔记在各关键词下的搜索排名（公众搜这个词先看到哪几篇），以及搜索结果里出现过的官方号。
const cfgItems = $('配置').all();
const { config, run } = cfgItems[0].json;

function mcpPayload(item) {
  const content = item.json?.result?.content ?? item.json?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        try { return JSON.parse(c.text); } catch (e) { return { _text: c.text }; }
      }
    }
  }
  return item.json || {};
}

const num = v => {
  if (v == null) return 0;
  const s = String(v).trim();
  if (/万/.test(s)) return Math.round(parseFloat(s) * 10000);
  const n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

// 主页接口的返回结构和搜索不一样，按「对象数组、元素带 id 和 noteCard / xsecToken」找笔记列表
function findFeeds(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 5) return [];
  if (Array.isArray(o.feeds)) return o.feeds;
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && (x.noteCard || x.xsecToken) && (x.id || x.noteId))) return v;
    const sub = findFeeds(v, depth + 1);
    if (sub.length) return sub;
  }
  return [];
}

const officialNames = new Set((config.official_accounts || []).map(a => a.nickname));
const notes = [];
const byId = {};
const searchLog = [];
const ranks = {};
const officialSeen = {};

$input.all().forEach((item, i) => {
  const cfg = cfgItems[i]?.json || {};
  const keyword = cfg.keyword ?? '';
  const isProfile = cfg.kind === 'profile';
  const payload = mcpPayload(item);
  const feeds = isProfile ? findFeeds(payload) : (Array.isArray(payload.feeds) ? payload.feeds : []);
  const limit = isProfile ? config.official_notes_per_account : config.max_notes_per_keyword;
  let taken = 0;
  let rank = 0;
  for (const f of feeds) {
    if (f.modelType && f.modelType !== 'note') continue;
    const id = f.id || f.noteId;
    if (!id) continue;
    rank++;
    const card = f.noteCard || f;
    const user = card.user || {};
    const nick = user.nickname || user.nickName || '';
    if (!isProfile) {
      (ranks[id] = ranks[id] || []).push({ keyword, rank });
      if (officialNames.has(nick) && user.userId) officialSeen[nick] = { nickname: nick, user_id: user.userId, xsec_token: user.xsecToken || '' };
    }
    if (byId[id]) { if (isProfile) byId[id].official = true; continue; }
    if (taken >= limit) continue;
    taken++;
    const ii = card.interactInfo || {};
    byId[id] = {
      keyword,
      source: isProfile ? '官方号' : '搜索',
      official: isProfile,
      note_id: id,
      xsec_token: f.xsecToken || '',
      list_title: card.displayTitle || card.title || '',
      list_interact: { liked: num(ii.likedCount), collected: num(ii.collectedCount), comment: num(ii.commentCount), shared: num(ii.sharedCount) },
    };
    notes.push(byId[id]);
  }
  searchLog.push({ keyword, kind: cfg.kind || 'search', returned: feeds.length, taken, error: payload._text && !feeds.length ? payload._text.slice(0, 200) : undefined });
});
for (const n of notes) n.search_ranks = ranks[n.note_id] || [];

const official = {
  configured: (config.official_accounts || []).filter(a => a.user_id).map(a => a.nickname),
  seen_in_search: Object.values(officialSeen),
};

// 下游节点按顺序取回这些元数据
return notes.length
  ? notes.map(n => ({ json: { ...n, _search_log: searchLog, _official: official } }))
  : [{ json: { empty: true, _search_log: searchLog, _official: official } }];
