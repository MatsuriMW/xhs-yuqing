// 收回编码结果，校验枚举，和缓存合并。没编码成功的记录标 missing，不参与统计。
const d = $('增量对比').first().json;
const ENUM = {
  target: ['本机构', '同名或其他机构', '泛讨论', '无法判断'],
  sentiment: ['正面', '中性', '负面', '混合'],
  tone: ['推荐', '询问', '陈述', '质疑', '抱怨', '愤怒', '嘲讽', '避雷警告', '玩梗'],
  evidence: ['亲历自述', '转述', '询问', '无法判断'],
  // 话题和高压线随行业变，从「配置」的 industry 取
  topics: d.config.industry.topics,
  high_voltage: Object.keys(d.config.industry.high_voltage),
  format: ['亲历分享', '截图爆料', '测评对比', '资讯转述', '玩梗二创', '挂话题蹭热', '广告营销', '其他', '评论'],
  compare_side: ['本机构占上风', '本机构落下风', '不分高下', '无对比'],
};
const VER = d.config.coding_version || 1;
const kindOf = Object.fromEntries(d.records.map(r => [r.rid, r.kind]));
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));
const textOf = Object.fromEntries(d.records.map(r => [r.rid, r.text]));

function clean(c) {
  const quote = String(c.quote || '');
  return {
    target: pick(c.target, ENUM.target, '无法判断'),
    sentiment: pick(c.sentiment, ENUM.sentiment, '中性'),
    tone: pick(c.tone, ENUM.tone, '陈述'),
    intensity: clampInt(c.intensity, 0, 3),
    topics: (Array.isArray(c.topics) ? c.topics : []).filter(t => ENUM.topics.includes(t)),
    high_voltage: (Array.isArray(c.high_voltage) ? c.high_voltage : []).filter(t => ENUM.high_voltage.includes(t)),
    format: kindOf[c.rid] === '笔记' ? pick(c.format, ENUM.format.filter(f => f !== '评论'), '其他') : '评论',
    compare_with: String(c.compare_with || '').slice(0, 40),
    compare_side: String(c.compare_with || '').trim() ? pick(c.compare_side, ENUM.compare_side.filter(x => x !== '无对比'), '不分高下') : '无对比',
    mobilization: clampInt(c.mobilization, 0, 6),
    collective_recall: c.collective_recall === true,
    evidence: pick(c.evidence, ENUM.evidence, '无法判断'),
    // 原话必须真在原文里，否则视为改写，丢掉
    quote: quote && (textOf[c.rid] || '').includes(quote) ? quote : '',
    quote_rejected: quote && !(textOf[c.rid] || '').includes(quote) ? true : undefined,
    note: String(c.note || '').slice(0, 60),
    coded_by: 'model',
    v: VER,
  };
}

// 模型偶尔把结果包成 {"type":"json_object","content":{...}}，先拆壳
const unwrap = o => (o && typeof o.content === 'object' && o.content && Object.keys(o).every(k => ['type', 'content'].includes(k)) ? o.content : o);
// 宽松解析：模型偶尔在字符串里直接用英文双引号（标签"避雷"），严格解析失败时把两侧都不挨着 JSON 语法符号的引号转义再试
function repairQuotes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '"' || s[i - 1] === '\\') { out += ch; continue; }
    let p = i - 1; while (p >= 0 && /\s/.test(s[p])) p--;
    let n = i + 1; while (n < s.length && /\s/.test(s[n])) n++;
    const structural = p < 0 || '{[,:'.includes(s[p]) || n >= s.length || ',}]:'.includes(s[n]);
    out += structural ? ch : '\\"';
  }
  return out;
}
// 模型偶尔多写一个 } 把顶层对象提前关掉（"substance":"…"},"trend":…），删掉提前闭合处的括号再试
function dropEarlyClose(s) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && /^\s*,/.test(s.slice(i + 1))) return s.slice(0, i) + s.slice(i + 1);
    }
  }
  return null;
}
function parseLoose(s) {
  let cur = s;
  for (let k = 0; k < 6; k++) {
    // 括号放错位置时，删掉提前闭合的那个之后结尾会少一个，补上再试
    for (const cand of [cur, repairQuotes(cur), cur + '}', repairQuotes(cur) + '}']) {
      try { return JSON.parse(cand); } catch (e) { /* 继续修 */ }
    }
    const next = dropEarlyClose(cur);
    if (!next) break;
    cur = next;
  }
  return JSON.parse(s); // 修不好就抛原始错误
}
const fresh = {};
const batchErrors = [];
let responses = [];
try { responses = $('编码 DeepSeek').all(); } catch (e) { responses = []; }
for (const r of responses) {
  if (r.json.error) { batchErrors.push(String(r.json.error.message || r.json.error).slice(0, 200)); continue; }
  try {
    const content = r.json.choices[0].message.content;
    const parsed = unwrap(parseLoose(content));
    for (const c of parsed.codes || []) if (c.rid && textOf[c.rid] != null) fresh[c.rid] = clean(c);
  } catch (e) {
    batchErrors.push('编码结果解析失败：' + e.message);
  }
}

const coded = { ...d.state.coded, ...fresh };
let quoteRejected = 0;
let records = d.records.map(r => {
  const c = coded[r.rid];
  if (c?.quote_rejected) quoteRejected++;
  return c ? { ...r, code: c, coding_status: fresh[r.rid] ? 'new' : 'cached' } : { ...r, code: null, coding_status: 'missing' };
});

// 指向兜底：模型偶尔把别家笔记下、没任何线索的评论判成本机构。
// 评论 / 回复要判本机构，所在笔记或上层评论得是本机构，或原文有线索；否则降为无法判断。缓存不改，每次都重算。
const clues = d.config.target_clues || [d.config.brand];
const targetOf = Object.fromEntries(records.filter(r => r.code).map(r => [r.rid, r.code.target]));
let targetDowngraded = 0;
records = records.map(r => {
  if (!r.code || r.kind === '笔记' || r.code.target !== '本机构') return r;
  const upstream = [targetOf[`n_${r.note_id}`], r.parent ? targetOf[r.parent] : null];
  if (upstream.includes('本机构') || clues.some(k => r.text.includes(k))) return r;
  targetDowngraded++;
  return { ...r, code: { ...r.code, target: '无法判断', target_adjusted: '本机构→无法判断（上层不是本机构，原文也没有线索）' } };
});

return [{
  json: {
    ...d,
    records,
    coded_all: coded,
    coding_stats: {
      total: records.length,
      newly_coded: Object.keys(fresh).length,
      cached: records.filter(r => r.coding_status === 'cached').length,
      missing: records.filter(r => r.coding_status === 'missing').length,
      quote_rejected: quoteRejected,
      target_downgraded: targetDowngraded,
      batch_errors: batchErrors,
    },
  },
}];
