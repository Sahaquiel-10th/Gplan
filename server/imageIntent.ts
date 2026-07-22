const explicitImageActions = [
  /(?:帮我|请|给我|替我|麻烦|直接|能不能|可以不可以|我想|我要).{0,24}(?:生成|画|绘制|创作|制作|设计|改|修改|编辑|重绘|转换).{0,12}(?:图片|图像|图|插画|海报|头像|封面|logo)/i,
  /(?:生成|画|绘制|创作|制作|设计|重绘)(?:一|1|几|两|2)?(?:张|幅|个)?.{0,12}(?:图片|图像|图|插画|海报|头像|封面|logo)/i,
  /(?:调用|使用|用).{0,8}(?:image[- ]?2|gpt-image|图片模型).{0,12}(?:生图|生成|画|改图|编辑|重绘)?/i,
  /(?:帮我|请|给我|替我|麻烦|直接|能不能|可以不可以|我想|我要).{0,16}(?:生图|文生图|图生图|改图|修图)/i,
  /(?:帮我|请|给我|替我|麻烦|直接|能不能|可以不可以|我想|我要).{0,16}生(?:一|1|几|两|2)?(?:张|幅|个)?.{0,8}(?:图片|图像|图|插画|海报)/i,
  /\b(?:generate|create|draw|render|edit|transform|restyle)\b.{0,48}\b(?:image|picture|photo|illustration|poster|avatar|cover|logo)\b/i
];

const inputImageEdits = [
  /(?:把|将)?(?:这|那|上传|附件|上面|刚才)?.{0,8}(?:张|幅)?(?:图片|图像|图|照片).{0,16}(?:改成|改为|变成|转换成|做成|重绘成|换成|编辑成|调整为)/i,
  /(?:改成|改为|变成|转换成|做成|重绘成|换成).{0,16}(?:风格|效果|画面|插画|海报|头像|封面)/i
];

export function hasImageGenerationIntent(content: string, hasInputImage = false) {
  const text = content.trim();
  if (!text) return false;
  if (explicitImageActions.some((pattern) => pattern.test(text))) return true;
  return hasInputImage && inputImageEdits.some((pattern) => pattern.test(text));
}
