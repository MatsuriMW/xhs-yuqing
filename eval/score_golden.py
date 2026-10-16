#!/usr/bin/env python3
"""用人工标注的金标集量编码准确率。

1. 先导出一份待标注表：python3 eval/score_golden.py export data/runs/<某次>/run.json > eval/golden.csv
   导出的表里模型的标签是空的，只有原文，人工按 framework/研判与评测体系.md 的定义填 target / sentiment / high_voltage（多个用 、 隔开）。
2. 标完后打分：python3 eval/score_golden.py score eval/golden.csv data/runs/<某次>/run.json
   按记录 ID 对齐，输出每个字段的准确率、Cohen's kappa 和混淆明细。
"""
import csv
import json
import sys
from collections import Counter

FIELDS = ["target", "sentiment", "high_voltage"]


def load_run(path):
    run = json.load(open(path, encoding="utf-8"))
    return {r["rid"]: r for r in run["records"]}


def export(run_path):
    recs = load_run(run_path)
    w = csv.writer(sys.stdout)
    w.writerow(["rid", "kind", "note_title", "text", "url"] + FIELDS)
    for r in recs.values():
        if r.get("code"):
            w.writerow([r["rid"], r["kind"], r["note_title"], r["text"].replace("\n", " "), r["url"], "", "", ""])


def norm(field, v):
    if field == "high_voltage":
        if isinstance(v, list):
            return "、".join(sorted(v)) or "无"
        return "、".join(sorted(x for x in str(v).replace(",", "、").split("、") if x.strip())) or "无"
    return str(v).strip()


def kappa(pairs):
    n = len(pairs)
    if not n:
        return None
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def score(golden_path, run_path):
    recs = load_run(run_path)
    rows = [r for r in csv.DictReader(open(golden_path, encoding="utf-8")) if r.get("target", "").strip()]
    print(f"已标注 {len(rows)} 条")
    for f in FIELDS:
        pairs = [(norm(f, r[f]), norm(f, recs[r["rid"]]["code"][f])) for r in rows if r["rid"] in recs and recs[r["rid"]].get("code")]
        if not pairs:
            continue
        acc = sum(a == b for a, b in pairs) / len(pairs)
        k = kappa(pairs)
        print(f"\n{f}: 准确率 {acc:.0%}  kappa {k:.2f}  (n={len(pairs)})")
        for (gold, pred), c in Counter(p for p in pairs if p[0] != p[1]).most_common(8):
            print(f"  人工 {gold} → 模型 {pred}: {c}")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "export":
        export(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "score":
        score(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
