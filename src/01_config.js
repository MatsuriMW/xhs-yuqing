// 配置：改关键词、阈值、模型都在这里。每个关键词输出一条，下游的「搜索笔记」逐条搜。
const config = {
  brand: '特斯拉',
  brand_context: '特斯拉（Tesla），美国电动车和能源公司；中国市场的销售、交付、售后和超充由特斯拉中国负责，上海超级工厂生产 Model 3 和 Model Y；产品还有 Model S、Model X、Cybertruck 和辅助驾驶（Autopilot / FSD）',
  decision_subject: '特斯拉中国品牌公关部',
  // 什么算「本机构」：编码和抽检复核共用这一条。宁可判无法判断，也别把别人的负面算到自己头上
  target_rule: '说的是特斯拉的车、门店、交付、售后、超充、软件和辅助驾驶、公司经营，或马斯克以特斯拉 CEO 身份的言行，算本机构；比较帖里对特斯拉有评价或提问的也算。物理学家尼古拉·特斯拉、磁感应强度单位「特斯拉」、特斯拉线圈，以及只谈 SpaceX、X、xAI 的，标同名或其他机构；只评价别的品牌（小米、比亚迪、理想、问界……）的，也标同名或其他机构。评论在自己没给出线索时，继承所在笔记的指向。',
  // 行业设定：换一家公司主要改这里（话题、高压线、动员说明、外推词），提示词和统计都从这里取
  industry: {
    name: '汽车',
    audience: '车主和潜在买家',
    audience_short: '车主',
    general_topic: '聊新能源车、汽车行业这件事本身',
    self_check_examples: '投诉和售后工单、某个门店或交付中心、某个车型批次、某个软件版本、某类销售话术',
    topics: ['产品质量与故障', '安全事故', '辅助驾驶', '车机与软件', '续航与充电', '价格与优惠', '销售与交付', '售后与维修', '保险与残值', '设计与配置', '品牌与创始人言论', '员工与招聘', '其他'],
    // 名称：说明。说明只给模型看，统计用名称
    high_voltage: {
      '安全': '刹车、失控、碰撞、自燃、人身伤害',
      '质量缺陷': '同一问题多人反复遇到、召回、批量故障',
      '消费公平': '降价背刺、定金或订单不退、维修乱收费、不认保修',
      '被轻视感': '被敷衍、投诉没人理、店大欺客',
      '虚假宣传': '续航、辅助驾驶能力、配置和宣传不符',
      '隐私': '车内摄像头、行车数据、个人信息',
      '民族情绪': '涉华言论、双标对待中国车主',
      '劳动者': '员工、销售待遇',
    },
    // 命中就把内容维度直接拉到高
    severe_high_voltage: ['安全', '民族情绪'],
    // 和高动员（≥ mobilization_high）同时出现才拉到高
    escalate_with_mobilization: ['消费公平', '质量缺陷'],
    mobilization: {
      1: '提到私下找过客服、门店或销售',
      5: '退订、劝退、避雷、号召别买',
      6: '提到 12315、市场监管、车质网等投诉平台、媒体、律师、起诉',
    },
    // 规则 R9：把评论区外推成整体的说法
    overreach_words: ['广大车主', '车主普遍', '大多数车主', '大部分车主', '广大用户', '公众普遍', '大多数人', '全网', '社会各界'],
  },
  // 人工核实过的外部背景，编码、研判、抽检都读得到。写清说的是谁、不是谁、哪天核实的
  context_notes: [
    '「刹车踩断」「刹车踏板断裂」「踏板断了」说的是懂车帝 2026 年 10 月测出江淮尊界系列刹车踏板断裂，不是特斯拉的车况；这里的「遥遥领先」是在调侃华为系。网友常拿它和特斯拉 Roadster「会飞」放在一起对比玩梗（2026-10-17 人工核实）',
  ],
  keywords: ['特斯拉', '特斯拉 投诉', 'Model Y'],
  // 官方号：抓它最近几篇笔记的评论区（用户动员第 2 级「半公开喊话」主要发生在这里）。
  // user_id 和 xsec_token 从小红书主页链接或搜索结果里取；空着就跳过，报告证据缺口会写「官方号评论区未覆盖」。
  // 搜索结果里碰到同名作者时，报告附一会列出它的 user_id，照着填进来即可
  official_accounts: [{ nickname: '特斯拉', user_id: '', xsec_token: '' }],
  official_notes_per_account: 3,
  // 编码字段改了就加 1：缓存里版本更低的记录下次会重新编码
  coding_version: 2,
  // 研判窗口：默认只看过去 24 小时的新内容（笔记按发布时间、评论按发表时间）；想看长一点改成 7 或 30。
  // 窗口外的存量只当背景，不进三维度统计
  window_days: 1,
  // 评论要判成本机构，所在笔记 / 上层评论得是本机构，或者原文里有这些线索之一；否则代码降为「无法判断」
  target_clues: ['特斯拉', 'Tesla', 'tesla', 'TSLA', 'Model', 'model', '毛豆', '马斯克', 'Musk', 'FSD', 'Autopilot', '超充', 'Cybertruck'],
  // 小红书 MCP 带筛选条件搜索会卡到 5 分钟超时，默认不筛选；要筛就填 { sort_by: '最新', publish_time: '一周内' }
  search_filters: {},
  max_notes_per_keyword: 8,
  comment_limit: 30,          // 每篇最多加载多少条一级评论
  click_more_replies: false,  // 展开二级回复会慢很多
  coding_batch_size: 30,
  recode_sample_size: 12,
  models: { coding: 'deepseek-flash', report: 'deepseek-flash', judge: 'deepseek-v4-pro' },
  // 三维度阈值（只统计指向本机构的记录）
  thresholds: {
    // 特斯拉是大品牌，搜索前排笔记动辄上万互动，阈值比本地小机构高一到两个数量级
    spread: { mid_notes: 5, high_notes: 15, mid_interactions: 10000, high_interactions: 100000, high_delta_ratio: 1.0 },
    emotion: { mid_neg_ratio: 0.2, high_neg_ratio: 0.4, min_n: 20, high_recall: 5 },
    mobilization_high: 5,
  },
};

// 提示词里的 {{占位符}}，05 / 08 / 09 三个节点共用
const I = config.industry;
config.prompt_vars = {
  BRAND_CONTEXT: config.brand_context,
  TARGET_RULE: config.target_rule,
  DECISION_SUBJECT: config.decision_subject,
  INDUSTRY: I.name,
  AUDIENCE: I.audience,
  AUDIENCE_SHORT: I.audience_short,
  GENERAL_TOPIC: I.general_topic,
  SELF_CHECK_EXAMPLES: I.self_check_examples,
  TOPICS: I.topics.join(' | '),
  HIGH_VOLTAGE: Object.entries(I.high_voltage).map(([k, v]) => `${k}（${v}）`).join(' | '),
  HIGH_VOLTAGE_NAMES: Object.keys(I.high_voltage).join(' | '),
  SEVERE_HIGH_VOLTAGE: I.severe_high_voltage.join('、'),
  MOB_1: I.mobilization[1],
  MOB_5: I.mobilization[5],
  MOB_6: I.mobilization[6],
  WINDOW: config.window_days === 1 ? '24 小时' : `${config.window_days} 天`,
  CONTEXT_NOTES: (config.context_notes || []).map(s => `- ${s}`).join('\n') || '- 无',
};

const runAt = new Date();
const run = {
  // 北京时间，文件名和报告都用它
  run_id: new Date(runAt.getTime() + 8 * 3600e3).toISOString().replace(/[:.]/g, '-').slice(0, 19),
  run_at: runAt.toISOString(),
  run_at_local: runAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  trigger: $input.first().json.timestamp ? '定时' : '手动',
};

// 关键词逐个搜；配了 user_id 的官方号逐个抓主页。下游「是官方号吗」按 kind 分流
const official = (config.official_accounts || []).filter(a => a.user_id)
  .map(a => ({ json: { kind: 'profile', keyword: `官方号：${a.nickname}`, account: a, config, run } }));
return [...config.keywords.map(keyword => ({ json: { kind: 'search', keyword, config, run } })), ...official];
