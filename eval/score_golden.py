#!/usr/bin/env python3
"""用人工标注的金标集量编码准确率。

1. 分层抽样导出待标注表（模型的标签不出现在表里，盲标）：
   python3 eval/score_golden.py export data/runs/<A>_run.json data/runs/<B>_run.json ... [--n 300] [--seed 17]
   多次运行按记录 ID 去重，同一条取最后一次的编码；只收当前 coding_version 的编码。
   写出 eval/golden.csv（待标注表）、eval/golden_sample.json（抽样层、权重和模型标签快照）、eval/golden_标注说明.md。
2. 标的过程中随时检查有没有填错：python3 eval/score_golden.py check eval/golden.csv
3. 标完（或标了一部分）打分：python3 eval/score_golden.py score eval/golden.csv
   「指向」填了的行才算标过。输出各字段准确率、kappa、关键类别的精确率 / 召回率，
   和模型不一致的行写进 eval/golden_不一致.csv，复核后可以进回归集。

抽样按模型标签分层：高风险的层（笔记、碰了高压线、动员 ≥4）全收，其余按配额抽，所以每条带一个权重
（该层总数 / 该层抽到的数）。「样本内」是 300 条里的直接比例，「按总体加权」是把抽样偏差纠回来之后、
对整个样本池的估计；评价工作流实际表现看加权的那个。
"""
import csv
import json
import math
import random
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
SAMPLE_PATH = EVAL_DIR / "golden_sample.json"
GUIDE_PATH = EVAL_DIR / "golden_标注说明.md"
DIFF_PATH = EVAL_DIR / "golden_不一致.csv"

TARGETS = ["本机构", "同名或其他机构", "泛讨论", "无法判断"]
SENTIMENTS = ["正面", "中性", "负面", "混合"]
SIDES = ["本机构占上风", "本机构落下风", "不分高下", "无对比"]
# 标注时可以只写简称
ALIASES = {
    "target": {"本": "本机构", "他": "同名或其他机构", "别": "同名或其他机构", "同": "同名或其他机构", "泛": "泛讨论", "无": "无法判断"},
    "sentiment": {"正": "正面", "中": "中性", "负": "负面", "混": "混合"},
    "compare_side": {"上": "本机构占上风", "下": "本机构落下风", "平": "不分高下", "无": "无对比"},
}
# 表头：内部字段 → 标注表里的列名
LABEL_COLS = {"target": "指向", "sentiment": "情感", "high_voltage": "高压线", "mobilization": "动员", "compare_side": "谁占上风"}
INFO_COLS = ["序号", "rid", "类型", "笔记标题", "上层评论", "原文", "链接"]

# 分层：按顺序判，先命中的算。quota=None 全收；最后一层拿剩下的名额
STRATA = [
    ("笔记", lambda r: r["kind"] == "笔记", None),
    ("高压线", lambda r: bool(r["code"]["high_voltage"]), None),
    ("动员≥4", lambda r: r["code"]["mobilization"] >= 4, None),
    ("非本机构", lambda r: r["code"]["target"] != "本机构", 50),
    ("有对比", lambda r: r["code"].get("compare_side", "无对比") != "无对比", 40),
    ("负面或混合", lambda r: r["code"]["sentiment"] in ("负面", "混合"), 50),
    ("其余", lambda r: True, None),
]

# 达标线：错把别家算成自己，后面所有统计都偏；高压线和高动员漏报的代价最大
BARS = [
    ("指向「本机构」精确率", 0.95),
    ("高压线（有 / 无）召回率", 0.90),
    ("动员 ≥5 召回率", 0.90),
]


# ---------- 导出 ----------

def load_pool(run_paths):
    pool, parents, config, version = {}, {}, None, None
    for p in run_paths:
        run = json.load(open(p, encoding="utf-8"))
        config = run["config"]
        version = config.get("coding_version")
        for r in run["records"]:
            parents[r["rid"]] = r["text"]
            c = r.get("code")
            if c and (version is None or c.get("v") == version):
                pool[r["rid"]] = r
    return pool, parents, config, version


def stratum_of(r):
    for name, pred, _ in STRATA:
        if pred(r):
            return name


def one_line(s, limit=None):
    s = " ".join(str(s or "").split())
    return s if limit is None or len(s) <= limit else s[:limit] + "…"


def export(run_paths, n, seed):
    pool, parents, config, version = load_pool(run_paths)
    groups = defaultdict(list)
    for r in sorted(pool.values(), key=lambda r: r["rid"]):
        groups[stratum_of(r)].append(r)

    rng = random.Random(seed)
    picked, strata = [], {}
    left = n
    for i, (name, _, quota) in enumerate(STRATA):
        g = groups.get(name, [])
        last = i == len(STRATA) - 1
        k = len(g) if (quota is None and not last) else min(len(g), left if last else quota)
        k = max(0, min(k, left))
        take = rng.sample(g, k) if k < len(g) else list(g)
        left -= len(take)
        picked += [(name, r) for r in take]
        strata[name] = {"pool": len(g), "sampled": len(take), "weight": round(len(g) / len(take), 4) if take else None}
    rng.shuffle(picked)

    csv_path = EVAL_DIR / "golden.csv"
    if csv_path.exists() and any(r.get("指向", "").strip() for r in read_rows(csv_path)):
        sys.exit(f"{csv_path} 里已经有标注了，先挪走再导出，免得覆盖")

    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(INFO_COLS + list(LABEL_COLS.values()) + ["备注"])
        for i, (name, r) in enumerate(picked, 1):
            parent = parents.get(r.get("parent"), "") if r["kind"] == "回复" else ""
            w.writerow([i, r["rid"], r["kind"], one_line(r["note_title"]), one_line(parent, 200), one_line(r["text"]), r["url"]] + [""] * (len(LABEL_COLS) + 1))

    sample = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "brand": config.get("brand"),
        "coding_version": version,
        "source_runs": [str(p) for p in run_paths],
        "seed": seed,
        "pool_size": len(pool),
        "strata": strata,
        "high_voltage_names": list(config["industry"]["high_voltage"].keys()),
        "records": {
            r["rid"]: {
                "stratum": name,
                "weight": strata[name]["weight"],
                "model": {k: r["code"].get(k) for k in LABEL_COLS} | {"note": r["code"].get("note", "")},
                "model_raw_target": "本机构" if r["code"].get("target_adjusted") else r["code"]["target"],
            }
            for name, r in picked
        },
    }
    json.dump(sample, open(SAMPLE_PATH, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    GUIDE_PATH.write_text(guide(config), encoding="utf-8")

    print(f"样本池 {len(pool)} 条（{config.get('brand')}，编码版本 {version}，来自 {len(run_paths)} 次运行），抽 {len(picked)} 条")
    for name, s in strata.items():
        print(f"  {name}: 池 {s['pool']} → 抽 {s['sampled']}，权重 {s['weight']}")
    print(f"待标注表 {csv_path}\n标注说明 {GUIDE_PATH}")


def guide(config):
    ind = config["industry"]
    hv = "\n".join(f"- **{k}**：{v}" for k, v in ind["high_voltage"].items())
    mob = ind.get("mobilization", {})
    notes = "\n".join(f"- {x}" for x in config.get("context_notes", [])) or "- （无）"
    return f"""# 金标集标注说明（{config.get('brand')}）

表是盲标的：模型的标签不在表里，照自己的判断填。用 Numbers 或 Excel 打开 `golden.csv`，填完存回 CSV（UTF-8）。
行已经打乱，不用按顺序标完，**「指向」填了的行才算标过**，标一部分也能先打分。

## 每行填什么

| 列 | 怎么填 | 可以只写 |
| --- | --- | --- |
| 指向 | 本机构 / 同名或其他机构 / 泛讨论 / 无法判断 | 本 / 他 / 泛 / 无 |
| 情感 | 正面 / 中性 / 负面 / 混合 | 正 / 中 / 负 / 混 |
| 高压线 | 下面的名称，多个用 、 隔开；没碰就空着 | 空 = 无 |
| 动员 | 0–6 的数字 | 空 = 0 |
| 谁占上风 | 本机构占上风 / 本机构落下风 / 不分高下 / 无对比 | 上 / 下 / 平 / 无，空 = 无对比 |
| 备注 | 拿不准、或想记一句为什么 | |

**指向不是「本机构」的行，后面四列不用填**：统计只算本机构的记录，别家的情感、高压线不影响结果。

## 指向

{config.get('target_rule')}

评论自己没给线索时，看「笔记标题」和「上层评论」：继承所在笔记或上层评论的指向。实在看不出来就标「无法判断」，**宁可无法判断，也别把别人的事算到本机构头上**。

## 高压线（只标本机构自己碰到的）

{hv}

拿别家的事故、缺陷来和本机构对比，或者嘲讽别家的，高压线空着，「谁占上风」照实填。

## 动员

0 没有动员；1 私下反馈（{mob.get(1, mob.get('1', ''))}）；2 公开喊话；3 组织化协同（拉群、组团维权）；4 晒证据做素材；5 行动施压（{mob.get(5, mob.get('5', ''))}）；6 找第三方（{mob.get(6, mob.get('6', ''))}）。

## 人工核实过的背景

{notes}

## 填完之后

```bash
python3 eval/score_golden.py check eval/golden.csv   # 查填错的值
python3 eval/score_golden.py score eval/golden.csv   # 打分
```
"""


# ---------- 读表、校验 ----------

def read_rows(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def norm_choice(field, v, choices):
    v = str(v or "").strip()
    if v in choices:
        return v
    if v in ALIASES.get(field, {}):
        return ALIASES[field][v]
    hits = [c for c in choices if c.startswith(v)] if v else []
    return hits[0] if len(hits) == 1 else None


def parse_row(row, hv_names):
    """返回 (标签, 错误列表)。指向没填返回 (None, [])。"""
    raw = {f: (row.get(col) or "").strip() for f, col in LABEL_COLS.items()}
    if not raw["target"]:
        return None, []
    errs, lab = [], {}
    lab["target"] = norm_choice("target", raw["target"], TARGETS)
    if not lab["target"]:
        errs.append(f"指向「{raw['target']}」不认识")
    if lab["target"] != "本机构":
        return lab, errs
    lab["sentiment"] = norm_choice("sentiment", raw["sentiment"], SENTIMENTS)
    if not lab["sentiment"]:
        errs.append("情感没填" if not raw["sentiment"] else f"情感「{raw['sentiment']}」不认识")
    parts = [p.strip() for p in raw["high_voltage"].replace("，", "、").replace(",", "、").replace(" ", "、").split("、") if p.strip() and p.strip() != "无"]
    bad = [p for p in parts if p not in hv_names]
    if bad:
        errs.append(f"高压线「{'、'.join(bad)}」不在 {'/'.join(hv_names)} 里")
    lab["high_voltage"] = sorted(p for p in parts if p in hv_names)
    m = raw["mobilization"] or "0"
    if m.isdigit() and 0 <= int(m) <= 6:
        lab["mobilization"] = int(m)
    else:
        errs.append(f"动员「{m}」要填 0–6")
    lab["compare_side"] = norm_choice("compare_side", raw["compare_side"] or "无对比", SIDES)
    if not lab["compare_side"]:
        errs.append(f"谁占上风「{raw['compare_side']}」不认识")
    return lab, errs


def load_labels(csv_path, sample):
    hv_names = sample["high_voltage_names"]
    labels, problems = {}, []
    for row in read_rows(csv_path):
        lab, errs = parse_row(row, hv_names)
        if errs:
            problems.append((row.get("序号"), row.get("rid"), errs))
        elif lab and row["rid"] in sample["records"]:
            labels[row["rid"]] = lab
    return labels, problems


def check(csv_path):
    sample = json.load(open(SAMPLE_PATH, encoding="utf-8"))
    labels, problems = load_labels(csv_path, sample)
    total = len(read_rows(csv_path))
    print(f"已标 {len(labels) + len(problems)} / {total} 条，其中 {len(problems)} 条有问题")
    for no, rid, errs in problems:
        print(f"  序号 {no}（{rid}）：{'；'.join(errs)}")


# ---------- 打分 ----------

def kappa(pairs):
    n = len(pairs)
    if not n:
        return None
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def wilson(k, n, z=1.96):
    if not n:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h


def pct(x):
    return "—" if x is None else f"{x:.0%}"


def acc_line(items):
    """items: [(人工, 模型, 权重)]"""
    n = len(items)
    k = sum(g == p for g, p, _ in items)
    wsum = sum(w for *_, w in items)
    wacc = sum(w for g, p, w in items if g == p) / wsum if wsum else None
    lo, hi = wilson(k, n) or (None, None)
    kp = kappa([(g, p) for g, p, _ in items])
    few = "，样本少，只看方向" if n < 30 else ""
    return f"样本内 {pct(k / n if n else None)}（{k}/{n}，95% 区间 {pct(lo)}–{pct(hi)}）· 按总体加权 {pct(wacc)} · kappa {'—' if kp is None else f'{kp:.2f}'}{few}"


def pr(items, positive):
    """items: [(人工, 模型, 权重)]，positive(x) 判正类。返回 (精确率, 召回率, 人工正类数, 模型正类数)，都按权重算"""
    tp = sum(w for g, p, w in items if positive(g) and positive(p))
    pp = sum(w for g, p, w in items if positive(p))
    gp = sum(w for g, p, w in items if positive(g))
    n_g = sum(1 for g, _, _ in items if positive(g))
    n_p = sum(1 for _, p, _ in items if positive(p))
    return (tp / pp if pp else None), (tp / gp if gp else None), n_g, n_p


def confusion(items, top=6):
    lines = []
    for (g, p), c in Counter((g, p) for g, p, _ in items if g != p).most_common(top):
        lines.append(f"    人工 {g} → 模型 {p}：{c}")
    return lines


def show(v):
    return "、".join(v) or "无" if isinstance(v, list) else str(v)


def score(csv_path):
    sample = json.load(open(SAMPLE_PATH, encoding="utf-8"))
    recs = sample["records"]
    labels, problems = load_labels(csv_path, sample)
    out = [f"# 金标评分（{sample['brand']}，编码版本 {sample['coding_version']}）", ""]
    out.append(f"已标 {len(labels)} / {len(recs)} 条（样本池 {sample['pool_size']} 条，抽样 {sample['created']}）")
    if problems:
        out.append(f"另有 {len(problems)} 条填写有问题没算进来，跑 check 看是哪几条")
    if not labels:
        print("\n".join(out))
        return

    W = {rid: recs[rid]["weight"] for rid in labels}
    M = {rid: recs[rid]["model"] for rid in labels}
    results, diffs = {}, []

    # 指向：全部已标的行
    t = [(labels[r]["target"], M[r]["target"], W[r]) for r in labels]
    p, rc, ng, npred = pr(t, lambda x: x == "本机构")
    results["指向「本机构」精确率"] = p
    out += ["", "## 指向", f"- 准确率：{acc_line(t)}",
            f"- 「本机构」精确率 {pct(p)} · 召回率 {pct(rc)}（人工判本机构 {ng} 条，模型判 {npred} 条；加权）"]
    out += confusion(t)
    raw = [(labels[r]["target"], recs[r]["model_raw_target"], W[r]) for r in labels]
    if any(recs[r]["model_raw_target"] != M[r]["target"] for r in labels):
        p0, _, _, _ = pr(raw, lambda x: x == "本机构")
        out.append(f"- 代码兜底之前模型自己的「本机构」精确率 {pct(p0)}，兜底之后 {pct(p)}")
    diffs += [(r, "指向", labels[r]["target"], M[r]["target"]) for r in labels if labels[r]["target"] != M[r]["target"]]

    # 其余字段：只算人工判本机构的行（统计只用这些）
    own = [r for r in labels if labels[r]["target"] == "本机构" and len(labels[r]) > 1]
    out += ["", f"以下只算人工判为本机构的 {len(own)} 条（统计只用本机构的记录）"]

    for f, name in (("sentiment", "情感"), ("compare_side", "谁占上风")):
        items = [(labels[r][f], M[r][f], W[r]) for r in own]
        out += ["", f"## {name}", f"- 准确率：{acc_line(items)}"]
        if f == "sentiment":
            p, rc, ng, npred = pr(items, lambda x: x in ("负面", "混合"))
            out.append(f"- 负面（含混合）精确率 {pct(p)} · 召回率 {pct(rc)}（人工 {ng} 条，模型 {npred} 条）")
        out += confusion(items)
        diffs += [(r, name, labels[r][f], M[r][f]) for r in own if labels[r][f] != M[r][f]]

    hv = [(labels[r]["high_voltage"], sorted(M[r]["high_voltage"] or []), W[r]) for r in own]
    p, rc, ng, npred = pr(hv, bool)
    results["高压线（有 / 无）召回率"] = rc
    out += ["", "## 高压线", f"- 完全一致：{acc_line([(show(g), show(m), w) for g, m, w in hv])}",
            f"- 有 / 无：精确率 {pct(p)} · 召回率 {pct(rc)}（人工标了 {ng} 条，模型标了 {npred} 条）"]
    for name in sample["high_voltage_names"]:
        p1, r1, g1, p1n = pr(hv, lambda x, name=name: name in x)
        if g1 or p1n:
            out.append(f"    {name}：精确率 {pct(p1)} · 召回率 {pct(r1)}（人工 {g1}，模型 {p1n}）")
    diffs += [(r, "高压线", show(labels[r]["high_voltage"]), show(sorted(M[r]["high_voltage"] or []))) for r in own
              if labels[r]["high_voltage"] != sorted(M[r]["high_voltage"] or [])]

    mob = [(labels[r]["mobilization"], int(M[r]["mobilization"] or 0), W[r]) for r in own]
    p, rc, ng, npred = pr(mob, lambda x: x >= 5)
    results["动员 ≥5 召回率"] = rc
    near = sum(w for g, m, w in mob if abs(g - m) <= 1) / sum(w for *_, w in mob) if mob else None
    p1, r1, g1, n1 = pr(mob, lambda x: x >= 1)
    out += ["", "## 动员", f"- 级别完全一致：{acc_line(mob)}", f"- 差一级以内（加权）{pct(near)}",
            f"- 有动员（≥1）：精确率 {pct(p1)} · 召回率 {pct(r1)}（人工 {g1}，模型 {n1}）",
            f"- 动员 ≥5：精确率 {pct(p)} · 召回率 {pct(rc)}（人工 {ng}，模型 {npred}）"]
    out += confusion(mob)
    diffs += [(r, "动员", labels[r]["mobilization"], M[r]["mobilization"]) for r in own if labels[r]["mobilization"] != int(M[r]["mobilization"] or 0)]

    out += ["", "## 达标线"]
    for name, bar in BARS:
        v = results.get(name)
        verdict = "数据不够" if v is None else ("达标" if v >= bar else "未达标")
        out.append(f"- {name} ≥ {bar:.0%}：{pct(v)}，{verdict}")

    rows = {r["rid"]: r for r in read_rows(csv_path)}
    with open(DIFF_PATH, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["序号", "rid", "字段", "人工", "模型", "抽样层", "原文", "笔记标题", "上层评论", "模型的理由", "人工备注", "链接"])
        for rid, field, g, m in sorted(diffs, key=lambda d: int(rows[d[0]]["序号"])):
            row = rows[rid]
            w.writerow([row["序号"], rid, field, g, m, recs[rid]["stratum"], row["原文"], row["笔记标题"], row["上层评论"],
                        M[rid].get("note", ""), row.get("备注", ""), row["链接"]])
    out += ["", f"不一致的 {len(diffs)} 处写进了 {DIFF_PATH.name}，复核后可以进回归集"]
    print("\n".join(out))


if __name__ == "__main__":
    args = sys.argv[1:]
    opts = {"--n": 300, "--seed": 17}
    for k in list(opts):
        if k in args:
            i = args.index(k)
            opts[k] = int(args[i + 1])
            del args[i:i + 2]
    if len(args) >= 2 and args[0] == "export":
        export(args[1:], opts["--n"], opts["--seed"])
    elif len(args) == 2 and args[0] == "check":
        check(args[1])
    elif len(args) == 2 and args[0] == "score":
        score(args[1])
    else:
        print(__doc__)
