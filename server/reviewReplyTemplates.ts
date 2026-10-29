import type { User } from "./types.js";
import type { ReviewDraft, ReviewTemplate } from "./reviewReplyTypes.js";

export function defaultReviewDraft(): ReviewDraft {
  return {
    name: "我的店铺回复规则", shopName: "", brand: "", platform: "天猫",
    settings: {
      tone: "真诚温和、专业克制，像熟悉产品的店员自然交流", length: "medium", count: 2,
      marketing: "light", address: "自然称呼", emoji: false, signature: "", closing: "",
      goals: ["回应真实体验", "解答问题", "需要时补充产品信息"], forbiddenPhrases: ["亲亲", "绝对有效", "百分百"],
      afterSales: "遇到售后问题先理解顾客感受，引导通过店铺官方客服核实，不编造处理进度或赔付承诺。",
      sceneRules: {
        "具体好评": "回应评价里的具体体验，避免重复堆砌广告。", "简短好评": "简短感谢，不为凑字数添加功效。",
        "复购": "客户明确说复购时再感谢持续选择。", "混合评价": "先回应不满意的地方，再回应肯定之处。",
        "产品疑问": "仅使用已确认且与所选商品相关的事实，资料不足时引导核实。", "投诉或不适": "优先关心与解决问题，停止营销，必要时引导官方客服或专业帮助。",
      },
    },
    products: [], facts: [], examples: [], rules: [], sourceAttachmentIds: [],
  };
}

export function reviewReplyTemplates(user: User): ReviewTemplate[] {
  const templates: ReviewTemplate[] = [{ id: "blank", name: "从空白开始", description: "填写店铺资料，或上传资料让 AI 先整理一份草稿。", draft: defaultReviewDraft() }];
  if (user.companyId !== "company_default") return templates;
  const draft = defaultReviewDraft();
  draft.name = "东面山评价回复规则"; draft.shopName = "东面山天猫旗舰店"; draft.brand = "东面山";
  draft.settings.tone = "成熟、真诚、克制，平等交流；关照实际护理需求，不制造年龄焦虑。";
  draft.settings.goals = ["回应客户真实体验", "传递按需护理的品牌态度", "有依据地解答商品疑问"];
  draft.products = [{ id: "dms-cleanser", name: "洁面慕斯", sku: "洁面慕斯" }, { id: "dms-toner", name: "精华水", sku: "精华水" }, { id: "dms-lotion", name: "精华乳", sku: "精华乳" }];
  draft.facts = [
    { id: "dms-brand", productId: "", text: "品牌倡导按需护理，以实际护理需求为先。", source: "东面山模板精选公开表达", status: "approved" },
    { id: "dms-age", productId: "", text: "35+ 是沟通背景，不是使用门槛；不根据年龄标签推定顾客需求。", source: "东面山模板精选公开表达", status: "approved" },
    { id: "dms-cleansing", productId: "dms-cleanser", text: "洁面承担清洁步骤。", source: "商品角色，发布前仍请核对实际商品", status: "pending" },
    { id: "dms-water", productId: "dms-toner", text: "水承担日常护理中的水类步骤。", source: "商品角色，发布前仍请核对实际商品", status: "pending" },
    { id: "dms-emulsion", productId: "dms-lotion", text: "乳承担日常护理中的乳类步骤。", source: "商品角色，发布前仍请核对实际商品", status: "pending" },
    { id: "dms-check", productId: "", text: "旧稿中的规格、成分、原料比例和功效数字需对照当前标签与资质重新核实。", source: "历史资料核对提示", status: "internal" },
  ];
  draft.examples = [{ id: "dms-example-one", review: "包装挺仔细，拿到手感觉很用心。", reply: "谢谢你留意到这些小细节。收到时的感受也很重要，希望接下来的使用同样顺心。" }, { id: "dms-example-two", review: "用着舒服，第二次来买了。", reply: "谢谢你再次选择我们，也很高兴这次护理让你觉得舒服。适合自己的节奏和感受最重要。" }];
  draft.rules = ["客户未提年龄时，不主动贴 35+ 标签。", "只在与评价相关时提及品牌或产品信息，避免每条都重复新品牌叙事。", "只对客户明确表达的体验作回应，不从昵称、照片或评价推断性别、年龄、健康状况。"];
  templates.push({ id: "dongmianshan", name: "东面山店铺模板", description: "预填品牌语气与三类商品角色；具体规格、成分和功效仍需核实。", draft });
  return templates;
}
