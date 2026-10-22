// 飞书群机器人通知（自定义机器人 Webhook）。
// 配置：在飞书群里加「自定义机器人」，复制 Webhook 地址；安全设置选「签名校验」时再复制密钥。存进钥匙串：
//   security add-generic-password -a "$USER" -s feishu-bot-webhook -w     （回车后粘贴地址）
//   security add-generic-password -a "$USER" -s feishu-bot-secret -w      （没开签名校验可以不存）
// 也可以用环境变量 FEISHU_WEBHOOK / FEISHU_SECRET。没配置时只写卡片预览，不发。
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const keychain = (service) => {
    try { return execFileSync("security", ["find-generic-password", "-s", service, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; }
};
export const feishuConfig = () => ({
    webhook: process.env.FEISHU_WEBHOOK || keychain("feishu-bot-webhook"),
    secret: process.env.FEISHU_SECRET || keychain("feishu-bot-secret"),
});

// 飞书签名：以「时间戳 + 换行 + 密钥」为 key，对空串做 HmacSHA256，再 base64
export const sign = (timestamp, secret) => crypto.createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");

const LEVEL_RANK = { "传播证据不足，暂不可分档": 0, 尚未形成舆情: 1, 舆情前夜: 2, 已形成舆情: 3 };

// 要不要「需要关注」：分档到了舆情前夜以上、事件模式、高敏比前一窗口多、分档比上一次运行高，任一条就算
export function alertOf(run, mode) {
    const m = run.metrics;
    const verdict = run.report?.level?.verdict;
    const prev = (m.history || []).at(-1);
    const reasons = [];
    if (LEVEL_RANK[verdict] >= 2) reasons.push(`分档「${verdict}」`);
    if (mode?.mode === "事件") reasons.push(`事件模式：${mode.event}`);
    if (m.change.high_voltage > m.change.prev_window_high_voltage) reasons.push(`高敏 ${m.change.prev_window_high_voltage} → ${m.change.high_voltage} 条`);
    if (prev?.level && LEVEL_RANK[verdict] > LEVEL_RANK[prev.level]) reasons.push(`分档比上次（${prev.level}）高`);
    return { alert: reasons.length > 0, reasons };
}

const plain = (s, n = 160) => {
    const t = String(s || "").replace(/\s*\[r:[^\]]*\]/g, "").replace(/（\[c_[^)]*\)）/g, "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
};

// 卡片：先结论，再数字、平台、下一步、自查、历次走势
export function buildCard({ run, mode, cost, reportPath, reviewCommand }) {
    const { config: c, metrics: m, report: R, evaluation: ev } = run;
    const { alert, reasons } = alertOf(run, mode);
    const counts = m.platform_plan?.counts || {};
    const lines = [
        `**结论**：${R?.level?.verdict || "（研判没生成）"}｜${R?.trend?.stage || "—"}｜${mode ? `${mode.mode}模式${mode.event ? `：${plain(mode.event, 40)}` : ""}` : "未判断模式"}`,
        alert ? `**为什么提醒**：${reasons.join("；")}` : "",
        R?.level?.reason ? `**依据**：${plain(R.level.reason)}` : "",
        `**过去 ${m.window}**：相关 ${m.change.records} 条（前一窗口 ${m.change.prev_window_records}），负面 ${m.change.negative}，高敏 ${m.change.high_voltage}；负面占比 ${m.emotion.negative_pct}%`,
        Object.keys(counts).length ? `**平台**：${Object.entries(counts).map(([p, x]) => `${p} ${x.records} 条（窗口内相关 ${x.relevant_in_window}，负面 ${x.negative_pct ?? "—"}%）`).join("；")}${m.platform_plan ? `；主平台 ${m.platform_plan.acting_primary}` : ""}` : "",
        R?.business?.next_step ? `**下一步**：${plain(R.business.next_step, 80)}${R.business.next_step_reason ? `——${plain(R.business.next_step_reason, 100)}` : ""}` : "",
        (R?.business?.self_check || []).length ? `**要自查**：\n${R.business.self_check.slice(0, 3).map((x) => `- ${plain(x, 70)}`).join("\n")}` : "",
        (m.history || []).length ? `**历次**：${m.history.slice(-4).map((h) => `${h.run_at.slice(5, 10)} ${h.level || "—"}·负面${h.negative_pct ?? "—"}%`).join(" → ")} → 本次` : "",
    ].filter(Boolean);
    const foot = [`评测 ${ev.grade}（${ev.score} 分）`, `规则 ${ev.rule_checks.filter((x) => x.pass).length}/${ev.rule_checks.length}`, cost ? `${Math.round(cost.total / 1000)}k tokens` : "", reportPath ? `报告：${reportPath}` : ""].filter(Boolean).join("｜");
    return {
        msg_type: "interactive",
        card: {
            header: { template: alert ? "red" : "green", title: { tag: "plain_text", content: `${alert ? "🔴" : "🟢"} ${c.brand}舆情｜${alert ? "需要关注" : "日常简报"}${reviewCommand ? "（待复核）" : ""}` } },
            elements: [
                { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
                { tag: "hr" },
                { tag: "note", elements: [{ tag: "plain_text", content: reviewCommand ? `${foot}\n复核：${reviewCommand}` : foot }] },
            ],
        },
    };
}

export async function sendFeishu(payload, cfg = feishuConfig()) {
    if (!cfg.webhook) return { status: "未配置", hint: "钥匙串没有 feishu-bot-webhook，见 notify.mjs 开头" };
    const body = { ...payload };
    if (cfg.secret) {
        body.timestamp = String(Math.floor(Date.now() / 1000));
        body.sign = sign(body.timestamp, cfg.secret);
    }
    const r = await fetch(cfg.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    // 飞书成功返回 code 0（老接口是 StatusCode 0）
    return (j.code ?? j.StatusCode) === 0 ? { status: "已发送" } : { status: "发送失败", detail: JSON.stringify(j).slice(0, 200) };
}
