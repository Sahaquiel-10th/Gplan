import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Download, History, ImagePlus, LoaderCircle, Menu, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { commerceOptions as options, defaultCommerceBrief, type CommerceBrief, type CommercePublicJob, type CommerceRecognition, type CommerceSavedProduct, type CommerceSavedTemplate, type CommerceDeriveRequest } from "../server/commerceTypes";
import "./commerce.css";
import { CommerceModules, CompositionSummary } from "./CommerceModules";
import { defaultComposition, normalizeComposition } from "../server/commerceComposition";
import { CommerceKeywords, CommerceLibrary, CommerceMaterials } from "./CommerceMaterials";
import { CommerceResultCard } from "./CommerceResults";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type HistoryItem = { id: string; productName: string; platform: string; status: CommercePublicJob["status"]; phase: string; createdAt: string; completed: number; count: number };
const busyStatuses = ["planning", "queued", "generating"];
const assetUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;
const dateLabel = (s: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(s));

// Intent: an operator chooses a direction while the product image stays in view.
// Hierarchy: the current question leads; native choices use the workspace blue.
// Surfaces/type/spacing: white paper over the existing grey workspace, quiet borders,
// inherited Chinese system type, 14/16/24px hierarchy and a 4px spacing rhythm.
function Choices({ title, hint, values, selected, onSelect, multi = false }: {
  title: string; hint?: string; values: readonly string[]; selected: string | string[];
  onSelect: (value: string) => void; multi?: boolean;
}) {
  return <fieldset className="creative-question"><legend>{title}</legend>{hint && <p className="creative-help">{hint}</p>}
    <div className="creative-choices">{values.map(value => {
      const active = Array.isArray(selected) ? selected.includes(value) : selected === value;
      return <button type="button" key={value} aria-label={value} className={`creative-choice ${active ? "selected" : ""}`} aria-pressed={active} onClick={() => onSelect(value)}>
        <span className={multi ? "creative-checkbox" : "creative-radio"}>{active && <Check size={12} aria-hidden="true" />}</span>{value}
      </button>;
    })}</div>
  </fieldset>;
}

function UploadArea({ title, optional, ids, disabled, onUpload, onRemove }: {
  title: string; optional?: boolean; ids: string[]; disabled: boolean; onUpload: (files: File[]) => void; onRemove: (id: string) => void;
}) {
  return <div className="creative-upload-block"><div className="creative-label">{title}<span>{optional ? "选传" : "必需"} · 最多3张</span></div>
    <div className="creative-uploads">
      {ids.map((id, i) => <div className="creative-thumbnail" key={id}><img src={assetUrl(id)} alt={`${title}${i + 1}`} /><button type="button" aria-label={`移除${title}${i + 1}`} onClick={() => onRemove(id)} disabled={disabled}><X size={14} /></button></div>)}
      {ids.length < 3 && <label className={`creative-upload ${disabled ? "disabled" : ""}`}>
        <ImagePlus size={24} aria-hidden="true" /><strong>{ids.length ? "继续添加" : optional ? "添加参考图" : "上传商品白底图"}</strong>
        <span>{optional ? "借鉴排版或风格，不作为商品资料" : "保留包装、品牌与商品外观"}</span>
        <input aria-label={title} type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={e => { onUpload(Array.from(e.target.files || [])); e.target.value = ""; }} />
      </label>}
    </div>
  </div>;
}

function BriefSummary({ brief, onEdit }: { brief: CommerceBrief; onEdit?: () => void }) {
  return <aside className="creative-brief"><div className="creative-brief-top"><span>本次选择</span>{onEdit && <button type="button" className="creative-text-button" onClick={onEdit}>修改</button>}</div>
    {brief.productImageIds[0] ? <img className="creative-product" src={assetUrl(brief.productImageIds[0])} alt="本次商品白底图" /> : <div className="creative-product-empty"><ImagePlus size={32} aria-hidden="true" /><span>从一张商品白底图开始</span></div>}
    <strong className="creative-product-name">{brief.productName || "你的商品"}</strong><p className="creative-help">{[brief.brand, brief.specification].filter(Boolean).join(" · ") || "上传后可自动识别，支持修改"}</p>
    <dl><div><dt>平台</dt><dd>{brief.platform} · {brief.channel}</dd></div><div><dt>顾客</dt><dd>{brief.buyer}</dd></div><div><dt>方向</dt><dd>{brief.mode === "explore" ? "帮我探索" : brief.focus}</dd></div><div><dt>备选</dt><dd>{brief.count}个方向 · 按需逐张生成</dd></div></dl>
    {brief.facts.length > 0 && <div className="creative-selected-facts"><span>已选商品信息</span>{brief.facts.map(f => <p key={f}>{f}</p>)}</div>}
  </aside>;
}

export function CommerceWorkspace({ api, userId, agentId, onBack, onOpenSidebar }: {
  api: Api; userId: string; agentId: string; onBack: () => void; onOpenSidebar: () => void;
}) {
  const draftKey = `creative-draft-${userId}`;
  const lastKey = `creative-last-${userId}`;
  const [brief, setBrief] = useState<CommerceBrief>(() => {
    try { const stored = JSON.parse(sessionStorage.getItem(draftKey) || "null"); return { ...defaultCommerceBrief(), ...stored }; }
    catch { return defaultCommerceBrief(); }
  });
  const [step, setStep] = useState(0);
  const [job, setJob] = useState<CommercePublicJob>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [recognition, setRecognition] = useState<CommerceRecognition>();
  const [uploading, setUploading] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [moduleBusy, setModuleBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const [factsText, setFactsText] = useState("");
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const [keywordBusy, setKeywordBusy] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [products, setProducts] = useState<CommerceSavedProduct[]>([]);
  const [templates, setTemplates] = useState<CommerceSavedTemplate[]>([]);
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [productId, setProductId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [lightbox, setLightbox] = useState<{ id: string; name: string }>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestKey = useRef(crypto.randomUUID());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const uploadVersion = useRef(0);
  const mounted = useRef(true);

  const change = <K extends keyof CommerceBrief>(key: K, value: CommerceBrief[K]) => {
    setBrief(b => {
      const next = { ...b, [key]: value };
      if (key === "referenceImageIds" && b.composition && !next.referenceImageIds.includes(b.composition.primaryReferenceId)) {
        next.composition = { ...b.composition, primaryReferenceId: next.referenceImageIds[0] || "", reference: undefined,
          overall: { layout: "", background: "", palette: "", visualStyle: "" }, modules: b.composition.modules.map(m => ({ ...m, source: undefined, location: m.source ? "" : m.location, appearance: m.source ? "" : m.appearance })) };
      }
      return next;
    }); requestKey.current = crypto.randomUUID();
  };
  const patchBrief = (patch: Partial<CommerceBrief>) => {
    setBrief(b => ({ ...b, ...patch })); requestKey.current = crypto.randomUUID();
  };
  const mergeRecognition = (next: CommerceRecognition) => setRecognition(old => ({ ...next, facts: [...new Set([...(old?.facts || []), ...next.facts])], keywords: [...new Set([...(old?.keywords || []), ...next.keywords])] }));
  const loadLibrary = async () => {
    const result = await api<{ products: CommerceSavedProduct[]; templates: CommerceSavedTemplate[] }>("/api/commerce/library");
    if (mounted.current) { setProducts(result.products); setTemplates(result.templates); }
  };
  async function saveLibrary(kind: "products" | "templates") {
    if (savingLibrary) return;
    setSavingLibrary(true); setError("");
    try {
      const value = job?.brief || brief;
      const result = await api<{ product?: CommerceSavedProduct; template?: CommerceSavedTemplate }>(`/api/commerce/${kind}`, { method: "POST", body: JSON.stringify(kind === "products" ? { agentId, ...(productId ? { id: productId } : {}), name: value.productName, brief: value } : { agentId, ...(templateId ? { id: templateId } : {}), name: `${value.productName || "我的"}主图模板`, composition: value.composition || defaultComposition(value), referenceImageIds: value.referenceImageIds }) });
      if (!mounted.current) return;
      if (result.product) setProductId(result.product.id);
      if (result.template) setTemplateId(result.template.id);
      await loadLibrary(); setNotice(kind === "products" ? "商品资料已保存，下次可直接选择使用。" : "主图模板已保存，下次可直接套用并替换内容。");
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "保存失败"); }
    finally { if (mounted.current) setSavingLibrary(false); }
  }
  const toggle = (key: "facts" | "keywords", value: string) => {
    setBrief(b => ({ ...b, [key]: b[key].includes(value) ? b[key].filter(v => v !== value) : [...b[key], value].slice(0, key === "facts" ? 10 : 20) }));
    requestKey.current = crypto.randomUUID();
  };
  const loadHistory = async () => { const result = await api<{ jobs: HistoryItem[] }>("/api/commerce/jobs"); if (mounted.current) setHistory(result.jobs); return result.jobs; };
  const openJob = async (id: string) => {
    try { setError(""); const result = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${encodeURIComponent(id)}`); if (!mounted.current) return; setJob(result.job); sessionStorage.setItem(lastKey, id); setShowHistory(false); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "无法加载任务"); }
  };

  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify(brief)); }, [brief, draftKey]);
  useEffect(() => {
    mounted.current = true;
    void loadLibrary().catch(() => undefined);
    void (async () => {
      try {
        const config = await api<{ ready: boolean; message: string }>("/api/commerce/config");
        if (!mounted.current) return;
        setReady(config.ready); setConfigMessage(config.message);
        const jobs = await loadHistory();
        if (!mounted.current) return;
        const active = jobs.find(j => busyStatuses.includes(j.status));
        const last = sessionStorage.getItem(lastKey);
        if (active || last && jobs.some(j => j.id === last)) await openJob(active?.id || last!);
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "加载失败"); }
    })();
    return () => { mounted.current = false; uploadVersion.current++; };
  }, [agentId, userId]);

  useEffect(() => {
    if (!job || !busyStatuses.includes(job.status)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${job.id}`);
        if (stopped) return;
        setJob(result.job);
        if (!busyStatuses.includes(result.job.status)) { void loadHistory().catch(() => undefined); return; }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "状态更新失败，将继续重试"); }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, job?.status]);

  useEffect(() => { if (step > 0) headingRef.current?.focus(); }, [step]);
  useEffect(() => { if (lightbox) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [lightbox]);

  async function recognize(ids = brief.productImageIds) {
    const version = uploadVersion.current;
    setRecognizing(true); setNotice("");
    try {
      const { recognition } = await api<{ recognition: CommerceRecognition }>("/api/commerce/recognize", { method: "POST", body: JSON.stringify({ imageIds: ids }) });
      if (!mounted.current || version !== uploadVersion.current) return;
      mergeRecognition(recognition);
      setBrief(b => ({ ...b, productName: b.productName || recognition.productName, brand: b.brand || recognition.brand, specification: b.specification || recognition.specification }));
      setNotice("已读取包装信息，请核对商品名称和规格，再勾选可使用的卖点。");
    } catch (e) { if (mounted.current && version === uploadVersion.current) setNotice(`自动识别暂未完成，可以直接填写商品资料。${e instanceof Error ? e.message : ""}`); }
    finally { if (mounted.current && version === uploadVersion.current) setRecognizing(false); }
  }

  async function upload(files: File[], key: "productImageIds" | "referenceImageIds") {
    if (!files.length || uploading) return;
    const chosen = files.slice(0, 3 - brief[key].length);
    if (chosen.some(f => !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 10 * 1024 * 1024)) { setError("请上传10MB以内的 PNG、JPG 或 WebP 图片"); return; }
    setUploading(true); setError(""); uploadVersion.current++;
    try {
      const form = new FormData(); chosen.forEach(f => form.append("files", f));
      const { attachments } = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
      if (!mounted.current) return;
      const ids = [...brief[key], ...attachments.map(a => a.id)];
      change(key, ids);
      if (key === "productImageIds") void recognize(ids);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "图片上传失败"); }
    finally { if (mounted.current) setUploading(false); }
  }

  async function plan() {
    setWorking(true); setError(""); setNotice("");
    try {
      const composition = normalizeComposition(brief.composition || defaultComposition(brief), brief.referenceImageIds);
      const nextBrief = { ...brief, composition };
      setBrief(nextBrief);
      const result = await api<{ job: CommercePublicJob }>("/api/commerce/jobs", { method: "POST", body: JSON.stringify({ brief: nextBrief, agentId, requestKey: requestKey.current }) });
      setJob(result.job); sessionStorage.setItem(lastKey, result.job.id); void loadHistory().catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : "整理方案失败"); }
    finally { setWorking(false); }
  }

  async function jobAction(action: "generate" | "retry", variantId?: string, referenceImageId?: string) {
    if (!job || working) return;
    setWorking(true); setError("");
    try {
      await api(`/api/commerce/jobs/${job.id}/${action}`, { method: "POST", body: JSON.stringify({ variantId, ...(referenceImageId !== undefined ? { referenceImageId } : {}) }) });
      await openJob(job.id); void loadHistory().catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setWorking(false); }
  }

  async function derive(request: CommerceDeriveRequest) {
    if (!job || working) return;
    setWorking(true); setError("");
    try {
      const result = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${job.id}/derive`, { method: "POST", body: JSON.stringify(request) });
      if (!mounted.current) return;
      setJob(result.job); sessionStorage.setItem(lastKey, result.job.id); void loadHistory().catch(() => undefined);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "制作失败"); }
    finally { if (mounted.current) setWorking(false); }
  }

  function editJob() {
    uploadVersion.current++; setFormEpoch(v => v + 1); setRecognizing(false);
    if (job) setBrief(job.brief);
    setJob(undefined); setStep(0); setError(""); setNotice("");
    sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID();
  }
  function newTask() {
    uploadVersion.current++; setFormEpoch(v => v + 1); setRecognizing(false);
    setProductId(""); setTemplateId("");
    setJob(undefined); setStep(0); setBrief(defaultCommerceBrief()); setRecognition(undefined); setNotice(""); setError("");
    sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID();
  }
  const complete = job?.variants.filter(v => v.status === "completed").length || 0;
  const inProgress = !!job && busyStatuses.includes(job.status);
  const allFactOptions = [...new Set([...(recognition?.facts || []), ...brief.facts])];
  const steps = ["商品资料", "主图模块", "顾客与场景", "表达重点"];

  return <section className="creative-workspace">
    <header className="creative-header"><div className="creative-header-title"><button type="button" className="mobile-menu" onClick={onOpenSidebar} aria-label="打开导航"><Menu size={20} /></button><button type="button" className="creative-icon-button" onClick={onBack} aria-label="返回智能体"><ArrowLeft size={19} /></button><div><h1>电商主图与标题助手</h1><p>把思路选清楚，让每一张图都有重点。</p></div></div>
      <button type="button" className="creative-secondary" onClick={() => { setShowHistory(!showHistory); void loadHistory().catch(e => setError(e.message)); }} aria-expanded={showHistory}><History size={16} aria-hidden="true" />创作记录</button>
    </header>
    <div className="creative-body">
      {error && <div role="alert" className="error creative-alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
      {configMessage && <div className="notice creative-alert">{configMessage}</div>}
      {showHistory && <section className="creative-history"><div className="creative-section-title"><h2>创作记录</h2><button type="button" className="creative-text-button" onClick={() => setShowHistory(false)}>收起</button></div>
        {!history.length && <p className="creative-help">还没有创作记录。完成选择后，就会保存在这里。</p>}
        {history.map(item => <button type="button" key={item.id} onClick={() => void openJob(item.id)}><span><strong>{item.productName}</strong><small>{item.platform} · {dateLabel(item.createdAt)}</small></span><span>{item.status === "review" ? "待生成" : `${item.completed}/${item.count}张`}<ArrowRight size={16} aria-hidden="true" /></span></button>)}
      </section>}

      {!job ? <>
        <nav className="creative-steps" aria-label="制作步骤">{steps.map((label, i) => <button type="button" key={label} aria-label={label} aria-current={step === i ? "step" : undefined} disabled={i > step || moduleBusy} onClick={() => setStep(i)}><span>{i < step ? <Check size={14} aria-hidden="true" /> : `0${i + 1}`}</span>{label}</button>)}</nav>
        <div className={`creative-layout ${step === 1 ? "creative-layout-modules" : ""}`}><div className="creative-form"><div className="creative-form-heading"><span>第 {step + 1} 步 / 共 4 步</span><h2 ref={headingRef} tabIndex={-1}>{["先认识这件商品", "这张主图，要放哪些内容？", "这张图，要打动谁？", "让顾客先看到什么？"][step]}</h2><p>{["上传白底图，核对商品资料。参考图选传。", "对照原图，选好模块，换成自己的内容。", "购买的人和使用的人可能不同，选择最接近的情况就好。", "有明确想法就直接选；拿不准时，让 AI 给你几个起点。"][step]}</p></div>
          {step === 0 && <>
            <CommerceLibrary products={products} templates={templates} onUseProduct={value => { setProductId(value.id); setTemplateId(""); uploadVersion.current++; setRecognizing(false); setRecognition(undefined); setFormEpoch(v => v + 1); setBrief({ ...defaultCommerceBrief(), ...value.brief }); requestKey.current = crypto.randomUUID(); setNotice("已带入商品资料，可直接核对或继续添加。"); }} />
            <UploadArea title="商品白底图" ids={brief.productImageIds} disabled={uploading || recognizing} onUpload={files => void upload(files, "productImageIds")} onRemove={id => { uploadVersion.current++; setRecognizing(false); change("productImageIds", brief.productImageIds.filter(x => x !== id)); }} />
            <div aria-live="polite" className="creative-inline-status">{uploading ? <><LoaderCircle size={15} className="creative-spin" />正在上传图片…</> : recognizing ? <><LoaderCircle size={15} className="creative-spin" />正在读取包装上的商品信息…</> : brief.productImageIds.length > 0 ? <button type="button" className="creative-text-button" onClick={() => void recognize()} disabled={!ready}><RefreshCw size={14} aria-hidden="true" />重新识别商品信息</button> : "支持 PNG、JPG、WebP，每张不超过10MB"}</div>
            {notice && <p className="creative-note" role="status">{notice}</p>}
            <div className="creative-fields"><label>商品名称<input value={brief.productName} onChange={e => change("productName", e.target.value)} maxLength={120} placeholder="上传后识别，也可以直接填写" /></label><label>品牌 <span>选填</span><input value={brief.brand} onChange={e => change("brand", e.target.value)} maxLength={80} placeholder="如包装上标明的品牌" /></label><label className="creative-field-wide">本次展示的规格／组合 <span>选填</span><input value={brief.specification} onChange={e => change("specification", e.target.value)} maxLength={160} placeholder="例如：20片装；多件组合请分别写明" /></label></div>
            <CommerceMaterials key={`materials-${formEpoch}`} api={api} brief={brief} onChange={patchBrief} onRecognition={mergeRecognition} onBusy={setMaterialsBusy} />
            <Choices title="商品属于哪个品类？" values={options.categories} selected={brief.category} onSelect={v => change("category", v)} />
            {allFactOptions.length > 0 && <Choices title="哪些商品信息可以用于主图？" hint="只勾选已核对的包装信息和卖点，不确定的先不选。" values={allFactOptions} selected={brief.facts} multi onSelect={v => toggle("facts", v)} />}
            <details className="creative-details"><summary>{brief.facts.length ? "补充其他商品信息" : "添加可使用的商品卖点（选填）"}</summary><label className="creative-custom">品牌资料中的原文<input value={factsText} onChange={e => setFactsText(e.target.value)} maxLength={120} placeholder="一次添加一条，保留真实信息" /></label><button type="button" className="creative-secondary" disabled={!factsText.trim() || brief.facts.length >= 10} onClick={() => { if (!brief.facts.includes(factsText.trim())) change("facts", [...brief.facts, factsText.trim()]); setFactsText(""); }}><Plus size={14} />添加卖点</button></details>
            <button type="button" className="creative-text-button" disabled={savingLibrary || materialsBusy || !brief.productImageIds.length || !brief.productName.trim()} onClick={() => void saveLibrary("products")}><Plus size={14} />保存这件商品，下次直接使用</button>
            <UploadArea title="参考图" optional ids={brief.referenceImageIds} disabled={uploading || recognizing} onUpload={files => void upload(files, "referenceImageIds")} onRemove={id => change("referenceImageIds", brief.referenceImageIds.filter(x => x !== id))} />
          </>}
          {step === 1 && <>
            <CommerceLibrary products={products} templates={templates} onUseTemplate={value => { setTemplateId(value.id); patchBrief({ referenceImageIds: value.referenceImageIds, composition: value.composition }); setNotice("已套用模板，请核对模块内容并替换成本次商品信息。"); }} />
            <CommerceModules key={`modules-${formEpoch}`} api={api} brief={brief} onChange={value => change("composition", value)} onBusy={setModuleBusy} />
            <button type="button" className="creative-text-button" disabled={savingLibrary || moduleBusy} onClick={() => void saveLibrary("templates")}><Plus size={14} />保存为我的主图模板</button>
          </>}
          {step === 2 && <>
            <Choices title="在哪个平台使用？" values={options.platforms} selected={brief.platform} onSelect={v => change("platform", v)} />
            <Choices title="顾客从哪里看到它？" values={options.channels} selected={brief.channel} onSelect={v => change("channel", v)} />
            <Choices title="主要是谁买、给谁用？" values={options.buyers} selected={brief.buyer} onSelect={v => change("buyer", v)} />
            <Choices title="顾客对产品有多熟悉？" hint="这里说的是使用经验，和是否第一次来你的店不同。" values={options.familiarity} selected={brief.familiarity} onSelect={v => change("familiarity", v)} />
            <CommerceKeywords key={`keywords-${formEpoch}`} api={api} brief={brief} packagingKeywords={recognition?.keywords || []} onChange={patchBrief} onBusy={setKeywordBusy} />
          </>}
          {step === 3 && <>
            <div className="creative-mode-choices"><button type="button" className={brief.mode === "explore" ? "selected" : ""} aria-pressed={brief.mode === "explore"} onClick={() => change("mode", "explore")}><Sparkles size={21} aria-hidden="true" /><strong>帮我探索</strong><span>给我几个有依据的方向，从中找思路</span></button><button type="button" className={brief.mode === "direct" ? "selected" : ""} aria-pressed={brief.mode === "direct"} onClick={() => change("mode", "direct")}><Check size={21} aria-hidden="true" /><strong>我有明确方向</strong><span>围绕我选的重点，尝试不同表达</span></button></div>
            {brief.mode === "direct" && <Choices title="只选一个主要重点" values={options.focuses} selected={brief.focus} onSelect={v => change("focus", v)} />}
            <Choices title="这次为什么制作主图？" values={options.goals} selected={brief.goal} onSelect={v => change("goal", v)} />
            <Choices title="希望是什么感觉？" values={options.styles.filter(s => s !== "沿用参考图结构" || brief.referenceImageIds.length > 0)} selected={brief.style} onSelect={v => change("style", v)} />
            <fieldset className="creative-question"><legend>排版偏好</legend><div className="creative-layout-choices">{options.layouts.map((layout, i) => <button type="button" key={layout} className={brief.layout === layout ? "selected" : ""} aria-pressed={brief.layout === layout} onClick={() => change("layout", layout)}><span className={`creative-layout-sketch sketch-${i}`} aria-hidden="true"><i /><b /></span>{layout}</button>)}</div></fieldset>
            <Choices title="先给几个创意方向？" hint="只整理方案和商品标题，选中哪张才生成哪张图片。" values={["4套", "5套"]} selected={`${brief.count}套`} onSelect={v => change("count", v === "4套" ? 4 : 5)} />
            <CompositionSummary value={brief.composition || defaultComposition(brief)} /><details className="creative-details"><summary>补充其他要求（选填）</summary><label className="creative-custom">其他要求<textarea value={brief.notes} onChange={e => change("notes", e.target.value)} maxLength={500} rows={2} placeholder="例如：使用人群、季节场景、保留某个文字、不要出现的内容" /></label></details>
          </>}
          <footer className="creative-form-footer"><button type="button" className="creative-secondary" disabled={step === 0 || working || moduleBusy || materialsBusy || keywordBusy} onClick={() => setStep(step - 1)}>上一步</button>{step < 3 ? <button type="button" className="creative-primary" disabled={uploading || recognizing || moduleBusy || materialsBusy || keywordBusy || step === 0 && (!brief.productImageIds.length || !brief.productName.trim())} onClick={() => { try { if (step === 1) normalizeComposition(brief.composition || defaultComposition(brief), brief.referenceImageIds); setError(""); setStep(step + 1); } catch (e) { setError(e instanceof Error ? e.message : "请核对模块配置"); } }}>下一步<ArrowRight size={16} aria-hidden="true" /></button> : <button type="button" className="creative-primary" disabled={working || !ready} onClick={() => void plan()}>{working ? <LoaderCircle size={16} className="creative-spin" /> : <Sparkles size={16} aria-hidden="true" />}整理本次方案</button>}</footer>
        </div>{step !== 1 && <BriefSummary brief={brief} />}</div>
      </> : <>
        <div className="creative-job-heading"><div><span className="creative-eyebrow">{job.brief.platform} · {job.brief.mode === "explore" ? "帮我探索" : "明确方向"}</span><h2>{job.brief.productName}</h2><p>{job.phase}</p></div><div className="creative-job-actions">{job.sourceJobId && <button type="button" className="creative-secondary" onClick={() => void openJob(job.sourceJobId!)}><ArrowLeft size={15} />返回原主图</button>}{!inProgress && <button type="button" className="creative-secondary" onClick={editJob}>修改选择</button>}{!inProgress && <button type="button" className="creative-secondary" onClick={newTask}><Plus size={15} />新建创作</button>}{complete > 0 && <a className="creative-secondary" href={`/api/commerce/jobs/${job.id}/download`}><Download size={16} aria-hidden="true" />打包下载</a>}{complete > 0 && <a className="creative-secondary" href={`/api/commerce/jobs/${job.id}/download?handoff=1`}><Download size={16} aria-hidden="true" />交给视觉完善</a>}</div></div>
        {job.error && <p className="creative-note" role="alert">{job.error}</p>}
        {job.status === "planning" ? <div className="creative-planning"><LoaderCircle size={32} className="creative-spin" /><h3>把你的选择整理成几个起点</h3><p>正在分析商品资料、人群与参考图，再安排不同的画面和标题。</p><span>可以离开页面，稍后从创作记录继续查看。</span></div> : <>
          {job.summary && <div className="creative-plan-summary"><div><span className="creative-eyebrow">本次方案摘要</span><p>{job.summary}</p></div><details><summary>查看本次选择</summary><dl><div><dt>人群与经验</dt><dd>{job.brief.buyer} · {job.brief.familiarity}</dd></div><div><dt>渠道与关键词</dt><dd>{job.brief.channel} · {job.brief.keywords.join("、") || "未指定关键词"}</dd></div><div><dt>规格与优惠</dt><dd>{[job.brief.specification, job.brief.composition ? "" : job.brief.offer].filter(Boolean).join("；") || "未指定"}</dd></div><div><dt>商品信息</dt><dd>{job.brief.facts.join("；") || "仅使用商品名称和包装信息"}</dd></div></dl></details></div>}
          <details className="creative-details"><summary>查看主图模块与保存资料</summary><CompositionSummary value={job.brief.composition} /><div className="creative-module-tools"><button type="button" className="creative-text-button" disabled={savingLibrary} onClick={() => void saveLibrary("products")}>保存商品资料</button><button type="button" className="creative-text-button" disabled={savingLibrary} onClick={() => void saveLibrary("templates")}>保存为我的主图模板</button></div></details>
          {job.variants.some(v => v.status === "pending" && !v.selected) && <div className="creative-generate-bar"><p>先选方向和这张要用的参考，再点「生成这张」。每张独立制作，不会自动生成整组。</p><span className="creative-muted">方图 1440 × 1440 · 竖图宽 1440 × 高 1920</span></div>}
          {inProgress && <div className="creative-progress" role="status"><LoaderCircle size={18} className="creative-spin" /><div><strong>{job.phase}</strong><span>已完成 {complete}/{job.variants.length} 张，完成的图片可以先查看和下载。</span></div><progress value={complete} max={job.variants.length || 1} aria-label="主图制作进度" /></div>}
          {!job.variants.length && ["failed", "interrupted"].includes(job.status) && <button type="button" className="creative-primary" disabled={working} onClick={() => void jobAction("retry")}><RefreshCw size={16} />重新整理方案</button>}
          <div className="creative-results">{job.variants.map((variant, i) => <CommerceResultCard key={`${job.id}-${variant.id}`} api={api} job={job} variant={variant} index={i} busy={working || inProgress} ready={ready} onGenerate={(id, reference, retry) => jobAction(retry ? "retry" : "generate", id, reference)} onDerive={derive} onPreview={(id, name) => setLightbox({ id, name })} onNotice={setNotice} onError={setError} />)}</div>
          {job.variants.length > 0 && <p className="creative-result-footnote">方案理由用于帮助比较方向。实际点击表现需要在相同投放条件下验证；使用前请核对商品外观、文字和优惠信息。</p>}
        </>}
      </>}
      {notice && job && <div className="creative-toast" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
    <dialog ref={dialogRef} className="creative-lightbox" onCancel={() => setLightbox(undefined)} onClick={e => { if (e.target === e.currentTarget) setLightbox(undefined); }}><div><strong>{lightbox?.name}</strong><button type="button" autoFocus className="creative-icon-button" aria-label="关闭大图" onClick={() => setLightbox(undefined)}><X size={20} /></button></div>{lightbox && <img src={assetUrl(lightbox.id)} alt={lightbox.name} />}</dialog>
  </section>;
}
