#!/usr/bin/env python3
"""把一次运行导出成可以公开的示例：研判报告、模型直出、指标、编码表、摘要。

用法：python3 tools/export_run.py data/runs/<id>_run.json data/runs/<id>_研判报告.md examples/<目录>/<id>

公开前做的处理：
- 小红书链接去掉 xsec_token 等查询参数（那是抓取时的访问令牌）
- 编码表只留标签和不超过 40 字的原话摘录，不放全文、用户哈希和 IP 属地
"""
import csv
import json
import re
import sys
from pathlib import Path

URL_QS = re.compile(r'(https://www\.xiaohongshu\.com/explore/[0-9a-f]+)\?[^)\s"]*')


def clean(text):
    return URL_QS.sub(r'\1', text)


def main(run_path, report_path, out_dir):
    run = json.loads(Path(run_path).read_text(encoding='utf-8'))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    (out / '研判报告.md').write_text(clean(Path(report_path).read_text(encoding='utf-8')), encoding='utf-8')

    ev = run.get('evaluation', {})
    machine = {
        'note': '研判模型（DeepSeek Flash）和评测模型（DeepSeek V4 Pro）的直出结果，未经人工改动',
        'run': run['run'],
        'report': run.get('report'),
        'evaluation': {k: ev.get(k) for k in ['grade', 'score', 'model_total', 'dims', 'rule_checks', 'hard_stops', 'strengths', 'issues', 'agreement', 'disagreements']},
    }
    (out / '模型直出.json').write_text(clean(json.dumps(machine, ensure_ascii=False, indent=2)), encoding='utf-8')
    (out / '指标.json').write_text(clean(json.dumps(run['metrics'], ensure_ascii=False, indent=2)), encoding='utf-8')
    summary = {'run': run['run'], 'search_log': run.get('search_log'), 'coding_stats': run.get('coding_stats'),
               'fetch_errors': run.get('fetch_errors'), 'config': {k: run['config'].get(k) for k in
               ['brand', 'decision_subject', 'keywords', 'window_days', 'max_notes_per_keyword', 'comment_limit', 'models', 'thresholds', 'coding_version', 'context_notes']}}
    (out / '运行摘要.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

    cols = ['记录', '类型', '笔记标题', '时间', '指向', '情感', '语气', '烈度', '话题', '高压线', '动员', '格式', '对比对象', '谁占上风', '原话摘录', '点赞', '笔记链接']
    with (out / '编码表.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in run['records']:
            c = r.get('code') or {}
            w.writerow([r['rid'], r['kind'], r.get('note_title', '')[:40], r.get('time', ''), c.get('target', '未编码'), c.get('sentiment', ''),
                        c.get('tone', ''), c.get('intensity', ''), '、'.join(c.get('topics', [])), '、'.join(c.get('high_voltage', [])),
                        c.get('mobilization', ''), c.get('format', ''), c.get('compare_with', ''), c.get('compare_side', ''),
                        (c.get('quote') or '')[:40], r.get('likes', 0), f"https://www.xiaohongshu.com/explore/{r['note_id']}"])
    print(f'{out}: {len(run["records"])} 条记录')


if __name__ == '__main__':
    main(*sys.argv[1:4])
