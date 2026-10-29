import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ImagePlus, LoaderCircle, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import type { CommerceDeriveRequest, CommercePublicJob } from "../server/commerceTypes";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type Variant = CommercePublicJob["variants"][number];
type SkuItem = { key: string; name: string; specification: string; imageIds: string[] };
const imageUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;
const newSku = (): SkuItem => ({ key: crypto.randomUUID(), name: "", specification: "", imageIds: [] });

// Intent: operators compare ideas, choose one reference, and spend a generation on one card.
// Hierarchy: artwork and the single generation action lead. Further edits disclose on demand.
// Palette/depth/surfaces/type/spacing: existing workspace tokens, quiet paper cards,
// inset native controls, inherited 14px Chinese type and 4px spacing rhythm.
export function CommerceResultCard({ api, job, variant, index, busy, ready, onGenerate, onDerive, onPreview, onNotice, onError }: {
  api: Api; job: CommercePublicJob; variant: Variant; index: number; busy: boolean; ready: boolean;
  onGenerate: (id: string, reference: string, retry: boolean) => Promise<void>;
  onDerive: (request: CommerceDeriveRequest) => Promise<void>;
  onPreview: (id: string, name: string) => void; onNotice: (message: string) => void; onError: (message: string) => void;
}) {
  const refs = job.brief.referenceImageIds;
  const [reference, setReference] = useState(variant.referenceImageId ?? refs[index % Math.max(refs.length, 1)] ?? "");
  const [tool, setTool] = useState<"revision" | "sku">();
  const [instruction, setInstruction] = useState("");
  const [items, setItems] = useState<SkuItem[]>([newSku()]);
  const [uploading, setUploading] = useState("");
  const alive = useRef(true);
  const deriveKey = useRef(crypto.randomUUID());
  const itemsRef = useRef(items); itemsRef.current = items;
  const requestPending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (variant.referenceImageId !== undefined) setReference(variant.referenceImageId); }, [variant.referenceImageId]);
  const locked = busy || !!uploading;
  const patchItem = (key: string, patch: Partial<SkuItem>) => { setItems(values => values.map(item => item.key === key ? { ...item, ...patch } : item)); deriveKey.current = crypto.randomUUID(); };

  async function uploadSku(key: string, files: File[]) {
    if (!files.length || requestPending.current) return;
    const item = itemsRef.current.find(value => value.key === key);
    if (!item) return;
    const chosen = files.slice(0, 3 - item.imageIds.length);
    if (!chosen.length) return;
    if (chosen.some(f => !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 10 * 1024 * 1024)) { onError("SKU 商品图请上传10MB以内的 PNG、JPG 或 WebP 图片"); return; }
    requestPending.current = true; setUploading(key);
    try {
      const form = new FormData(); chosen.forEach(file => form.append("files", file));
      const { attachments } = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
      if (!alive.current) return;
      const current = itemsRef.current.find(value => value.key === key);
      if (current) patchItem(key, { imageIds: [...current.imageIds, ...attachments.map(a => a.id)].slice(0, 3) });
    } catch (e) { if (alive.current) onError(e instanceof Error ? e.message : "SKU 商品图上传失败"); }
    finally { requestPending.current = false; if (alive.current) setUploading(""); }
  }

  async function derive(kind: CommerceDeriveRequest["kind"]) {
    if (locked || requestPending.current) return;
    requestPending.current = true;
    try {
      await onDerive({ variantId: variant.id, kind, requestKey: deriveKey.current, ...(kind === "revision" ? { instruction: instruction.trim() } : {}), ...(kind === "sku" ? { items: items.map(({ name, specification, imageIds }) => ({ name, specification, imageIds })) } : {}) });
    } finally { requestPending.current = false; }
  }

  const isMain = !job.taskType || job.taskType === "main";
  return <article className="creative-result" aria-label={`方案${index + 1} ${variant.name}`}>
    <div className="creative-result-label"><span>方案 {String(index + 1).padStart(2, "0")}</span><strong>{variant.name}</strong>{variant.outputWidth && <small>{variant.outputWidth} × {variant.outputHeight}</small>}</div>
    {variant.imageAttachmentId ? <button type="button" className="creative-result-image" aria-label={`放大查看${variant.name}`} onClick={() => onPreview(variant.imageAttachmentId!, variant.name)}><img src={imageUrl(variant.imageAttachmentId)} alt={`${job.brief.productName} · ${variant.name}`} loading="lazy" style={job.taskType === "portrait" || job.brief.outputFormat === "portrait" ? { aspectRatio: "3 / 4" } : undefined} /></button> : <div className={`creative-result-placeholder ${variant.status === "generating" ? "is-generating" : ""}`}>{variant.status === "generating" ? <><LoaderCircle size={28} className="creative-spin" /><strong>正在制作这一张</strong></> : <><div className="creative-idea"><span>{variant.headline || job.brief.productName}</span>{job.brief.productImageIds[0] && <img src={imageUrl(variant.productImageIds?.[0] || job.brief.productImageIds[0])} alt="方案使用的原商品图" />}<small>{variant.subline}</small></div><span>{variant.status === "failed" ? "这一张暂未完成" : variant.selected ? "已选择，等待制作" : "方向预览 · 点击才生成"}</span></>}</div>}
    <div className="creative-result-body">
      <p className="creative-reason">{variant.reason}</p>
      {(variant.headline || variant.subline) && <details className="creative-image-copy"><summary>图片上的文案</summary><p>{variant.headline}{variant.subline && <><br />{variant.subline}</>}</p></details>}
      {isMain && refs.length > 0 && <fieldset className="creative-card-reference"><legend>这张用哪张参考？</legend><div className="creative-card-reference-options"><button type="button" aria-pressed={!reference} disabled={locked} className={!reference ? "selected" : ""} onClick={() => setReference("")}><Sparkles size={18} /><span>不使用</span></button>{refs.map((id, i) => <button type="button" key={id} disabled={locked} aria-pressed={reference === id} className={reference === id ? "selected" : ""} onClick={() => setReference(id)} aria-label={`方案${index + 1}使用参考图${i + 1}`}><img src={imageUrl(id)} alt={`参考图${i + 1}`} /><span>参考 {i + 1}</span></button>)}</div><p className="creative-help">只使用本张选中的参考图，其他参考图不参与。</p></fieldset>}
      {variant.status !== "generating" && <button type="button" className="creative-primary creative-card-generate" disabled={locked || !ready} onClick={() => void onGenerate(variant.id, reference, variant.status !== "pending")}>
        {variant.imageAttachmentId || variant.status === "failed" ? <RefreshCw size={16} /> : <ImagePlus size={16} />}{variant.imageAttachmentId ? "重新生成这张" : variant.status === "failed" ? "重试这张" : "生成这张"}
      </button>}
      <div className="creative-product-title"><span className="creative-platform-label">{job.brief.platform} · 商品标题</span><h3>{variant.title}</h3><details><summary>标题为什么这样写？</summary><p>{variant.titleReason}</p></details><button type="button" className="creative-text-button" onClick={() => void navigator.clipboard.writeText(variant.title).then(() => onNotice("商品标题已复制"), () => onError("复制失败，请手动选择标题复制"))}><Copy size={14} />复制商品标题</button></div>
      {variant.qualityNote && <p className={`creative-quality ${variant.quality === "review" ? "needs-review" : ""}`}>{variant.quality === "passed" ? <Check size={14} /> : <span aria-hidden="true">!</span>}{variant.qualityNote}</p>}
      {variant.error && <p className="creative-result-error" role="alert">{variant.error}</p>}
      {!!variant.previousImageIds?.length && <details><summary>之前的图片（{variant.previousImageIds.length}）</summary><div className="creative-result-actions">{variant.previousImageIds.map((id, n) => <a key={id} href={`${imageUrl(id)}?download=1`} download><Download size={14} />第{n + 1}版</a>)}</div></details>}
      {variant.imageAttachmentId && <div className="creative-result-actions"><a href={`${imageUrl(variant.imageAttachmentId)}?download=1`} download><Download size={14} />下载图片</a><button type="button" disabled={locked} aria-expanded={tool === "revision"} onClick={() => { setTool(tool === "revision" ? undefined : "revision"); deriveKey.current = crypto.randomUUID(); }}>在这张基础上修改</button>{job.taskType !== "portrait" && <button type="button" disabled={locked} onClick={() => void derive("portrait")}>生成 3:4 竖图</button>}<button type="button" disabled={locked} aria-expanded={tool === "sku"} onClick={() => { setTool(tool === "sku" ? undefined : "sku"); deriveKey.current = crypto.randomUUID(); }}>套版做 SKU</button></div>}
      {tool === "revision" && <div className="creative-card-tool"><strong>只改你指定的地方</strong><label className="creative-custom">想改什么？<textarea rows={3} maxLength={1000} value={instruction} disabled={locked} onChange={e => { setInstruction(e.target.value); deriveKey.current = crypto.randomUUID(); }} placeholder="例如：删除左上角活动文案，其余内容保持不变" /></label><div className="creative-module-suggestions">{["删除指定文字后，重新平衡排版", "保留商品、Logo和其他文字，只修改指定位置"].map(text => <button type="button" key={text} disabled={locked} onClick={() => { setInstruction(value => `${value}${value ? "；" : ""}${text}`); deriveKey.current = crypto.randomUUID(); }}>{text}<Plus size={12} /></button>)}</div><button type="button" className="creative-primary" disabled={locked || !instruction.trim()} onClick={() => void derive("revision")}><Sparkles size={15} />生成修改版</button></div>}
      {tool === "sku" && <div className="creative-card-tool"><strong>沿用这张的版式，替换 SKU</strong><p className="creative-help">每一项生成一张独立图片。组合装可上传多件商品，写清数量和规格。</p>{items.map((item, i) => <div className="creative-sku-item" key={item.key}><header><strong>SKU {i + 1}</strong>{items.length > 1 && <button type="button" className="creative-icon-button" disabled={locked} aria-label={`移除SKU${i + 1}`} onClick={() => { setItems(values => values.filter(value => value.key !== item.key)); deriveKey.current = crypto.randomUUID(); }}><X size={14} /></button>}</header><label className="creative-custom">商品／组合名称<input disabled={locked} value={item.name} maxLength={120} placeholder="例如：身体乳双瓶装" onChange={e => patchItem(item.key, { name: e.target.value })} /></label><label className="creative-custom">规格与数量<input disabled={locked} value={item.specification} maxLength={160} placeholder="例如：250g × 2瓶；或250g + 100g组合" onChange={e => patchItem(item.key, { specification: e.target.value })} /></label><div className="creative-sku-images">{item.imageIds.map((id, n) => <div className="creative-thumbnail" key={id}><img src={imageUrl(id)} alt={`SKU${i + 1}商品图${n + 1}`} /><button type="button" disabled={locked} aria-label={`移除SKU${i + 1}商品图${n + 1}`} onClick={() => patchItem(item.key, { imageIds: item.imageIds.filter(value => value !== id) })}><X size={12} /></button></div>)}{item.imageIds.length < 3 && <label className="creative-compact-upload">{uploading === item.key ? <LoaderCircle size={15} className="creative-spin" /> : <ImagePlus size={15} />}上传商品图<input aria-label={`SKU${i + 1}商品图`} type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={locked} onChange={e => { void uploadSku(item.key, Array.from(e.target.files || [])); e.target.value = ""; }} /></label>}</div></div>)}<div className="creative-module-tools"><button type="button" className="creative-secondary" disabled={locked || items.length >= 12} onClick={() => { setItems(values => [...values, newSku()]); deriveKey.current = crypto.randomUUID(); }}><Plus size={14} />添加 SKU</button><button type="button" className="creative-primary" disabled={locked || items.some(item => !item.name.trim() || !item.imageIds.length)} onClick={() => void derive("sku")}><ImagePlus size={15} />生成 {items.length} 张 SKU 图</button></div></div>}
    </div>
  </article>;
}
