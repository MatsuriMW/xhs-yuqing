// 三维度指标全部由代码算，模型只能引用，不能自己算。只统计指向本机构、且落在研判窗口内的记录。
const d = $input.first().json;
const { config, run } = d;
const T = config.thresholds;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const countBy = (arr, f) => arr.reduce((m, x) => { for (const k of [].concat(f(x))) m[k] = (m[k] || 0) + 1; return m; }, {});
const LV = ['低', '中', '高'];

const coded = d.records.filter(r => r.code);
// 时间窗口：笔记按发布时间、评论按发表时间算。老帖下面窗口内的新评论也算，老帖本身不算
const nowMs = Date.parse(run.run_at);
const W = (config.window_days || 1) * 86400e3;
const WL = config.window_days === 1 ? '24 小时' : `${config.window_days} 天`;
const age = r => (r.time ? nowMs - Date.parse(r.time) : Infinity);
const inWin = r => age(r) <= W;
const inPrevWin = r => age(r) > W && age(r) <= 2 * W;
const relAll = coded.filter(r => r.code.target === '本机构');
const rel = relAll.filter(inWin);
const relNoteIds = new Set(rel.filter(r => r.kind === '笔记').map(r => r.note_id));
// 笔记正文没判成本机构、但评论区明确在说本机构的，笔记也算相关
for (const r of rel) relNoteIds.add(r.note_id);
const relNotes = d.notes.filter(n => relNoteIds.has(n.note_id));

// 传播维度
const prevMap = d.prev_snapshot?.notes || {};
// 窗口起点的快照：离「现在 - 窗口」最近、且不晚于它的那次；快照不够长就是 null
const snaps = d.state.snapshots || [];
const base = [...snaps].reverse().find(s => nowMs - Date.parse(s.run_at) >= W * 0.9) || null;
const interactions = relNotes.reduce((s, n) => s + n.interact_total, 0);
const comparable = relNotes.filter(n => prevMap[n.note_id] != null);
const prevTotal = comparable.reduce((s, n) => s + prevMap[n.note_id], 0);
const curComparable = comparable.reduce((s, n) => s + n.interact_total, 0);
const newNotes = relNotes.filter(n => !d.state.first_seen[n.note_id]);
const spread = {
  platforms_covered: ['小红书'],
  cross_platform: '未覆盖（本工作流只抓小红书）',
  relevant_notes: relNotes.length,
  new_relevant_notes: d.prev_snapshot ? newNotes.length : null,
  authors: new Set(relNotes.map(n => n.author).filter(Boolean)).size,
  interactions_total: interactions,
  interaction_delta: d.prev_snapshot ? curComparable - prevTotal : null,
  interaction_delta_pct: d.prev_snapshot && prevTotal ? pct(curComparable - prevTotal, prevTotal) : null,
  window: WL,
  // 窗口内发布的相关笔记
  notes_published_in_window: relNotes.filter(n => n.time && nowMs - Date.parse(n.time) <= W).length,
  // 和窗口起点那次快照比的互动增量（需要至少跑满一个窗口才有）
  window_base_run_at: base ? base.run_at : null,
  window_interaction_delta: base ? relNotes.filter(n => base.notes[n.note_id] != null).reduce((s, n) => s + n.interact_total - base.notes[n.note_id], 0) : null,
  window_delta_note: base ? null : `快照还不够 ${WL}，窗口互动增量要等跑满一个窗口才有；下面的互动总量是这些笔记的累计值`,
  top_notes: [...relNotes].sort((a, b) => b.interact_total - a.interact_total).slice(0, 5)
    .map(n => ({ rid: `n_${n.note_id}`, title: n.title, interact_total: n.interact_total, time: n.time, url: n.url })),
};
let spreadLv = 0;
if (relNotes.length >= T.spread.mid_notes || interactions >= T.spread.mid_interactions) spreadLv = 1;
if (relNotes.length >= T.spread.high_notes || interactions >= T.spread.high_interactions ||
    (spread.interaction_delta_pct != null && spread.interaction_delta_pct >= T.spread.high_delta_ratio * 100 && curComparable >= T.spread.mid_interactions)) spreadLv = 2;

// 情感维度
const sent = countBy(rel, r => r.code.sentiment);
const neg = rel.filter(r => ['负面', '混合'].includes(r.code.sentiment));
const negStrict = rel.filter(r => r.code.sentiment === '负面');
const recall = rel.filter(r => r.code.collective_recall);
const emotion = {
  n_records: rel.length,
  n_users: new Set(rel.map(r => r.user).filter(Boolean)).size,
  sentiment: sent,
  negative_pct: pct(negStrict.length, rel.length),
  negative_or_mixed_pct: pct(neg.length, rel.length),
  tone: countBy(rel, r => r.code.tone),
  intense_negative: neg.filter(r => r.code.intensity >= 2).length,
  collective_recall: recall.length,
  negative_users: new Set(neg.map(r => r.user).filter(Boolean)).size,
};
let emoLv = 0;
const negRatio = rel.length ? negStrict.length / rel.length : 0;
if (negRatio >= T.emotion.mid_neg_ratio || neg.some(r => r.code.intensity >= 3)) emoLv = 1;
if ((rel.length >= T.emotion.min_n && negRatio >= T.emotion.high_neg_ratio) || recall.length >= T.emotion.high_recall) emoLv = 2;

// 内容维度
const hv = {};
for (const r of rel) for (const h of r.code.high_voltage) (hv[h] = hv[h] || []).push(r.rid);
const content = {
  topics: countBy(rel, r => r.code.topics.length ? r.code.topics : ['未标注']),
  topics_in_negative: countBy(neg, r => r.code.topics.length ? r.code.topics : ['未标注']),
  high_voltage: Object.fromEntries(Object.entries(hv).map(([k, v]) => [k, v.length])),
  high_voltage_rids: hv,
};
let contentLv = Object.keys(hv).length ? 1 : 0;
const IND = config.industry;
if (IND.severe_high_voltage.some(h => hv[h]) ||
    rel.some(r => r.code.high_voltage.some(h => IND.escalate_with_mobilization.includes(h)) && r.code.mobilization >= T.mobilization_high)) contentLv = 2;

// 动员
const mob = rel.map(r => r.code.mobilization);
const mobilization = {
  max: mob.length ? Math.max(...mob) : 0,
  level_ge4: rel.filter(r => r.code.mobilization >= 4).length,
  level_ge5: rel.filter(r => r.code.mobilization >= 5).length,
  rids_ge4: rel.filter(r => r.code.mobilization >= 4).map(r => r.rid),
};
if (mobilization.max >= 6) contentLv = 2;

const levels = {
  spread: LV[spreadLv], emotion: LV[emoLv], content: LV[contentLv],
  overall: LV[Math.max(spreadLv, emoLv, contentLv)],
  rule: '三维度各自分级，风险量级取最高，不取平均（任一维度爆表都要警惕）',
};

// 和前一个同样长的窗口比（只数条数；每篇只抓前若干条热评，越早的评论越可能没抓到，前一窗口偏少）
const isNeg = r => r.code.sentiment === '负面';
const relPrev = relAll.filter(inPrevWin);
const change = {
  window: WL,
  records: rel.length,
  prev_window_records: relPrev.length,
  negative: rel.filter(isNeg).length,
  prev_window_negative: relPrev.filter(isNeg).length,
  high_voltage: rel.filter(r => r.code.high_voltage.length).length,
  prev_window_high_voltage: relPrev.filter(r => r.code.high_voltage.length).length,
  caveat: '每篇只抓前若干条热评，越早的评论越可能没被抓到，前一窗口的数字偏少，只看方向不看幅度',
};

// 窗口外的存量：只当背景
const bgNeg = relAll.filter(r => !inWin(r) && isNeg(r));
const background = {
  records_outside_window: relAll.length - rel.length,
  negative_outside_window: bgNeg.length,
  all_time_negative_pct: pct(relAll.filter(isNeg).length, relAll.length),
  oldest_record: relAll.map(r => r.time).filter(Boolean).sort()[0] || null,
  topics_in_negative: countBy(bgNeg, r => r.code.topics.length ? r.code.topics : ['未标注']),
};

// 公众实际看到的版本：搜索前排、互动最高的笔记，加上它们下面的高赞评论。
// 这些只说明「谁被看见」（可见性），不说明「多少人这么想」（态度）
const recByRid = Object.fromEntries(coded.map(r => [r.rid, r]));
const commentsOf = {};
for (const r of coded) if (r.kind !== '笔记') (commentsOf[r.note_id] = commentsOf[r.note_id] || []).push(r);
const noteView = n => {
  const c = recByRid[`n_${n.note_id}`]?.code || {};
  const tops = [...(commentsOf[n.note_id] || [])].sort((a, b) => b.likes - a.likes).slice(0, 3);
  return {
    rid: `n_${n.note_id}`, title: (n.title || '').slice(0, 40), note_type: n.note_type || '', format: c.format || '未标注',
    target: c.target, sentiment: c.sentiment, compare_with: c.compare_with || '', compare_side: c.compare_side || '无对比',
    interact_total: n.interact_total, in_window: !!(n.time && nowMs - Date.parse(n.time) <= W), official: !!n.official,
    top_comments: tops.map(r => ({ rid: r.rid, text: r.text.slice(0, 80), likes: r.likes, in_window: inWin(r), target: r.code.target,
      sentiment: r.code.sentiment, tone: r.code.tone, compare_with: r.code.compare_with || '', compare_side: r.code.compare_side || '无对比' })),
  };
};
// 每个关键词搜索结果的前 5 篇（只算抓到了详情的；小红书默认排序偏热帖）
const surface = config.keywords.map(kw => {
  const top = d.notes.map(n => ({ n, hit: (n.search_ranks || []).find(x => x.keyword === kw) })).filter(x => x.hit)
    .sort((a, b) => a.hit.rank - b.hit.rank).slice(0, 5).map(({ n, hit }) => ({ rank: hit.rank, ...noteView(n) }));
  return { keyword: kw, top, ours: top.filter(v => v.target === '本机构').length, ours_negative: top.filter(v => v.target === '本机构' && v.sentiment === '负面').length };
});
const visibleVersions = [...relNotes].sort((a, b) => b.interact_total - a.interact_total).slice(0, 3).map(noteView);
const cmpRecs = rel.filter(r => r.code.compare_with);
const visibility = {
  note: '搜索排名、互动量、高赞只说明被看见的程度，不等于有多少人持这个态度',
  search_surface: surface,
  visible_versions: visibleVersions,
  formats: countBy(relNotes, n => recByRid[`n_${n.note_id}`]?.code?.format || '未标注'),
  comparison: {
    records: cmpRecs.length,
    with: countBy(cmpRecs, r => r.code.compare_with.split(/[、,，]/).map(x => x.trim()).filter(Boolean)),
    side: countBy(cmpRecs, r => r.code.compare_side),
  },
};

// 官方号评论区（动员第 2 级「半公开喊话」的主场）
const offRecs = coded.filter(r => r.official && r.kind !== '笔记');
const offWin = offRecs.filter(inWin);
const official = {
  configured: d.official?.configured || [],
  seen_in_search: d.official?.seen_in_search || [],
  covered: d.notes.some(n => n.official),
  notes: d.notes.filter(n => n.official).length,
  comments: offRecs.length,
  comments_in_window: offWin.length,
  negative_in_window: offWin.filter(isNeg).length,
  shouting_in_window: offWin.filter(r => r.code.mobilization >= 2).length,
  top_negative_rids: offWin.filter(isNeg).sort((a, b) => b.likes - a.likes).slice(0, 5).map(r => r.rid),
};

// 样本与边界
const targetDist = countBy(coded, r => r.code.target);
const sample = {
  keywords: config.keywords,
  search_filters: config.search_filters,
  search_log: d.search_log,
  // 返回 0 条的关键词：可能真没有，也可能是 MCP 超时；都要在报告里交代
  keywords_failed: (d.search_log || []).filter(s => !s.returned).map(s => s.keyword),
  notes_fetched: d.notes.length,
  records_total: d.records.length,
  records_coded: coded.length,
  records_missing: d.coding_stats.missing,
  target_distribution: targetDist,
  not_ours_pct: pct((targetDist['同名或其他机构'] || 0) + (targetDist['无法判断'] || 0), coded.length),
  fetch_errors: d.fetch_errors.length,
  snapshots: d.snapshot_count,
  window_days: config.window_days || 1,
  records_in_window: coded.filter(inWin).length,
  relevant_in_window: rel.length,
  relevant_all_time: relAll.length,
};

// 给研判用的证据池：相关的负面 / 高压线 / 动员优先，再补少量正面和中性
const brief = r => ({
  rid: r.rid, kind: r.kind, in_window: inWin(r), note_title: r.note_title.slice(0, 40), text: r.text.slice(0, 220), likes: r.likes, time: r.time,
  target: r.code.target, sentiment: r.code.sentiment, tone: r.code.tone, intensity: r.code.intensity,
  topics: r.code.topics, high_voltage: r.code.high_voltage, mobilization: r.code.mobilization,
  collective_recall: r.code.collective_recall, evidence: r.code.evidence, quote: r.code.quote,
  format: r.code.format, compare_with: r.code.compare_with || '', compare_side: r.code.compare_side, official: !!r.official,
});
const score = r => (r.code.high_voltage.length ? 4 : 0) + r.code.mobilization + r.code.intensity + (r.code.sentiment === '负面' ? 3 : 0) + Math.min(3, Math.log10(1 + r.likes));
const risky = rel.filter(r => r.code.sentiment !== '正面' && r.code.sentiment !== '中性' || r.code.high_voltage.length || r.code.mobilization >= 2)
  .sort((a, b) => score(b) - score(a)).slice(0, 40);
const others = rel.filter(r => !risky.includes(r)).sort((a, b) => b.likes - a.likes).slice(0, 12);
// 同名机构里的负面也给几条，让研判知道「被误伤」的可能
const namesake = coded.filter(r => r.code.target === '同名或其他机构' && r.code.sentiment === '负面').sort((a, b) => b.likes - a.likes).slice(0, 5);
// 窗口外的存量负面给几条当背景，标 in_window: false
const bgRisky = bgNeg.sort((a, b) => score(b) - score(a)).slice(0, 8);
// 公众看到的版本、官方号评论区里的负面也要能被引用
const visRids = [...surface.flatMap(k => k.top), ...visibleVersions].flatMap(v => [v.rid, ...v.top_comments.map(c => c.rid)]);
const visible = [...new Set([...visRids, ...official.top_negative_rids])].map(rid => recByRid[rid]).filter(Boolean);
const evidence = [...new Map([...risky, ...others, ...namesake, ...bgRisky, ...visible].map(r => [r.rid, r])).values()].map(brief);

// R5 用：指标里出现过的所有百分比
const allowed_pcts = new Set();
JSON.stringify({ spread, emotion, sample, background }, (k, v) => { if (/pct$/.test(k) && typeof v === 'number') allowed_pcts.add(v); return v; });

const metrics = { run: { ...run, platforms: ['小红书'], snapshots: d.snapshot_count, state_note: d.state_note }, window: WL, sample, change, spread, emotion, content, mobilization, levels, background, visibility, official };
return [{ json: { ...d, metrics, evidence, allowed_pcts: [...allowed_pcts] } }];
