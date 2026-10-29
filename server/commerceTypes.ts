export const commerceOptions = {
  platforms: ["淘宝", "天猫", "京东", "拼多多", "抖音", "快手", "视频号", "小红书", "其他平台"],
  categories: ["美妆护肤", "食品饮料", "母婴用品", "家居日用", "服饰鞋包", "数码家电", "其他品类"],
  buyers: ["自己使用", "给孩子买", "给家人买", "送礼", "不确定，让 AI 建议"],
  familiarity: ["第一次尝试这类产品", "用过同类，初次尝试该品牌", "已经用过该品牌", "不确定"],
  channels: ["搜索结果", "推荐信息流", "付费推广", "店铺商品列表", "不确定"],
  focuses: ["产品特点", "满足顾客需求", "解决具体困扰", "数量与优惠", "品牌与服务保障"],
  styles: ["AI 推荐", "简洁突出商品", "突出数字与优惠", "突出使用场景", "沿用参考图结构"],
  layouts: ["AI 推荐", "左图右文", "左文右图", "上文下图", "商品居中"],
  goals: ["新品制作", "探索新方向", "优化现有主图"],
} as const;

export type CommerceBrief = {
  productImageIds: string[];
  referenceImageIds: string[];
  detailImageIds?: string[];
  detailText?: string;
  keywordCandidates?: CommerceKeyword[];
  outputFormat?: "square" | "portrait";
  productName: string;
  brand: string;
  specification: string;
  category: string;
  platform: string;
  buyer: string;
  familiarity: string;
  channel: string;
  keywords: string[];
  facts: string[];
  offer: string;
  mode: "direct" | "explore";
  focus: string;
  style: string;
  layout: string;
  goal: string;
  count: number;
  notes: string;
  composition?: CommerceComposition;
};

export type CommerceKeyword = { text: string; heat?: string; source: "report" | "detail" | "manual" | "packaging" };
export type CommerceSavedProduct = { id: string; name: string; brief: CommerceBrief; companyId: string; userId: string; agentId: string; createdAt: string; updatedAt: string };
export type CommerceSavedTemplate = { id: string; name: string; composition: CommerceComposition; referenceImageIds: string[]; companyId: string; userId: string; agentId: string; createdAt: string; updatedAt: string };
export type CommerceDeriveRequest = {
  variantId: string; kind: "portrait" | "sku" | "revision"; requestKey: string;
  instruction?: string;
  items?: { name: string; specification: string; imageIds: string[] }[];
};

export const commerceModuleTypes = {
  product: "商品主体", brand: "品牌标识", benefit: "主要卖点", activity: "活动",
  price: "价格", offer: "优惠", gift: "赠品", service: "服务信息", badge: "身份或排行标识", other: "其他内容",
} as const;
export type CommerceModuleType = keyof typeof commerceModuleTypes;
export type CommerceReferenceModule = {
  id: string; type: CommerceModuleType; name: string; location: string;
  bbox?: [number, number, number, number]; texts: string[]; appearance: string;
  confidence: "high" | "medium" | "low"; uncertainties: string[];
};
export type CommerceReference = {
  imageId: string;
  overall: { layout: string; background: string; palette: string; visualStyle: string };
  modules: CommerceReferenceModule[];
};
export type CommerceModule = {
  id: string; type: CommerceModuleType; name: string; enabled: boolean;
  content: string; location: string; appearance: string;
  emphasis: "primary" | "normal" | "secondary"; assetId: string;
  source?: CommerceReferenceModule & { imageId: string };
};
export type CommerceComposition = {
  primaryReferenceId: string; reference?: CommerceReference;
  overall: CommerceReference["overall"];
  modules: CommerceModule[];
};

export type CommerceRecognition = {
  productName: string;
  brand: string;
  specification: string;
  facts: string[];
  keywords: string[];
  note: string;
};

export type CommerceVariant = {
  id: string;
  name: string;
  reason: string;
  headline: string;
  subline: string;
  imagePrompt: string;
  title: string;
  titleReason: string;
  status: "pending" | "generating" | "completed" | "failed";
  selected?: boolean;
  referenceImageId?: string;
  sourceImageId?: string;
  productImageIds?: string[];
  specification?: string;
  outputWidth?: number;
  outputHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  imageAttachmentId?: string;
  previousImageIds?: string[];
  error?: string;
  attempts: number;
  quality?: "passed" | "review";
  qualityNote?: string;
};

export type CommerceJob = {
  kind?: "product_creative" | "image_edit";
  taskType?: "main" | "portrait" | "sku" | "revision";
  sourceJobId?: string;
  sourceVariantId?: string;
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  requestKey: string;
  brief: CommerceBrief;
  status: "planning" | "review" | "queued" | "generating" | "completed" | "partial" | "failed" | "interrupted";
  phase: string;
  summary: string;
  analysis: string;
  variants: CommerceVariant[];
  chatModelId: string;
  imageModelId: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type CommercePublicJob = Omit<CommerceJob, "analysis" | "chatModelId" | "imageModelId" | "requestKey" | "variants"> & {
  variants: Omit<CommerceVariant, "imagePrompt">[];
};

export function defaultCommerceBrief(): CommerceBrief {
  return {
    productImageIds: [], referenceImageIds: [], productName: "", brand: "", specification: "",
    category: "美妆护肤", platform: "淘宝", buyer: "自己使用", familiarity: "不确定",
    channel: "搜索结果", keywords: [], facts: [], offer: "", mode: "explore", focus: "产品特点",
    style: "AI 推荐", layout: "AI 推荐", goal: "新品制作", count: 5, notes: "",
  };
}
