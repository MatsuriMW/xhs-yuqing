// DeepSeek 调用：请求体就是 ../src 拼好的 body，返回原样的接口 JSON，和 n8n 的 HTTP 节点一致。
// 和 n8n 一样失败重试 3 次、间隔 5 秒，最后仍失败就返回 { error }，交给下游的宽松解析兜底，不让整条流程停下。
import { execFileSync } from "node:child_process";

let KEY = process.env.DEEPSEEK_API_KEY;
export function deepseekKey() {
    if (!KEY) KEY = execFileSync("security", ["find-generic-password", "-s", "deepseek-api-key", "-w"]).toString().trim();
    return KEY;
}

// 同时最多 6 个请求（编码批次是并行扇出的）
let active = 0;
const waiting = [];
async function slot(fn) {
    if (active >= 6) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

export async function deepseek(body, { tries = 3, timeoutMs = 300000 } = {}) {
    return slot(async () => {
        let last;
        for (let i = 0; i < tries; i++) {
            const t0 = Date.now();
            try {
                const r = await fetch("https://api.deepseek.com/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekKey()}` },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                const j = await r.json();
                if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
                return { ...j, _ms: Date.now() - t0 };
            } catch (e) {
                last = e;
                if (i < tries - 1) await new Promise((r) => setTimeout(r, 5000));
            }
        }
        return { error: { message: String(last?.message || last) } };
    });
}
