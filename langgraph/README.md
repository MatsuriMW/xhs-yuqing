# 舆情研判 · LangGraph 版

上一级目录的 n8n 工作流换成 LangGraph（JS）编排。**业务代码只有一份**：编码、三维度指标、19 条规则、评级都直接跑 `../src` 里给 n8n 写的那几个 Code 节点文件（`n8n.mjs` 模拟了它们用到的 `$input`、`$('节点名')`、`this.helpers` 三样东西）。n8n 版一行没改，两边可以并存。

LangGraph 版多出来的是编排层的事：

| | n8n 版 | LangGraph 版 |
| --- | --- | --- |
| 平台 | 只抓小红书 | 按品牌人群画像选主平台、分比重：小红书 / B站 / 知乎 |
| 研判模式 | 一种写法 | 先判断是「事件」还是「日常」，两种写法 |
| 编码批次 | 一批一批发 | `Send` 并行扇出，最多同时 6 个请求 |
| 规则没过 | 只扣分、封顶评级 | 带着没过的规则让模型返工，默认最多 2 次（条件边绕回） |
| 人工复核 | 事后改「配置」的 `context_notes`，下一轮生效 | 出报告前 `interrupt` 停下；打回时写回背景、当场重写研判 |
| 断点 | 失败从头跑 | 每步存检查点（SQLite），停在复核时进程可以退出，之后 `resume` 接着跑 |
| 运行记录 | n8n 界面里看 | 每次多写一份 `_graph.json`：路由、模式、每一稿没过哪些规则、用时、token 用量、复核动作、推送结果 |
| 换品牌 | 改 `01_config.js` 再 build、导入 | `--brand-file brands/xxx.json`，每个品牌一个输出目录 |
| 走势 | 只看本次和前一窗口 | 带上同一品牌之前 8 次的摘要（分档、负面占比、条数） |
| 通知 | 无 | 飞书群机器人，分「需要关注」和「日常简报」 |

LangChain 用在两处判断（都是结构化输出 + zod 校验）：人群画像（`router.mjs`）和研判模式（`modes.mjs`）。判断交给模型，判断之后怎么做由代码里的规则表定，结果可预期、可复核。

## 流程

```
config → route（画像 → 平台比重）→ fetch（各平台按比重抓）→ diff（增量）→ batches
  ⇉ code_batch × N（并行编码）→ merge → aggregate（三维度指标）→ judge_mode（事件 / 日常）
  → write_report ⇄ rule_check（没过就返工，≤ 2 次）→ judge（V4 Pro 打分）→ finalize（评级、报告）
  → review（停下等人：通过 → write；打回 → 写回背景 → write_report）→ write
```

## 按人群画像选平台（router.mjs）

1. 让模型判断品牌的主营消费群体：性别构成（女性为主 / 中性 / 男性为主）、是否本科及以上为主。
2. 平台和比重由规则表定，不让模型挑：
   - 本科及以上为主 → **知乎**为主
   - 否则女性为主 → **小红书**为主
   - 中性或男性为主 → **B站**为主
3. 主平台占 60%，另两个各 20%。比重用在两处：每个关键词取多少篇（三平台合计 15 篇：9 / 3 / 3），以及给研判模型的一段说明——分档、实质、走势以主平台为准，其他平台只作佐证、判断是否跨平台扩散。
4. 主平台这次抓不了（比如测试时不抓小红书），60% 的样本给按性别该选的那个平台，报告的证据缺口里写明是代替。

`--audience 女性为主,高学历` 跳过模型判断，直接指定画像。

## 给谁用、什么时候用

用的人是品牌公关、市场部（配置里的「决策主体」）。几种用法和这一版对应的东西：

| 场景 | 他要什么 | 怎么用 |
| --- | --- | --- |
| 日常值守（每天两次定时跑） | 没事别吵我，有事第一时间知道 | `--no-review --notify alert`：只在「需要关注」时推飞书；平时的结果照常落盘 |
| 出事了，盯走势 | 每几个小时看一次在升温还是降温 | `--mode 事件 --event "…"`；报告和推送带「历次」，和之前几次对比 |
| 换品牌、看竞品 | 不改代码 | `--brand-file brands/小米汽车.json`，每个品牌的增量、缓存、历次各自独立 |
| 结论要能用 | 先看一句话结论、下一步、要自查什么 | 推送卡片按「结论 → 为什么提醒 → 数字 → 平台 → 下一步 → 自查 → 历次」排 |
| 要知道靠不靠谱 | 覆盖了哪些平台、评分多少、花了多少 | 卡片底部有评测分、规则通过数、token 用量；报告证据缺口写明没覆盖的平台 |

「需要关注」的条件（`notify.mjs` 的 `alertOf`，规则表，不让模型定）：分档到「舆情前夜」以上、事件模式、高敏条数比前一窗口多、分档比上一次运行高，任一条成立。

## 事件模式和日常模式（modes.mjs）

指标算完后，把窗口变化、负面占比、高压线、动员等级、窗口内高赞内容的标题、各关键词搜索前列压成一段摘要，让模型判断：

- **事件**：有一件具体的事在近期集中引发讨论。研判侧重走势——窗口内围绕这件事新增了什么、阶段判断的依据、下一个窗口能观测到的升级 / 降温信号、回应前要先核实什么；无关的旧话题只作背景。
- **日常**：没有一件事在主导讨论。研判侧重常规体检——口碑基本面、公众看到的版本、潜在风险苗头、要自查的项目；不为了写走势硬造事件叙事。

模式只改研判模型拿到的写法要求，报告结构、规则检查、评分不变。`--mode 事件 --event "某某事"` 或 `--mode 日常` 直接指定。

## 数据源

- **B站**（`sources/bilibili.mjs`）：每个关键词按综合排序（公众先看到的，记排名）和按发布时间（窗口内的新视频）各取一份，视频当「笔记」处理。默认借 Chrome 的登录态在 B站页面里发请求（`sources/opencli.mjs`），评论每页 20 条、翻到 `comment_limit`、带 IP 属地；`--bili-anon` 改走不登录的公开接口，每个视频只有 3 条热评、没有属地。请求间隔 1 秒。
- **知乎**（`sources/zhihu.mjs`）：知乎搜索不登录直接 403，所以借 Chrome 的登录态，用 OpenCLI 的只读命令 `zhihu search` / `answer-detail` / `answer-comments`，在后台窗口里读。回答当「笔记」处理，标题用问题标题；专栏文章先跳过；知乎不给 IP 属地。每个回答约 13 秒，比 B站慢。
- **小红书**（`sources/xhs.mjs`）：和 n8n 版同样的调用顺序（逐词搜索 → 逐篇详情和评论），解析直接跑 `02`、`03`。取数分两级，都换成 xiaohongshu-mcp 的返回格式再交给解析：
  1. **AgentKey**（`sources/agentkey.mjs`，第三方数据接口，不用自己的账号）：搜索、图文 / 视频详情、一级评论（一页 10 条，带楼中楼和 IP 属地）各 2 积分。开抓前按「关键词数 + 篇数 × (1 + 评论页数)」估这一轮要多少积分，比如 3 个词各 3 篇、每篇 30 条评论（3 页）要 2 ×（3 + 9 × 4）= 78 积分；想省就在品牌文件里调小 `comment_limit`。密钥读环境变量 `AGENTKEY_TOKEN`，没有就读钥匙串 `agentkey-token`。
  2. **MediaCrawler**（`sources/mediacrawler.mjs`）：剩余积分不够这一轮，或者抓到一半返回 402，整轮换它重抓。它用自己的账号登录，**有风控风险**，所以量压到和 AgentKey 一样：每词只取路由给的篇数（它本来每个关键词至少抓满一页 20 篇，启动时截掉了），请求间隔 5 秒，不展开楼中楼。它存的数据没有 IP 属地。

  离线验证：n8n 第 61 次运行录下的 MCP 返回重放（`test/xhs-replay.test.mjs`）；AgentKey 一次真实返回（`test/xhs-agentkey.test.mjs`，数据在 `fixtures/agentkey/`）；MediaCrawler 按它的存储字段造的数据（`test/xhs-mediacrawler.test.mjs`）。

借登录态的两个平台要求 Chrome 开着、OpenCLI 扩展已连接、在 Chrome 里登录着（`opencli bilibili whoami`、`opencli zhihu whoami` 可查）。cookie 不出浏览器，代码里不存。用的是自己的账号，量大了可能被风控。

## 运行

```bash
npm install
node run.mjs                      # 按画像路由，默认真抓 B站 + 知乎，停在人工复核
node run.mjs resume <线程> --approve
node run.mjs resume <线程> --note "人工核实过的背景"
node run.mjs --live B站,知乎,小红书   # 小红书先走 AgentKey，积分不够换 MediaCrawler
node run.mjs --no-review --max-revisions 0
```

MediaCrawler 只在 AgentKey 积分不够时用，第一次用前装好并登录一次（用小号，别用被风控过的号）：

```bash
git clone https://github.com/NanmiCoder/MediaCrawler ~/claude/MediaCrawler   # 装在别处就设 MEDIACRAWLER_DIR
cd ~/claude/MediaCrawler && uv sync   # 用本机 Chrome（CDP 模式），不用装 Playwright 的浏览器
```

第一次跑到小红书时它会拉起一个独立的 Chrome（调试端口 9333，不碰 9222 上 Boss 直聘那个），在窗口里扫码登录；登录态存在 MediaCrawler 的 `browser_data/` 下，之后复用。

DeepSeek 密钥读环境变量 `DEEPSEEK_API_KEY`，没有就读钥匙串 `deepseek-api-key`。结果按品牌写在 `data/live/<品牌>/`（和 n8n 版同样的 `latest.md`、`runs/`、`state.json`，外加 `feishu-preview.json`），人工写回的背景在同一目录的 `context_notes.json`。跑完的线程会删掉检查点，只有停在复核的线程留着。

## 飞书推送（notify.mjs）

做到「填好 Webhook 就能用」为止，还没真发过：

1. 在飞书群里「设置 → 群机器人 → 添加机器人 → 自定义机器人」，复制 Webhook 地址；安全设置建议选「签名校验」，复制密钥。
2. 存进钥匙串（回车后粘贴，不进命令历史）：

   ```bash
   security add-generic-password -a "$USER" -s feishu-bot-webhook -w
   security add-generic-password -a "$USER" -s feishu-bot-secret -w
   ```

没配置时每次运行只写 `data/live/<品牌>/feishu-preview.json`（卡片预览，可以贴进飞书的卡片搭建工具看效果），终端提示「未配置」。`--notify always`（默认，每次都推，红绿区分）/ `alert`（只推需要关注的）/ `off`。

## 品牌文件（brands/）

JSON，写哪些字段就覆盖 `../src/01_config.js` 里的哪些：`brand`、`brand_context`、`decision_subject`、`target_rule`、`target_clues`、`keywords`、`context_notes`……`industry`、`thresholds` 只覆盖写了的键（同行业换品牌一般不用动）。换行业时要把 `industry` 的话题、高压线、动员说明一起写上。例子：`brands/小米汽车.json`。

## 和 n8n 拼起来用

两者不是非此即彼：n8n 擅长定时、连接器、看运行记录，LangGraph 擅长有循环、要停下等人、要断点续跑的那段。可以让 n8n 定时用 Execute Command 跑 `node run.mjs --no-review`，或者把 LangGraph 包成一个 HTTP 接口给 n8n 调，抓取和分发留在 n8n，研判这段交给 LangGraph。

## 验证

```bash
node tools/extract-n8n-run.mjs 61   # 从本机 n8n 取第 61 次运行每一步的输出 → fixtures/61.json（含小红书原文，不进仓库）
npm test                            # 对拍 + 小红书重放 + 路由规则表 + 品牌文件 / 提醒分级 / 飞书签名和卡片
node run.mjs --replay 61 --no-review --max-revisions 0   # 用同一份小红书数据跑整条流程，只调 DeepSeek
node tools/compare.mjs              # 汇总 n8n 和几次重放的结果
```

- **对拍**（`test/parity.test.mjs`）：02–10 每一步用 n8n 当时的输入重跑，输出逐字段和 n8n 记下的一致。
- **整条重放**：指标（`metrics`）和 n8n 当时完全一致；不同的只有模型写的研判和打分。

### 对比结果（2026-10-22，特斯拉 10-17 08:04 的小红书数据）

| 跑法 | 各稿没过的规则 | 最终没过 | 评级 / 分 | 分档 |
| --- | --- | --- | --- | --- |
| n8n（当时） | R4 | R4 | C / 83 | 舆情前夜 |
| LangGraph 返工上限 0 | 全过 | 无 | A / 88 | 尚未形成舆情 |
| LangGraph 返工上限 0 | R4 | R4 | C / 87 | 舆情前夜 |
| LangGraph 返工上限 0 | 全过 | 无 | A / 86 | 舆情前夜 |
| LangGraph 返工上限 2 | 全过 | 无 | B / 82 | 尚未形成舆情 |
| LangGraph 返工上限 2 | 全过 | 无 | B / 81 | 舆情前夜 |
| LangGraph 返工上限 2 | 全过 | 无 | A / 89 | 舆情前夜 |

- 7 份首稿里 2 份编了不存在的记录 ID（R4），不返工就被封顶 C 级。这批开着返工的 3 次首稿恰好都过了，返工没触发；B站那一轮（10-22）首稿没过 R4、R5、R15，返工一次后全过。返工的作用是出错时兜底，不是拉高平均分。
- 同一份数据，模型打分在 81–89 之间，分档在「舆情前夜」和「尚未形成舆情」之间摇摆。单次分数只说明过没过红线，不能拿来比两种编排谁写得好。
