// 借用户 Chrome 里的登录态取数据（OpenCLI 浏览器桥，agent-reach 带的那个）。cookie 不出浏览器，代码里也不存。
// 需要 Chrome 开着、OpenCLI 扩展已连接，B站 / 知乎在 Chrome 里登录着（opencli bilibili whoami / opencli zhihu whoami 可查）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// 版本更新提示会跟在 JSON 后面，只取第一段完整的 JSON
function firstJson(stdout, what) {
    const start = stdout.search(/[[{]/);
    if (start < 0) throw new Error(`${what} 没有返回 JSON：${stdout.slice(0, 200)}`);
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < stdout.length; i++) {
        const ch = stdout[i];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === "[" || ch === "{") depth++;
        else if ((ch === "]" || ch === "}") && --depth === 0) return JSON.parse(stdout.slice(start, i + 1));
    }
    throw new Error(`${what} 返回的 JSON 不完整`);
}

export async function opencli(args, { timeoutMs = 120000 } = {}) {
    const { stdout } = await run("opencli", args, { timeout: timeoutMs, maxBuffer: 64 << 20 });
    return firstJson(stdout, `opencli ${args.slice(0, 2).join(" ")}`);
}

// B站：在已登录的 B站标签页里发请求（带浏览器自己的 cookie），返回值和 bilibili.mjs 的 get 一样是 data 部分
export function bilibiliBrowserGet({ gapMs = 1000, session = "yuqing" } = {}) {
    let opened = false;
    let last = 0;
    return async function get(url) {
        if (!opened) {
            await run("opencli", ["browser", session, "open", "https://www.bilibili.com/"], { timeout: 60000 });
            opened = true;
        }
        const wait = last + gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        const js = `fetch(${JSON.stringify(url)},{credentials:'include'}).then(r=>r.json()).then(j=>JSON.stringify(j))`;
        const { stdout } = await run("opencli", ["browser", session, "eval", js], { timeout: 60000, maxBuffer: 64 << 20 });
        const j = firstJson(stdout, "B站浏览器请求");
        if (j.code !== 0) throw new Error(`B站接口 ${j.code} ${j.message || ""}`.trim());
        return j.data;
    };
}
