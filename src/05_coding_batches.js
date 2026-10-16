// 把待编码记录切批，每批拼成一个 DeepSeek 请求。
const PROMPT = __PROMPT_CODING__;
const d = $input.first().json;
const { config } = d;
const want = new Set(d.to_code_rids);
const todo = d.records.filter(r => want.has(r.rid));
const noteText = Object.fromEntries(d.records.filter(r => r.kind === '笔记').map(r => [r.note_id, r.text.slice(0, 200)]));
const noteIp = Object.fromEntries(d.notes.map(n => [n.note_id, n.ip]));

const fill = s => s.replace(/\{\{(\w+)\}\}/g, (m, k) => config.prompt_vars[k] ?? m);
const system = fill(PROMPT);
const out = [];
for (let i = 0; i < todo.length; i += config.coding_batch_size) {
  const batch = todo.slice(i, i + config.coding_batch_size).map(r => ({
    rid: r.rid,
    kind: r.kind,
    note_type: r.kind === '笔记' ? r.note_type : undefined,
    note_context: r.kind === '笔记' ? undefined : noteText[r.note_id],
    text: r.text,
    ip: r.ip || undefined,
    note_ip: r.kind === '笔记' ? undefined : noteIp[r.note_id] || undefined,
  }));
  out.push({
    json: {
      batch_rids: batch.map(b => b.rid),
      body: {
        model: config.models.coding,
        reasoning_effort: 'low',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify({ records: batch }) },
        ],
      },
    },
  });
}
return out;
