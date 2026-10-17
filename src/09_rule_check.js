// 规则检查（硬红线，代码判定），再拼评测请求：抽检样本只给原文，加上报告和指标。
const PROMPT = __PROMPT_JUDGE__;
const d = $('聚合研判指标').first().json;
const { config, metrics } = d;

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
let report = null;
let parseError = '';
try {
  report = unwrap(parseLoose($input.first().json.choices[0].message.content));
} catch (e) {
  parseError = $input.first().json.error ? String($input.first().json.error.message || $input.first().json.error) : e.message;
}

const LEVELS = ['已形成舆情', '舆情前夜', '尚未形成舆情', '传播证据不足，暂不可分档'];
const STAGES = ['潜伏期', '激化期', '爆发期', '反转期', '降温期', '阶段暂不可判断'];
const rids = new Set(d.records.map(r => r.rid));
const text = report ? JSON.stringify(report) : '';
const H = report?.handoff || null;
const handoffText = H ? [...(H.confirmed_facts || []), ...(H.evidence || []), ...(H.counter_evidence || []), ...(H.gaps || []), H.biggest_uncertainty, H.exposure,
  ...(H.options || []).map(o => `${o.action || ''} ${o.cost || ''}`), ...(H.for_downstream || [])].filter(Boolean).join('\n') : '';
const prose = report ? [report.window_change, report.visible_version, handoffText, report.level?.reason, report.substance, ...(report.trend?.escalate_if || []), ...(report.trend?.cool_if || []),
  report.business?.exposure, ...(report.business?.self_check || []), report.business?.next_step_reason].filter(Boolean).join('\n') : '';
// 引用解析：认 [r:id]、[id1,id2]、[r:id1,r:id2]；模型常把 ID 写短、或把评论的 c_ 写成 n_，能唯一对上的补全，对不上的才算编造
const TOKEN = '(?:r[:_])?(?:[nc][:_])?[0-9a-f]{6,}';
const CITE = new RegExp(`\\[(${TOKEN}(?:[,，、\\s]+${TOKEN})*)\\]`, 'g');
const ALL_RIDS = d.records.map(r => r.rid);
function resolveRid(tok) {
  const t = tok.replace(/^r[:_]/, '').replace(/^([nc]):/, '$1_');
  if (ALL_RIDS.includes(t)) return { rid: t, short: false };
  const body = t.replace(/^[nc]_/, '');
  const hits = ALL_RIDS.filter(r => r.startsWith(t) || r.slice(2).startsWith(body));
  return hits.length === 1 ? { rid: hits[0], short: true } : { rid: null, raw: tok };
}
const splitIds = s => s.split(/[,，、\s]+/).filter(Boolean);
const citedRaw = [...new Set([...[...text.matchAll(CITE)].flatMap(m => splitIds(m[1])), ...(report?.cited_rids || [])])];
const resolved = citedRaw.map(resolveRid);
const cited = resolved.filter(x => x.rid).map(x => x.rid);
const shortCount = resolved.filter(x => x.short).length;

const checks = [];
const add = (id, name, pass, detail, cap) => checks.push({ id, name, pass, detail: pass ? '' : detail, cap: pass ? null : cap });

const failedKw = metrics.sample.keywords_failed || [];
add('R0', '采集完整（每个关键词都搜到了）', failedKw.length === 0, `关键词「${failedKw.join('」「')}」返回 0 条，样本不完整`, 'B');
add('R1', '结构完整', !!report && !!report.basis && !!report.window_change && !!report.level && !!report.substance && !!report.trend && !!report.business,
  parseError || '缺少判断基准 / 窗口变化 / 分档 / 实质 / 走势 / 业务参考中的某一段', 'C');
add('R2', '分档在四个取值里', !!report && LEVELS.includes(report.level?.verdict), `分档写成了「${report?.level?.verdict}」`, 'C');
// 阶段要连续传播证据：快照得跨满一个研判窗口（24 小时窗口要有 24 小时前的快照），只有两次但隔得太近也不算
const spanOk = metrics.spread.window_base_run_at != null;
add('R3', '快照没跨满一个窗口时不判断阶段', !report || spanOk || report.trend?.stage === '阶段暂不可判断',
  `快照还没跨满 ${metrics.window}（共 ${metrics.run.snapshots} 次），阶段却写成「${report?.trend?.stage}」`, 'C');
if (report && spanOk) add('R3b', '阶段在六个取值里', STAGES.includes(report.trend?.stage), `阶段写成了「${report.trend?.stage}」`, 'C');
const fake = resolved.filter(x => !x.rid).map(x => x.raw);
add('R4', '引用的记录真实存在且至少一条', cited.length > 0 && fake.length === 0,
  cited.length ? `引用了不存在的记录：${fake.slice(0, 5).join('、')}` : '一条记录都没引用', 'C');
// R12：「窗口变化」一段只能引用窗口内的记录，防止把存量写成近期新增
const nowMs = Date.parse(metrics.run.run_at);
const W = (metrics.sample.window_days || 1) * 86400e3;
const timeOf = Object.fromEntries(d.records.map(r => [r.rid, r.time]));
const winCited = [...String(report?.window_change || '').matchAll(CITE)].flatMap(m => splitIds(m[1])).map(resolveRid).filter(x => x.rid).map(x => x.rid);
const stale = winCited.filter(rid => !timeOf[rid] || nowMs - Date.parse(timeOf[rid]) > W);
add('R12', '窗口变化只引用窗口内的记录', stale.length === 0, `窗口变化一段引用了窗口外的存量：${stale.slice(0, 5).join('、')}`, 'B');
add('R4b', '引用写全 ID', shortCount === 0, `${shortCount} 处 ID 写短或前缀写错了（已按唯一前缀补全）`, null);
const allowed = new Set(d.allowed_pcts);
const pcts = [...prose.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)].map(m => Math.round(parseFloat(m[1])));
const badPcts = pcts.filter(p => !allowed.has(p));
add('R5', '百分比都来自指标', badPcts.length === 0, `指标里没有的百分比：${[...new Set(badPcts)].join('、')}%`, 'C');
const gaps = (report?.basis?.evidence_gaps || []).join(' ');
add('R6', '单平台要写明其他平台未覆盖', !report || metrics.spread.platforms_covered.length > 1 || /平台/.test(gaps),
  '只抓了小红书，证据缺口里没交代其他平台未覆盖', 'B');
add('R6b', '官方号评论区没覆盖时要交代', !report || metrics.official?.covered || /官方号/.test(gaps),
  '没抓官方号评论区（半公开喊话主要在那里），证据缺口里没交代', 'B');
const basisText = JSON.stringify(report?.basis || {});
add('R7', '同名占比高时要交代', !report || metrics.sample.not_ours_pct <= 30 || /同名|其他机构|无法判断|指向/.test(basisText),
  `同名或无法判断的记录占 ${metrics.sample.not_ours_pct}%，判断基准里没交代`, 'B');
// 措辞规则（R8 / R9 / R10 / R13）只查研判自己的话，「」里引的网友原话不算
const ownProse = prose.replace(/「[^」]*」/g, '');
const hollow = (ownProse.match(/加强沟通|高度关注|密切关注|积极应对|引起重视|高度重视/g) || []);
add('R8', '没有空话', hollow.length === 0, `出现：${[...new Set(hollow)].join('、')}`, null);
const overreach = config.industry.overreach_words.filter(w => ownProse.includes(w));
add('R9', '没有把评论区外推成整体公众', overreach.length === 0, `出现：${[...new Set(overreach)].join('、')}`, null);
// R13：排名、互动量、高赞只说明被看见，写成「共识」「公众认为」就是把可见性当态度
const asAttitude = (ownProse.match(/形成共识|形成了共识|普遍认为|一致认为|舆论认为|公众认为|网友普遍|主流看法/g) || []);
add('R13', '没有把可见性写成态度', asAttitude.length === 0, `出现：${[...new Set(asAttitude)].join('、')}`, null);
const visCited = [...String(report?.visible_version || '').matchAll(CITE)].flatMap(m => splitIds(m[1])).map(resolveRid).filter(x => x.rid);
add('R14', '写了「公众实际看到的版本」并引用记录', !report || metrics.sample.records_coded === 0 || (!!report.visible_version && visCited.length > 0),
  report?.visible_version ? '「公众实际看到的版本」一段没引用记录' : '缺「公众实际看到的版本」一段', 'B');
const HF = ['decision_subject', 'time_anchor', 'confirmed_facts', 'evidence', 'counter_evidence', 'gaps', 'biggest_uncertainty', 'exposure', 'options', 'for_downstream'];
const emptyField = k => H?.[k] == null || (Array.isArray(H[k]) ? H[k].length === 0 : !String(H[k]).trim());
const needHandoff = !!report && report.business?.next_step && report.business.next_step !== '观察即可';
const missingHF = needHandoff ? HF.filter(emptyField) : [];
add('R15', '下一步不是观察即可时交接包八字段齐全', !needHandoff || missingHF.length === 0,
  H ? `交接包缺：${missingHF.join('、')}` : `下一步是「${report?.business?.next_step}」却没写交接包`, 'B');
const legal = (ownProse.match(/违法|构成欺诈|应承担法律责任|触犯/g) || []);
add('R10', '不替法务定责', legal.length === 0, `出现：${[...new Set(legal)].join('、')}`, null);
add('R11', '写了决策主体和带日期的时间锚点', !!report?.basis?.decision_subject && /\d{4}|\d{1,2}月/.test(report?.basis?.time_anchor || ''),
  '判断基准里缺决策主体或时间锚点没有日期', 'B');

// 抽检样本：负面、高压线、动员 ≥4 的优先，再随机补齐；只给原文
const coded = d.records.filter(r => r.code);
const prio = coded.filter(r => r.code.sentiment === '负面' || r.code.high_voltage.length || r.code.mobilization >= 4);
const rest = coded.filter(r => !prio.includes(r));
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
const n = config.recode_sample_size;
const sample = [...shuffle(prio).slice(0, Math.ceil(n * 0.6)), ...shuffle(rest)];
const picked = [...new Map(sample.map(r => [r.rid, r])).values()].slice(0, n);
const noteText = Object.fromEntries(d.records.filter(r => r.kind === '笔记').map(r => [r.note_id, r.text.slice(0, 200)]));

const fill = s => s.replace(/\{\{(\w+)\}\}/g, (m, k) => config.prompt_vars[k] ?? m);
const system = fill(PROMPT);
const userPayload = {
  recode_samples: picked.map(r => ({ rid: r.rid, kind: r.kind, note_context: r.kind === '笔记' ? undefined : noteText[r.note_id], text: r.text, ip: r.ip || undefined })),
  report,
  metrics,
  evidence: d.evidence,
};

return [{
  json: {
    report, report_parse_error: parseError, rule_checks: checks, recode_rids: picked.map(r => r.rid),
    skip_judge: !report,
    body: {
      model: config.models.judge,
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(userPayload) }],
    },
  },
}];
