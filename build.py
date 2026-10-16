#!/usr/bin/env python3
"""把 src/ 里的 Code 节点和提示词拼成 n8n 工作流 workflow.json。改完 src/ 重新跑一遍再导入。"""
import json
import uuid
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
DATA_DIR = str(ROOT / "data")
WORKFLOW_ID = "XsYuqingV2Chuwu1"

# 本机 n8n 里已有的凭据（见 credentials_entity）
CRED_MCP = {"mcpClientHttpApi": {"id": "2xALdm17IAsoIQ5k", "name": "MCP Client (STDIO) account 5"}}
CRED_DEEPSEEK = {"deepSeekApi": {"id": "Js5KqZ5jwM5sydKB", "name": "DeepSeek account"}}


def code(name):
    js = (SRC / name).read_text(encoding="utf-8")
    for key, file in [("__PROMPT_CODING__", "coding.md"), ("__PROMPT_REPORT__", "report.md"), ("__PROMPT_JUDGE__", "judge.md")]:
        if key in js:
            js = js.replace(key, json.dumps((SRC / "prompts" / file).read_text(encoding="utf-8"), ensure_ascii=False))
    return js


nodes = []


def node(name, type_, version, pos, params, **extra):
    n = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, WORKFLOW_ID + name)), "name": name, "type": type_,
         "typeVersion": version, "position": pos, "parameters": params}
    n.update(extra)
    nodes.append(n)
    return name


def code_node(name, file, pos, mode="runOnceForAllItems", **extra):
    return node(name, "n8n-nodes-base.code", 2, pos, {"mode": mode, "jsCode": code(file)}, **extra)


def deepseek(name, pos, timeout=300000):
    return node(name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": "POST",
        "url": "https://api.deepseek.com/chat/completions",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "deepSeekApi",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.body) }}",
        "options": {"timeout": timeout},
    }, credentials=CRED_DEEPSEEK, retryOnFail=True, maxTries=3, waitBetweenTries=5000, onError="continueRegularOutput")


def mcp(name, pos, tool, args):
    return node(name, "n8n-nodes-mcp.mcpClient", 1, pos, {
        "connectionType": "http", "operation": "executeTool", "toolName": tool, "toolParameters": args,
    }, credentials=CRED_MCP, retryOnFail=True, maxTries=2, waitBetweenTries=5000, onError="continueRegularOutput")


def sticky(name, pos, content, w, h, color=7):
    node(name, "n8n-nodes-base.stickyNote", 1, pos, {"content": content, "width": w, "height": h, "color": color})


x = 0
node("定时触发", "n8n-nodes-base.scheduleTrigger", 1.2, [x, 0],
     {"rule": {"interval": [{"field": "cronExpression", "expression": "0 9,18 * * *"}]}})
node("手动运行", "n8n-nodes-base.manualTrigger", 1, [x, 200], {})
code_node("配置", "01_config.js", [x + 240, 100])
# 社区版 MCP Client 节点一次只处理第一条输入，所以两处 MCP 调用都套 Loop Over Items 逐条喂
node("逐个关键词", "n8n-nodes-base.splitInBatches", 3, [x + 360, 100], {"batchSize": 1, "options": {}})
# 官方号走主页接口，关键词走搜索；两条路都回到「逐个关键词」，下游按顺序和「配置」的输出对上
node("是官方号吗", "n8n-nodes-base.if", 2.2, [x + 480, 300], {
    "conditions": {"options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
                   "conditions": [{"id": "is-profile", "leftValue": "={{ $json.kind }}", "rightValue": "profile",
                                   "operator": {"type": "string", "operation": "equals"}}],
                   "combinator": "and"},
    "looseTypeValidation": True, "options": {}})
mcp("抓取官方号主页", [x + 600, 460], "user_profile",
    '={{ JSON.stringify({ user_id: $json.account.user_id, xsec_token: $json.account.xsec_token }) }}')
mcp("搜索笔记", [x + 600, 300], "search_feeds",
    '={{ JSON.stringify(Object.keys($json.config.search_filters || {}).length ? { keyword: $json.keyword, filters: $json.config.search_filters } : { keyword: $json.keyword }) }}')
code_node("拆解笔记列表", "02_parse_feeds.js", [x + 720, 100])
node("逐篇笔记", "n8n-nodes-base.splitInBatches", 3, [x + 840, 100], {"batchSize": 1, "options": {}})
mcp("抓取详情和评论", [x + 960, 300], "get_feed_detail",
    "={{ JSON.stringify({ feed_id: $json.note_id, xsec_token: $json.xsec_token, load_all_comments: true, "
    "limit: $('配置').first().json.config.comment_limit, click_more_replies: $('配置').first().json.config.click_more_replies }) }}")
code_node("结构化", "03_structure.js", [x + 1200, 100])
node("读取状态", "n8n-nodes-base.readWriteFile", 1, [x + 1440, 100],
     {"operation": "read", "fileSelector": DATA_DIR + "/state.json", "options": {}},
     onError="continueRegularOutput", alwaysOutputData=True)
code_node("增量对比", "04_diff_state.js", [x + 1680, 100])
node("有新记录吗", "n8n-nodes-base.if", 2.2, [x + 1920, 100], {
    "conditions": {"options": {"caseSensitive": True, "typeValidation": "loose", "version": 2},
                   "conditions": [{"id": "has-new", "leftValue": "={{ $json.has_new }}", "rightValue": True,
                                   "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
                   "combinator": "and"},
    "looseTypeValidation": True, "options": {}})
code_node("切批", "05_coding_batches.js", [x + 2160, 0])
deepseek("编码 DeepSeek", [x + 2400, 0])
code_node("合并编码", "06_merge_coding.js", [x + 2640, 100])
code_node("聚合研判指标", "07_aggregate.js", [x + 2880, 100])
code_node("构造研判请求", "08_report_request.js", [x + 3120, 100])
deepseek("研判 DeepSeek", [x + 3360, 100], timeout=600000)
code_node("规则检查", "09_rule_check.js", [x + 3600, 100])
deepseek("评测 DeepSeek Pro", [x + 3840, 100], timeout=600000)
code_node("评级与报告", "10_finalize.js", [x + 4080, 100])
node("转成文件", "n8n-nodes-base.convertToFile", 1.1, [x + 4320, 100],
     {"operation": "toText", "sourceProperty": "text", "options": {"fileName": "={{ $json.path.split('/').pop() }}", "encoding": "utf8"}})
node("写入 data", "n8n-nodes-base.readWriteFile", 1, [x + 4560, 100],
     {"operation": "write", "fileName": "=" + DATA_DIR + "/{{ $('评级与报告').item.json.path }}", "options": {}})

sticky("说明", [x - 40, -380], (
    "## 小红书舆情研判 v2\n"
    "每天 9:00 / 18:00 搜关键词 → 抓笔记和评论 → 结构化 → DeepSeek Flash 逐条编码（指向、情感、语气、烈度、高压线、动员级别）"
    "（配了官方号就再抓它最近几篇笔记的评论区）→ 代码算三维度指标、公众看到的版本 → DeepSeek Flash 写研判和交接包 → 规则检查 + DeepSeek V4 Pro 打分和抽检 → 写进 data/。\n\n"
    "研判和评测标准改写自初五 Chuwu-PR-OS（MIT），见 framework/研判与评测体系.md。"
    "改品牌、关键词、行业话题和高压线、阈值、模型：打开「配置」节点。源码在 src/，改完跑 build.py 重新导入。"), 900, 300, 4)
sticky("评测说明", [x + 3560, -380], (
    "## 评测\n规则检查 R0–R15 由代码判（采集完整、窗口变化只引用窗口内记录、分档 / 阶段取值、引用 ID 真实、百分比来自指标、单平台交代缺口……）；"
    "V4 Pro 按 PR 输出质量七维度打分（舆情任务加权事实证据、公共语境、风险控制），同时盲重编码 12 条算一致率。"
    "最终等级取模型等级和规则封顶里更低的。"), 760, 300, 6)

chain = ["结构化", "读取状态", "增量对比", "有新记录吗"]
connections = {}


def link(a, b, out=0):
    connections.setdefault(a, {"main": []})
    while len(connections[a]["main"]) <= out:
        connections[a]["main"].append([])
    connections[a]["main"][out].append({"node": b, "type": "main", "index": 0})


link("定时触发", "配置")
link("手动运行", "配置")
# Loop Over Items：输出 0 = 全部做完，输出 1 = 下一条
link("配置", "逐个关键词")
link("逐个关键词", "拆解笔记列表", 0)
link("逐个关键词", "是官方号吗", 1)
link("是官方号吗", "抓取官方号主页", 0)
link("是官方号吗", "搜索笔记", 1)
link("抓取官方号主页", "逐个关键词")
link("搜索笔记", "逐个关键词")
link("拆解笔记列表", "逐篇笔记")
link("逐篇笔记", "结构化", 0)
link("逐篇笔记", "抓取详情和评论", 1)
link("抓取详情和评论", "逐篇笔记")
for a, b in zip(chain, chain[1:]):
    link(a, b)
link("有新记录吗", "切批", 0)
link("有新记录吗", "合并编码", 1)
for a, b in zip(["切批", "编码 DeepSeek", "合并编码", "聚合研判指标", "构造研判请求", "研判 DeepSeek", "规则检查",
                 "评测 DeepSeek Pro", "评级与报告", "转成文件", "写入 data"],
                ["编码 DeepSeek", "合并编码", "聚合研判指标", "构造研判请求", "研判 DeepSeek", "规则检查",
                 "评测 DeepSeek Pro", "评级与报告", "转成文件", "写入 data"]):
    link(a, b)

wf = {
    "id": WORKFLOW_ID,
    "name": "小红书舆情研判 v2（Chuwu 评测）",
    "nodes": nodes,
    "connections": connections,
    "active": False,
    "settings": {"executionOrder": "v1", "timezone": "Asia/Shanghai", "saveManualExecutions": True},
    "pinData": {},
}
out = ROOT / "workflow.json"
out.write_text(json.dumps([wf], ensure_ascii=False, indent=2), encoding="utf-8")
print(f"wrote {out} ({len(nodes)} nodes)")
