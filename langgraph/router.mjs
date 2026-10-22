// 按品牌的人群画像决定以哪个平台为主：
//   主要消费者本科及以上为主 → 知乎为主；否则女性为主 → 小红书为主；中性或男性为主 → B站为主。
// 画像让模型判断（LangChain 结构化输出），平台和比重由下面的规则表定，不让模型自己挑平台，结果可预期、可复核。
import { ChatDeepSeek } from "@langchain/deepseek";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { deepseekKey } from "./llm.mjs";

export const PLATFORMS = ["小红书", "B站", "知乎"];
const WEIGHTS = { primary: 0.6, other: 0.2 }; // 主平台占六成样本，另两个各两成
const TOTAL_PER_KEYWORD = 15;                 // 每个关键词三个平台合计取多少篇 / 个视频

const Audience = z.object({
    gender: z.enum(["女性为主", "中性", "男性为主"]).describe("主营消费群体的性别构成"),
    highly_educated: z.boolean().describe("主要消费者是否以本科及以上学历为主"),
    reason: z.string().describe("一两句依据，说清是根据品牌的哪些特征判断的"),
});

const prompt = ChatPromptTemplate.fromMessages([
    ["system", "你是消费者研究员。根据品牌介绍判断它在中国市场的主营消费群体画像。只看真实的购买者和主力用户，不看泛关注者；拿不准时性别选「中性」、学历选 false。\n只输出 JSON：{{\"gender\": \"女性为主\" | \"中性\" | \"男性为主\", \"highly_educated\": 主要消费者是否以本科及以上学历为主（true / false）, \"reason\": \"一两句依据\"}}"],
    ["human", "品牌：{brand}\n介绍：{brand_context}"],
]);

export async function classifyAudience({ brand, brand_context }, { model = "deepseek-flash" } = {}) {
    const llm = new ChatDeepSeek({ model, apiKey: deepseekKey(), temperature: 0 });
    // DeepSeek 的思考模式不支持强制工具调用，所以走 JSON 模式；字段仍按 Audience 校验，不合格直接报错
    return prompt.pipe(llm.withStructuredOutput(Audience, { name: "audience", method: "jsonMode" })).invoke({ brand, brand_context });
}

export function primaryPlatform({ gender, highly_educated }) {
    if (highly_educated) return "知乎";
    return gender === "女性为主" ? "小红书" : "B站";
}

// audience → 每个平台的比重、每个关键词取几篇、这次抓不抓。live：这次真的去抓的平台
export function planPlatforms(audience, { live = PLATFORMS } = {}) {
    const primary = primaryPlatform(audience);
    const statusOf = (name) => (live.includes(name) ? "抓取" : "本次未抓");
    // 主平台抓不了时，六成样本给按性别该选的那个平台（女性为主 → 小红书，否则 B站），报告里写明是代替
    const genderPick = audience.gender === "女性为主" ? "小红书" : "B站";
    const acting = statusOf(primary) === "抓取" ? primary : statusOf(genderPick) === "抓取" ? genderPick : primary;
    return {
        audience, primary, acting_primary: acting,
        platforms: PLATFORMS.map((name) => {
            const weight = name === primary ? WEIGHTS.primary : WEIGHTS.other;
            const budget = name === acting ? WEIGHTS.primary : WEIGHTS.other;
            return { name, weight, per_keyword: Math.max(1, Math.round(TOTAL_PER_KEYWORD * budget)), status: statusOf(name) };
        }),
    };
}

// 给研判模型的一段补充说明：比重怎么用、哪些平台没覆盖
export function weightingNote(plan, counts) {
    const lines = plan.platforms.map((p) => `- ${p.name}：比重 ${Math.round(p.weight * 100)}%，${p.status === "抓取" ? `本次 ${counts[p.name]?.notes ?? 0} 篇 / 个、记录 ${counts[p.name]?.records ?? 0} 条` : p.status}`);
    return [
        `本次调研按品牌人群画像分配平台比重（${plan.audience.gender}，${plan.audience.highly_educated ? "本科及以上为主" : "学历不限"}；依据：${plan.audience.reason}），以「${plan.primary}」为主：`,
        ...lines,
        ...(plan.acting_primary !== plan.primary ? [`主平台「${plan.primary}」本次没有数据，暂以「${plan.acting_primary}」代替主平台、按六成样本抓取；这一点要写进证据缺口，结论要说明受众偏差。`] : []),
        `写研判时：分档、实质、走势以主平台「${plan.acting_primary}」的证据为准；其他平台只作佐证，用来判断是否跨平台扩散，不能单凭佐证平台定调。`,
        `主平台没抓到数据时（未接入或本次未抓），在证据缺口里写明，分档最多到「传播证据不足，暂不可分档」。`,
    ].join("\n");
}
