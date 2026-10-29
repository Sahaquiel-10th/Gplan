import React, { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ImagePlus, LoaderCircle, Plus, RefreshCw, Upload, X } from "lucide-react";
import type { CommerceBrief, CommerceKeyword, CommerceRecognition, CommerceSavedProduct, CommerceSavedTemplate } from "../server/commerceTypes";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
const imageUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;
export const mergeKeywords = (...groups: CommerceKeyword[][]): CommerceKeyword[] => {
  const values = new Map<string, CommerceKeyword>();
  for (const item of groups.flat()) {
    const text = item.text.trim();
    if (text) values.set(text, { ...values.get(text), ...item, text });
  }
  return [...values.values()].slice(0, 200);
};
const materialKey = (b: CommerceBrief) => JSON.stringify([b.productImageIds, b.detailImageIds || [], b.detailText || "", b.productName, b.brand, b.specification]);

// Intent: an operator supplies existing product evidence, then chooses from extracted facts.
// Hierarchy: the extraction action leads; optional source inputs stay inside one disclosure.
// Palette/depth/surfaces: reuse workspace blue, inset inputs and quiet paper borders.
// Typography/spacing: inherited Chinese system font, 14px labels and a 4px rhythm.
export function CommerceMaterials({ api, brief, onChange, onRecognition, onBusy }: {
  api: Api; brief: CommerceBrief; onChange: (patch: Partial<CommerceBrief>) => void;
  onRecognition: (value: CommerceRecognition) => void; onBusy: (value: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(!!brief.detailImageIds?.length || !!brief.detailText);
  const panelId = useId();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const latest = useRef(brief); latest.current = brief;
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusy(false); }; }, []);
  const loading = (value: boolean) => { pending.current = value; setBusy(value); onBusy(value); };

  async function recognize(value = latest.current) {
    if (pending.current || !(value.detailImageIds?.length || value.detailText?.trim())) return;
    const key = materialKey(value);
    loading(true); setError(""); setMessage("");
    try {
      const { recognition } = await api<{ recognition: CommerceRecognition }>("/api/commerce/materials/recognize", {
        method: "POST", body: JSON.stringify({ imageIds: value.detailImageIds || [], text: value.detailText || "", productName: value.productName, brand: value.brand, specification: value.specification }),
      });
      if (!alive.current || key !== materialKey(latest.current)) return;
      onRecognition(recognition);
      const candidates = mergeKeywords(latest.current.keywordCandidates || [], recognition.keywords.map(text => ({ text, source: "detail" as const })));
      onChange({
        productName: latest.current.productName || recognition.productName,
        brand: latest.current.brand || recognition.brand,
        specification: latest.current.specification || recognition.specification,
        keywordCandidates: candidates,
      });
      setMessage("已整理卖点和标题候选词。核对后点选即可；没有关键词表时，会优先使用这些商品词。");
    } catch (e) { if (alive.current && key === materialKey(latest.current)) setError(e instanceof Error ? e.message : "商品资料识别失败，请重试"); }
    finally { if (alive.current) loading(false); }
  }

  async function upload(files: File[]) {
    const value = latest.current;
    const key = materialKey(value);
    const chosen = files.slice(0, 12 - (value.detailImageIds?.length || 0));
    if (!chosen.length || pending.current) return;
    if (chosen.some(f => !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 10 * 1024 * 1024)) { setError("详情图请使用10MB以内的 PNG、JPG 或 WebP 图片"); return; }
    loading(true); setError(""); setMessage("");
    let next: CommerceBrief | undefined;
    try {
      const attachments: { id: string }[] = [];
      for (let offset = 0; offset < chosen.length; offset += 4) {
        const form = new FormData(); chosen.slice(offset, offset + 4).forEach(file => form.append("files", file));
        const result = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
        attachments.push(...result.attachments);
        if (!alive.current || key !== materialKey(latest.current)) return;
      }
      if (!alive.current || key !== materialKey(latest.current)) return;
      next = { ...latest.current, detailImageIds: [...(latest.current.detailImageIds || []), ...attachments.map(a => a.id)] };
      latest.current = next;
      onChange({ detailImageIds: next.detailImageIds });
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "详情图上传失败"); }
    finally { if (alive.current) loading(false); }
    if (next && alive.current) void recognize(next);
  }

  return <section className="creative-materials" aria-label="商品详情资料">
    <button type="button" className="creative-materials-trigger" aria-label="添加详情资料" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}>
      <span className="creative-materials-trigger-icon"><Upload size={21} aria-hidden="true" /></span>
      <span><strong>添加详情资料</strong><small>上传图片或粘贴文字，AI 帮你提炼卖点和关键词</small></span>
      <ChevronDown size={18} className={expanded ? "is-expanded" : ""} aria-hidden="true" />
    </button>
    {expanded && <div id={panelId} className="creative-materials-panel">
    <p className="creative-help">放入已有详情页，不用重新写需求。详情图只提供商品信息，不会作为主图参考。</p>
    <div className="creative-detail-images">{brief.detailImageIds?.map((id, i) => <div className="creative-thumbnail" key={id}><img src={imageUrl(id)} alt={`商品详情图${i + 1}`} /><button type="button" aria-label={`移除详情图${i + 1}`} disabled={busy} onClick={() => onChange({ detailImageIds: brief.detailImageIds!.filter(x => x !== id) })}><X size={14} /></button></div>)}
      {(brief.detailImageIds?.length || 0) < 12 && <label className="creative-compact-upload"><ImagePlus size={18} />上传详情图<input aria-label="商品详情图" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={e => { void upload(Array.from(e.target.files || [])); e.target.value = ""; }} /></label>}
    </div>
    <label className="creative-custom">或粘贴详情文字<textarea aria-label="商品详情文字" value={brief.detailText || ""} disabled={busy} rows={4} maxLength={20000} placeholder="粘贴商品详情、品牌资料中的原文，AI 会整理成可以点选的卖点和关键词" onChange={e => onChange({ detailText: e.target.value })} /></label>
    <button type="button" className="creative-secondary" disabled={busy || !(brief.detailImageIds?.length || brief.detailText?.trim())} onClick={() => void recognize()}>{busy ? <LoaderCircle size={15} className="creative-spin" /> : <RefreshCw size={15} />}提炼卖点与关键词</button>
    {message && <p className="creative-note" role="status">{message}</p>}{error && <p className="creative-result-error" role="alert">{error}</p>}
    </div>}
  </section>;
}

// Intent/hierarchy: choose useful search terms; imported demand data stays visibly separate
// from detail-derived suggestions. Same paper/inset/blue palette, 14px type, 4px rhythm.
export function CommerceKeywords({ api, brief, packagingKeywords, onChange, onBusy }: {
  api: Api; brief: CommerceBrief; packagingKeywords: string[]; onChange: (patch: Partial<CommerceBrief>) => void; onBusy: (value: boolean) => void;
}) {
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const latest = useRef(brief); latest.current = brief;
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusy(false); }; }, []);
  const candidates = mergeKeywords(packagingKeywords.map(text => ({ text, source: "packaging" as const })), brief.keywords.map(text => ({ text, source: "manual" as const })), brief.keywordCandidates || []);
  const reports = candidates.filter(k => k.source === "report");
  const suggested = candidates.filter(k => k.source !== "report");
  const toggle = (text: string) => onChange({ keywords: brief.keywords.includes(text) ? brief.keywords.filter(k => k !== text) : [...brief.keywords, text].slice(0, 20) });

  async function importFile(file?: File) {
    if (!file || pending.current) return;
    if (!/\.(xlsx?|csv)$/i.test(file.name) || file.size > 10 * 1024 * 1024) { setError("请上传10MB以内的 XLSX、XLS 或 CSV 关键词表"); return; }
    const key = materialKey(brief);
    pending.current = true; setBusy(true); onBusy(true); setError(""); setNote("");
    try {
      const form = new FormData(); form.append("files", file);
      const { attachments } = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
      if (!alive.current || key !== materialKey(latest.current)) return;
      const result = await api<{ keywords: CommerceKeyword[]; note?: string }>("/api/commerce/keywords/import", { method: "POST", body: JSON.stringify({ attachmentId: attachments[0].id }) });
      if (!alive.current || key !== materialKey(latest.current)) return;
      onChange({ keywordCandidates: mergeKeywords(latest.current.keywordCandidates || [], result.keywords) });
      setNote(result.note || `已识别 ${result.keywords.length} 个关键词，请点选与商品相关的词。`);
    } catch (e) { if (alive.current && key === materialKey(latest.current)) setError(e instanceof Error ? e.message : "关键词表识别失败"); }
    finally { pending.current = false; if (alive.current) { setBusy(false); onBusy(false); } }
  }
  function addManual() {
    const terms = [...new Set(manual.split(/[\n,，、;；]+/).map(t => t.trim()).filter(Boolean))].slice(0, 40);
    if (!terms.length) return;
    onChange({ keywordCandidates: mergeKeywords(brief.keywordCandidates || [], terms.map(text => ({ text, source: "manual" as const }))), keywords: [...new Set([...brief.keywords, ...terms])].slice(0, 20) });
    setManual("");
  }
  const renderWords = (words: CommerceKeyword[]) => <div className="creative-choices creative-keyword-chips">{words.map(word => <button type="button" className={`creative-choice ${brief.keywords.includes(word.text) ? "selected" : ""}`} aria-pressed={brief.keywords.includes(word.text)} disabled={busy || !brief.keywords.includes(word.text) && brief.keywords.length >= 20} key={word.text} onClick={() => toggle(word.text)}><span className="creative-checkbox">{brief.keywords.includes(word.text) && <Check size={12} />}</span><span>{word.text}{word.heat && <small>热度 {word.heat}</small>}</span></button>)}</div>;
  return <section className="creative-keywords" aria-label="商品标题关键词"><div className="creative-section-title"><h3>商品标题关键词</h3><span className="creative-muted">已选 {brief.keywords.length}/20</span></div>
    <p className="creative-help">点选与商品相关的词，用于商品标题。图片上的卖点文案会根据主图模块另行排版。</p>
    <label className="creative-secondary creative-file-action">{busy ? <LoaderCircle size={15} className="creative-spin" /> : <Upload size={15} />}上传关键词表<input aria-label="上传关键词表" type="file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
    {reports.length > 0 && <div className="creative-keyword-group"><strong>报表关键词</strong><p className="creative-help">热度按上传报表展示；请排除其他品牌和不适用的属性。</p>{renderWords(reports.slice(0, 12))}{reports.length > 12 && <details className="creative-details"><summary>查看其余 {reports.length - 12} 个报表词</summary>{renderWords(reports.slice(12))}</details>}</div>}
    {suggested.length > 0 ? <div className="creative-keyword-group"><strong>{reports.length ? "商品资料补充词" : "根据商品资料推荐，点选即可"}</strong><p className="creative-help">这些是商品相关词，没有搜索热度数据。</p>{renderWords(suggested)}</div> : !reports.length && <p className="creative-note">添加详情图片或文字后，会自动整理候选词。也可以上传关键词表。</p>}
    <details className="creative-details"><summary>自己补充关键词</summary><label className="creative-custom">关键词<textarea rows={2} maxLength={2000} value={manual} onChange={e => setManual(e.target.value)} placeholder="可粘贴多个关键词，用逗号或换行分隔" /></label><button type="button" className="creative-secondary" disabled={busy || !manual.trim()} onClick={addManual}><Plus size={14} />添加并选中</button></details>
    {note && <p className="creative-note" role="status">{note}</p>}{error && <p className="creative-result-error" role="alert">{error}</p>}
  </section>;
}

export function CommerceLibrary({ products, templates, onUseProduct, onUseTemplate }: {
  products: CommerceSavedProduct[]; templates: CommerceSavedTemplate[];
  onUseProduct?: (product: CommerceSavedProduct) => void; onUseTemplate?: (template: CommerceSavedTemplate) => void;
}) {
  const values = onUseProduct ? products : templates;
  if (!values.length) return null;
  return <label className="creative-library-picker">{onUseProduct ? "使用已保存的商品资料" : "套用我的主图模板"}<select aria-label={onUseProduct ? "已保存的商品资料" : "我的主图模板"} value="" onChange={e => { const value = values.find(v => v.id === e.target.value); if (value) { if (onUseProduct) onUseProduct(value as CommerceSavedProduct); else onUseTemplate?.(value as CommerceSavedTemplate); } }}><option value="">{onUseProduct ? "选择商品，带入图片与卖点" : "选择模板，沿用模块和视觉配置"}</option>{values.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>;
}
