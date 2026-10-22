// 路由规则表：画像 → 主平台、比重、每个关键词取几篇；主平台抓不了时谁代替
import test from "node:test";
import assert from "node:assert/strict";
import { planPlatforms, primaryPlatform } from "../router.mjs";

const aud = (gender, highly_educated = false) => ({ gender, highly_educated, reason: "测试" });
const byName = (plan) => Object.fromEntries(plan.platforms.map((p) => [p.name, p]));

test("主平台：高学历 → 知乎；否则女性为主 → 小红书；中性 / 男性为主 → B站", () => {
    assert.equal(primaryPlatform(aud("女性为主")), "小红书");
    assert.equal(primaryPlatform(aud("中性")), "B站");
    assert.equal(primaryPlatform(aud("男性为主")), "B站");
    assert.equal(primaryPlatform(aud("女性为主", true)), "知乎");
    assert.equal(primaryPlatform(aud("男性为主", true)), "知乎");
});

test("比重 60 / 20 / 20，主平台每个关键词取 9 篇，其余 3 篇", () => {
    const p = byName(planPlatforms(aud("女性为主")));
    assert.deepEqual([p.小红书.weight, p.B站.weight, p.知乎.weight], [0.6, 0.2, 0.2]);
    assert.deepEqual([p.小红书.per_keyword, p.B站.per_keyword], [9, 3]);
});

test("不在 live 里的平台本次不抓", () => {
    const p = byName(planPlatforms(aud("中性"), { live: ["B站", "知乎"] }));
    assert.equal(p.小红书.status, "本次未抓");
    assert.equal(p.B站.status, "抓取");
    assert.equal(p.知乎.status, "抓取");
});

test("高学历品牌、知乎在抓：知乎就是实际主平台，拿六成样本", () => {
    const plan = planPlatforms(aud("男性为主", true), { live: ["B站", "知乎"] });
    assert.equal(plan.acting_primary, "知乎");
    assert.deepEqual([byName(plan).知乎.per_keyword, byName(plan).B站.per_keyword], [9, 3]);
});

test("主平台抓不了时，六成样本给按性别该选的平台，比重本身不变", () => {
    const plan = planPlatforms(aud("男性为主", true), { live: ["B站"] });
    assert.equal(plan.primary, "知乎");
    assert.equal(plan.acting_primary, "B站");
    const p = byName(plan);
    assert.equal(p.知乎.weight, 0.6);
    assert.equal(p.B站.per_keyword, 9);

    const female = planPlatforms(aud("女性为主"), { live: ["B站"] });
    assert.equal(female.acting_primary, "小红书"); // 小红书没在 live 里，代替不了，就保持原主平台
    assert.equal(byName(female).B站.per_keyword, 3);
});
