// 评级：模型打分 × 规则封顶取低；算编码抽检一致率；渲染 Markdown；更新状态。
const d = $('聚合研判指标').first().json;
const rc = $('规则检查').first().json;
const { config, metrics, run } = d;
const WEIGHTS = { problem: ['问题识别', 10], evidence: ['事实和证据', 20], public_context: ['公共语境', 20], business_fit: ['品牌和业务匹配', 10], actionability: ['策略可执行性', 15], expression: ['表达质量', 10], risk_control: ['风险控制', 15] };
const GRADES = ['D', 'C', 'B', 'A'];
const gradeOf = s => (s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 60 ? 'C' : 'D');
const minGrade = (...gs) => gs.filter(Boolean).reduce((a, b) => (GRADES.indexOf(a) <= GRADES.indexOf(b) ? a : b));

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
let judge = null, judgeError = '';
try {
  const j = $input.first().json;
  if (j.error) throw new Error(String(j.error.message || j.error));
  judge = unwrap(parseLoose(j.choices[0].message.content));
} catch (e) { judgeError = rc.skip_judge ? '研判没生成，跳过评测' : e.message; }

// 模型打分
const dims = Object.entries(WEIGHTS).map(([k, [name, max]]) => ({ key: k, name, max, score: Math.max(0, Math.min(max, Number(judge?.scores?.[k]) || 0)) }));
const total = judge ? dims.reduce((s, x) => s + x.score, 0) : 0;
const hardStops = judge?.hard_stops || [];
const caps = rc.rule_checks.filter(c => c.cap).map(c => c.cap);
if (hardStops.length) caps.push('C');
if (!judge) caps.push('D');
const softFails = rc.rule_checks.filter(c => !c.pass && !c.cap).length;
const finalScore = Math.max(0, total - softFails * 3);
const grade = minGrade(gradeOf(finalScore), ...caps);

// 编码抽检一致率
const byRid = Object.fromEntries(d.records.map(r => [r.rid, r]));
const sameSet = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');
const recode = (judge?.recode || []).filter(x => byRid[x.rid]?.code && rc.recode_rids.includes(x.rid));
const agree = { target: 0, sentiment: 0, high_voltage: 0 };
const disagreements = [];
for (const x of recode) {
  const c = byRid[x.rid].code;
  const diff = [];
  if (x.target === c.target) agree.target++; else diff.push(`指向 ${c.target}→${x.target}`);
  if (x.sentiment === c.sentiment) agree.sentiment++; else diff.push(`情感 ${c.sentiment}→${x.sentiment}`);
  if (sameSet(x.high_voltage || [], c.high_voltage)) agree.high_voltage++; else diff.push(`高压线 [${c.high_voltage}]→[${x.high_voltage || []}]`);
  if (diff.length) disagreements.push({ rid: x.rid, text: byRid[x.rid].text.slice(0, 80), url: byRid[x.rid].url, diff: diff.join('；') });
}
const nR = recode.length;
const rate = k => (nR ? Math.round((agree[k] / nR) * 100) : null);
const agreement = { n: nR, target: rate('target'), sentiment: rate('sentiment'), high_voltage: rate('high_voltage') };
agreement.overall = nR ? Math.round(((agree.target + agree.sentiment + agree.high_voltage) / (3 * nR)) * 100) : null;
const codingUnreliable = agreement.overall != null && agreement.overall < 70;

// ---------- Markdown ----------
const R = rc.report;
const complete = !!(R && R.basis && R.level && R.substance && R.trend && R.business);
const link = rid => {
  const r = byRid[rid];
  return r ? `[${rid}](${r.url})` : rid;
};
// 引用解析：认 [r:id]、[id1,id2]、[r:id1,r:id2]；模型常把 ID 写短，能唯一对上前缀的补全，对不上的才算编造
const TOKEN = '(?:r[:_])?(?:[nc][:_])?[0-9a-f]{6,}';
const CITE = new RegExp(`\\[(${TOKEN}(?:[,，、\\s]+${TOKEN})*)\\]`, 'g');
const ALL_RIDS = d.records.map(r => r.rid);
function resolveRid(tok) {
  const t = tok.replace(/^r[:_]/, '').replace(/^([nc]):/, '$1_');
  if (ALL_RIDS.includes(t)) return { rid: t, short: false };
  const hits = ALL_RIDS.filter(r => r.startsWith(t) || r.slice(2).startsWith(t));
  return hits.length === 1 ? { rid: hits[0], short: true } : { rid: null, raw: tok };
}
const splitIds = s => s.split(/[,，、\s]+/).filter(Boolean);
const cite = s => String(s || '').replace(CITE, (_, ids) => '（' + splitIds(ids).map(t => { const x = resolveRid(t); return x.rid ? link(x.rid) : t; }).join('、') + '）');
const li = arr => (arr || []).map(x => `- ${cite(x)}`).join('\n') || '- 无';
const sub = arr => (arr || []).map(x => `  - ${cite(x)}`).join('\n') || '  - 无';
const kv = o => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('，') || '无';
const fmt = v => (v == null ? '—（首次运行，没有上次快照）' : v);
const V = metrics.visibility || {};
const OF = metrics.official || {};
const surfaceText = (V.search_surface || []).map(k => `「${k.keyword}」前 ${k.top.length} 篇里本机构 ${k.ours} 篇、负面 ${k.ours_negative} 篇`).join('；') || '—（这次没有排名数据）';
const cmpText = V.comparison?.records ? `${V.comparison.records} 条在拿本机构和别家比：比的对象 ${kv(V.comparison.with)}；${kv(V.comparison.side)}` : '无';
const officialText = OF.covered
  ? `抓了 ${OF.configured.join('、')} 最近 ${OF.notes} 篇笔记、${OF.comments} 条评论，窗口内 ${OF.comments_in_window} 条（负面 ${OF.negative_in_window}，公开喊话及以上 ${OF.shouting_in_window}）`
  : `未覆盖（「配置」official_accounts 没填 user_id）${(OF.seen_in_search || []).length ? `；搜索结果里见到同名作者：${OF.seen_in_search.map(a => `${a.nickname} user_id ${a.user_id}`).join('，')}，核对是官方号后填进配置` : ''}`;

const banner = [];
banner.push(`> **评测 ${grade}（${finalScore}/100）**　规则检查 ${rc.rule_checks.filter(c => c.pass).length}/${rc.rule_checks.length} 通过　编码抽检一致率 ${agreement.overall ?? '—'}%（${nR} 条）`);
if (GRADES.indexOf(grade) < GRADES.indexOf('B')) banner.push('>\n> ⚠️ 这份结果只能作为讨论素材，不建议直接使用。请先补充事实、证据或组织动作，再生成发布版本。');
if (codingUnreliable) banner.push('>\n> ⚠️ 编码可靠性不足：两个模型对抽检样本的判断一致率低于 70%，指标仅供参考，先看附录里的分歧记录。');
if ((metrics.sample.keywords_failed || []).length) banner.push(`>\n> ⚠️ 采集不完整：关键词「${metrics.sample.keywords_failed.join('」「')}」这次返回 0 条（多半是小红书 MCP 超时），样本只覆盖其余关键词，传播维度会偏低。`);
if (metrics.sample.records_coded === 0) banner.push('>\n> ⚠️ 本次没有可用的记录（没搜到笔记，或抓取 / 编码全部失败），以下研判没有依据。');

const evRids = [...new Set([...JSON.stringify(R || {}).matchAll(CITE)].flatMap(m => splitIds(m[1]).map(t => resolveRid(t).rid)))].filter(r => r && byRid[r]);
const evRows = evRids.map(rid => {
  const r = byRid[rid];
  const c = r.code || {};
  const q = (c.quote || r.text).replace(/\s+/g, ' ').slice(0, 60).replace(/\|/g, '｜');
  const fc = [c.format && c.format !== '评论' ? c.format : '', c.compare_with ? `比 ${c.compare_with}（${c.compare_side}）` : ''].filter(Boolean).join('；') || '—';
  return `| ${link(rid)} | ${r.kind}${r.official ? '（官方号）' : ''} | ${q} | ${c.target || ''} / ${c.sentiment || ''} / ${c.tone || ''} | ${fc} | ${(c.high_voltage || []).join('、') || '—'} | ${c.mobilization ?? ''} | ${r.likes} |`;
}).join('\n');

const md = `# ${config.brand}小红书舆情研判 · ${run.run_at_local}

${banner.join('\n')}

${complete ? `## 判断基准

- **决策主体**：${R.basis.decision_subject}
- **时间锚点**：${R.basis.time_anchor}
- **范围**：${R.basis.scope}
- **证据缺口**：
${(R.basis.evidence_gaps || []).map(g => `  - ${g}`).join('\n')}

## 零、过去 ${metrics.window} 的变化

${R.window_change ? cite(R.window_change) : '（研判没写这一段）'}

## 公众实际看到的版本

${R.visible_version ? cite(R.visible_version) : '（研判没写这一段）'}

## 一、是否已经形成舆情

**${R.level.verdict}**。${cite(R.level.reason)}

## 二、舆情实质分析

${cite(R.substance)}

## 三、舆情走势研判

**${R.trend.stage}**

升级条件：
${li(R.trend.escalate_if)}

降温条件：
${li(R.trend.cool_if)}

## 四、对业务的参考意义

${cite(R.business.exposure)}

需要自查：
${li(R.business.self_check)}

**下一步：${R.business.next_step}**。${cite(R.business.next_step_reason)}
${R.handoff ? `
## 交接包（给回应决策用）

- **决策主体**：${R.handoff.decision_subject || '—'}
- **时间锚点**：${R.handoff.time_anchor || '—'}
- **已确认事实**：
${sub(R.handoff.confirmed_facts)}
- **证据**：
${sub(R.handoff.evidence)}
- **反证**：
${sub(R.handoff.counter_evidence)}
- **缺口**：
${sub(R.handoff.gaps)}
- **最大不确定性**：${cite(R.handoff.biggest_uncertainty) || '—'}
- **资产与业务影响**：${cite(R.handoff.exposure) || '—'}
- **可选动作及代价**：
${(R.handoff.options || []).map(o => `  - ${cite(o.action)}｜代价：${cite(o.cost)}`).join('\n') || '  - 无'}
- **需要下游决定或产出的事项**：
${sub(R.handoff.for_downstream)}
` : ''}` : `## 研判结构不完整，没法渲染\n\n${rc.report_parse_error || '模型返回的 JSON 缺少必需的段落，原始输出见下'}\n\n\`\`\`json\n${JSON.stringify(R, null, 2).slice(0, 4000)}\n\`\`\`\n`}
---

## 附一：三维度指标（代码计算，只统计指向本机构、过去 ${metrics.window} 内的记录）

风险量级 **${metrics.levels.overall}**（传播 ${metrics.levels.spread}｜情感 ${metrics.levels.emotion}｜内容 ${metrics.levels.content}）。${metrics.levels.rule}。

| 维度 | 指标 |
| --- | --- |
| 样本 | 关键词 ${metrics.sample.keywords.join('、')}；筛选 ${Object.values(metrics.sample.search_filters || {}).join(' / ') || '不筛选'}；抓到笔记 ${metrics.sample.notes_fetched} 篇、记录 ${metrics.sample.records_total} 条，编码 ${metrics.sample.records_coded} 条（失败 ${metrics.sample.records_missing}）；指向分布：${kv(metrics.sample.target_distribution)}；第 ${metrics.sample.snapshots} 次快照 |
| 窗口 | 过去 ${metrics.window}：窗口内记录 ${metrics.sample.records_in_window} 条，其中本机构 ${metrics.sample.relevant_in_window} 条（全部样本里本机构 ${metrics.sample.relevant_all_time} 条）；和前一个 ${metrics.window} 比：本机构记录 ${metrics.change.prev_window_records} → ${metrics.change.records}，负面 ${metrics.change.prev_window_negative} → ${metrics.change.negative}，碰高压线 ${metrics.change.prev_window_high_voltage} → ${metrics.change.high_voltage}（${metrics.change.caveat}） |
| 传播 | 窗口内有动静的相关笔记 ${metrics.spread.relevant_notes} 篇（其中窗口内新发 ${metrics.spread.notes_published_in_window} 篇），作者 ${metrics.spread.authors} 人，互动总量 ${metrics.spread.interactions_total}；新增相关笔记 ${fmt(metrics.spread.new_relevant_notes)}；可比笔记互动增量 ${fmt(metrics.spread.interaction_delta)}${metrics.spread.interaction_delta_pct != null ? `（${metrics.spread.interaction_delta_pct}%）` : ''}；窗口互动增量 ${metrics.spread.window_interaction_delta ?? '—'}${metrics.spread.window_delta_note ? `（${metrics.spread.window_delta_note}）` : `（对比 ${metrics.spread.window_base_run_at} 的快照）`}；跨平台：${metrics.spread.cross_platform} |
| 情感 | 相关记录 ${metrics.emotion.n_records} 条（${metrics.emotion.n_users} 个独立用户）：${kv(metrics.emotion.sentiment)}；负面占 ${metrics.emotion.negative_pct}%；烈度 ≥2 的负面 ${metrics.emotion.intense_negative} 条；集体经验召回 ${metrics.emotion.collective_recall} 条；语气：${kv(metrics.emotion.tone)} |
| 内容 | 话题：${kv(metrics.content.topics)}；负面集中在：${kv(metrics.content.topics_in_negative)}；高压线：${kv(metrics.content.high_voltage)} |
| 动员 | 最高 ${metrics.mobilization.max} 级；≥4 级 ${metrics.mobilization.level_ge4} 条，≥5 级 ${metrics.mobilization.level_ge5} 条 |
| 可见版本 | 搜索前排：${surfaceText}；相关笔记格式：${kv(V.formats)}（排名、互动和高赞只说明被看见，不等于态度） |
| 对比 | ${cmpText} |
| 官方号评论区 | ${officialText} |
| 存量背景 | 窗口外的本机构记录 ${metrics.background.records_outside_window} 条，其中负面 ${metrics.background.negative_outside_window} 条，集中在：${kv(metrics.background.topics_in_negative)}；全部样本负面占 ${metrics.background.all_time_negative_pct}%；最早一条 ${(metrics.background.oldest_record || '—').slice(0, 10)} |

热度最高的相关笔记：
${metrics.spread.top_notes.map(n => `- [${n.title || (byRid[n.rid]?.text || '').split('\n')[0].slice(0, 30) || n.rid}](${n.url})　互动 ${n.interact_total}`).join('\n') || '- 无'}

## 附二：研判引用的原话

| 记录 | 类型 | 原话 | 指向 / 情感 / 语气 | 格式 / 对比 | 高压线 | 动员 | 赞 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${evRows || '| — | | | | | | | |'}

## 附三：评测明细

评测体系见 \`framework/研判与评测体系.md\`（改写自初五 Chuwu-PR-OS 的热点舆情分析与 PR 输出质量评估）。

**规则检查**

| 编号 | 检查 | 结果 |
| --- | --- | --- |
${rc.rule_checks.map(c => `| ${c.id} | ${c.name} | ${c.pass ? '✅' : `❌ ${c.detail}${c.cap ? `（封顶 ${c.cap}）` : '（扣 3 分）'}`} |`).join('\n')}

**模型打分**（${config.models.judge}）${judgeError ? `：失败，${judgeError}` : ''}

| 维度 | 得分 |
| --- | --- |
${dims.map(x => `| ${x.name} | ${x.score}/${x.max} |`).join('\n')}
| 合计 | ${total}/100，规则扣分后 ${finalScore} |

${judge?.strengths?.length ? `做得好的：\n${judge.strengths.map(s => `- ${s}`).join('\n')}\n` : ''}
${judge?.issues?.length ? `问题：\n${judge.issues.map(s => `- ${cite(s)}`).join('\n')}\n` : ''}
${hardStops.length ? `硬停止（封顶 C）：\n${hardStops.map(s => `- ${s}`).join('\n')}\n` : ''}
**编码抽检**：${nR} 条，指向一致 ${agreement.target ?? '—'}%，情感一致 ${agreement.sentiment ?? '—'}%，高压线一致 ${agreement.high_voltage ?? '—'}%。两个模型一致不等于判对，只用来发现明显错标。

${disagreements.length ? `| 记录 | 原文 | 分歧（编码→复核） |\n| --- | --- | --- |\n${disagreements.map(x => `| [${x.rid}](${x.url}) | ${x.text.replace(/\s+/g, ' ').replace(/\|/g, '｜')} | ${x.diff} |`).join('\n')}` : '没有分歧。'}

<sub>运行 ${run.run_id}｜${run.trigger}触发｜编码 ${config.models.coding}（新编码 ${d.coding_stats.newly_coded} 条，缓存 ${d.coding_stats.cached} 条${d.coding_stats.quote_rejected ? `，${d.coding_stats.quote_rejected} 条原话不在原文里已丢弃` : ''}${d.coding_stats.target_downgraded ? `，${d.coding_stats.target_downgraded} 条指向被兜底规则从本机构降为无法判断` : ''}）｜研判 ${config.models.report}｜评测 ${config.models.judge}｜抓取失败 ${d.fetch_errors.length} 篇${d.coding_stats.batch_errors.length ? `｜编码批次错误 ${d.coding_stats.batch_errors.length}` : ''}</sub>
`;

// ---------- 新状态 ----------
const firstSeen = { ...d.state.first_seen };
for (const n of d.notes) if (!firstSeen[n.note_id]) firstSeen[n.note_id] = run.run_at;
const snapshots = [...d.state.snapshots, { run_at: run.run_at, notes: Object.fromEntries(d.notes.map(n => [n.note_id, n.interact_total])) }].slice(-60);
// 编码缓存只留最近见过的笔记下的记录，防止无限增长
const keepNotes = new Set(snapshots.flatMap(s => Object.keys(s.notes)));
const codedKeep = Object.fromEntries(Object.entries(d.coded_all).filter(([rid]) => {
  const r = byRid[rid];
  return !r || keepNotes.has(r.note_id);
}).slice(-8000));
const newState = { updated_at: run.run_at, snapshots, coded: codedKeep, first_seen: firstSeen };

const evaluation = { grade, score: finalScore, model_total: total, dims, rule_checks: rc.rule_checks, hard_stops: hardStops, issues: judge?.issues || [], strengths: judge?.strengths || [], agreement, disagreements, judge_error: judgeError };
const runRecord = { run, config, metrics, report: R, evaluation, coding_stats: d.coding_stats, fetch_errors: d.fetch_errors, search_log: d.search_log, records: d.records };
// n8n 写文件不会建子目录，所以每次运行的文件平铺在 runs/ 下，用时间前缀区分
const dir = `${run.run_id.slice(0, 10)}_${run.run_id.slice(11, 16).replace(/-/g, '')}`;

return [
  { json: { kind: 'report', path: `runs/${dir}_研判报告.md`, text: md } },
  { json: { kind: 'latest', path: `latest.md`, text: md } },
  { json: { kind: 'run', path: `runs/${dir}_run.json`, text: JSON.stringify(runRecord, null, 2) } },
  { json: { kind: 'state', path: `state.json`, text: JSON.stringify(newState) } },
  { json: { kind: 'history', path: `runs/${dir}_summary.json`, text: JSON.stringify({ run_at: run.run_at, grade, score: finalScore, level: R?.level?.verdict, stage: R?.trend?.stage, risk: metrics.levels, negative_pct: metrics.emotion.negative_pct, relevant_records: metrics.emotion.n_records, agreement: agreement.overall, official_covered: !!metrics.official?.covered, comparisons: metrics.visibility?.comparison?.records ?? null, handoff: !!R?.handoff }) } },
];
