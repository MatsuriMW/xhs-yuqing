// 拼研判请求：只给指标和证据池，不给全量原文。
const PROMPT = __PROMPT_REPORT__;
const d = $input.first().json;
const { config } = d;
const fill = s => s.replace(/\{\{(\w+)\}\}/g, (m, k) => config.prompt_vars[k] ?? m);
const system = fill(PROMPT);
const { high_voltage_rids, ...contentNoRids } = d.metrics.content;
return [{
  json: {
    body: {
      model: config.models.report,
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ run: d.metrics.run, metrics: { ...d.metrics, content: { ...contentNoRids, high_voltage_rids } }, evidence: d.evidence }) },
      ],
    },
  },
}];
