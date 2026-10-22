// 从本机 n8n 的执行记录里取出一次运行每一步的输出，存成 fixtures/<id>.json，给对拍测试和小红书离线重放用。
// 用法：node tools/extract-n8n-run.mjs 61
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { parse } from "flatted";

const id = Number(process.argv[2]);
if (!id) throw new Error("用法：node tools/extract-n8n-run.mjs <n8n 执行 id>");
const raw = execFileSync("sqlite3", [`${os.homedir()}/.n8n/database.sqlite`, `select data from execution_data where executionId=${id}`], { maxBuffer: 1 << 30 }).toString();
const runData = parse(raw).resultData.runData;
// 每个节点：每次执行的输出 items（只留 json，binary 只记有没有）
const out = {};
for (const [name, runs] of Object.entries(runData)) {
    out[name] = runs.map((r) => (r.data?.main?.[0] || []).map((it) => ({ json: it.json, ...(it.binary ? { binary: true } : {}) })));
}
fs.mkdirSync("fixtures", { recursive: true });
fs.writeFileSync(`fixtures/${id}.json`, JSON.stringify(out));
console.log(`fixtures/${id}.json`, Object.keys(out).length, "个节点");
