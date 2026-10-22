// 让 ../src 里给 n8n 写的 Code 节点原样跑在 LangGraph 里：业务代码只有一份，两种编排共用。
// 节点代码里用到的 n8n 全局只有三样：$input（上一步的输出）、$('节点名')（前面某一步的输出）、this.helpers（读文件）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PROMPTS = { __PROMPT_CODING__: "coding.md", __PROMPT_REPORT__: "report.md", __PROMPT_JUDGE__: "judge.md" };
const AsyncFunction = (async () => {}).constructor;

// 和 build.py 一样把提示词嵌进代码；platform 不是小红书时，把代码和提示词里写死的「小红书」换成它
export function loadCode(file, { platform = "小红书" } = {}) {
    let js = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const [key, f] of Object.entries(PROMPTS)) {
        if (js.includes(key)) js = js.replace(key, JSON.stringify(fs.readFileSync(path.join(SRC, "prompts", f), "utf8")));
    }
    return platform === "小红书" ? js : js.replaceAll("小红书", platform);
}

// 跑一个 Code 节点。input：上一步的 items；nodes：{ 节点名: items }；binary：读取状态那一步读到的文件内容；
// transform：跑之前改一下代码文本（只有配置节点用它注入品牌文件）
export async function runCode(file, { input = [{ json: {} }], nodes = {}, binary = null, platform, transform = (js) => js } = {}) {
    // 04 增量对比靠 item.binary 判断有没有读到状态文件
    if (binary) input = [{ json: {}, binary: { data: {} } }];
    const $input = { all: () => input, first: () => input[0] };
    const $ = (name) => {
        if (!nodes[name]) throw new Error(`节点「${name}」还没有输出`);
        return { all: () => nodes[name], first: () => nodes[name][0] };
    };
    const ctx = { helpers: { getBinaryDataBuffer: async () => binary } };
    const fn = new AsyncFunction("$input", "$", transform(loadCode(file, { platform })));
    return fn.call(ctx, $input, $);
}
