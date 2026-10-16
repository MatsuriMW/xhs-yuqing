// 把笔记详情和评论拍平成统一的记录：一篇笔记一条正文记录 + 若干评论记录。
// 不存昵称，用户 ID 只存哈希，用来数独立用户。
const metas = $('拆解笔记列表').all().map(i => i.json);
const { config, run } = $('配置').first().json;
// FNV-1a，只用来数独立用户，不需要密码学强度
const hash = s => {
  if (!s) return '';
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'u' + h.toString(16).padStart(8, '0');
};

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
const toIso = t => {
  const n = Number(t);
  if (!n) return '';
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
};

const notes = [];
const records = [];
const fetchErrors = [];

$input.all().forEach((item, i) => {
  const meta = metas[i];
  if (!meta || meta.empty) return;
  if (item.json?.error) { fetchErrors.push({ note_id: meta.note_id, error: String(item.json.error).slice(0, 200) }); return; }
  const payload = mcpPayload(item);
  const d = payload.data || payload;
  const note = d.note || {};
  if (!note.noteId && !note.title && !note.desc) {
    fetchErrors.push({ note_id: meta.note_id, error: (payload._text || '详情为空').slice(0, 200) });
    return;
  }
  const ii = note.interactInfo || {};
  const interact = {
    liked: num(ii.likedCount) || meta.list_interact.liked,
    collected: num(ii.collectedCount) || meta.list_interact.collected,
    comment: num(ii.commentCount) || meta.list_interact.comment,
    shared: num(ii.shareCount ?? ii.sharedCount) || meta.list_interact.shared,
  };
  const url = `https://www.xiaohongshu.com/explore/${meta.note_id}` + (meta.xsec_token ? `?xsec_token=${meta.xsec_token}&xsec_source=pc_search` : '');
  const title = note.title || meta.list_title || '';
  notes.push({
    note_id: meta.note_id, keyword: meta.keyword, source: meta.source || '搜索', official: !!meta.official,
    search_ranks: meta.search_ranks || [], note_type: note.type === 'video' ? '视频' : '图文', title, url,
    author: hash(note.user?.userId), time: toIso(note.time), ip: note.ipLocation || '',
    interact, interact_total: interact.liked + interact.collected + interact.comment + interact.shared,
  });
  records.push({
    rid: `n_${meta.note_id}`, kind: '笔记', note_id: meta.note_id, note_title: title, url,
    note_type: note.type === 'video' ? '视频' : '图文', official: !!meta.official,
    text: [title, note.desc].filter(Boolean).join('\n').slice(0, 1500),
    user: hash(note.user?.userId), time: toIso(note.time), ip: note.ipLocation || '', likes: interact.liked,
  });
  const list = d.comments?.list || [];
  const pushComment = (c, parent) => {
    if (!c?.content) return;
    records.push({
      rid: `c_${c.id}`, kind: parent ? '回复' : '评论', note_id: meta.note_id, note_title: title, url, official: !!meta.official,
      parent: parent ? `c_${parent}` : '', text: String(c.content).slice(0, 600),
      user: hash(c.userInfo?.userId), time: toIso(c.createTime), ip: c.ipLocation || '', likes: num(c.likeCount),
    });
  };
  for (const c of list) {
    pushComment(c, null);
    for (const s of c.subComments || []) pushComment(s, c.id);
  }
});

return [{ json: { run, config, notes, records, fetch_errors: fetchErrors, search_log: metas[0]?._search_log || [], official: metas[0]?._official || { configured: [], seen_in_search: [] } } }];
