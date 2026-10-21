import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Download, History, ImagePlus, LoaderCircle, Menu, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { commerceOptions as options, defaultCommerceBrief, type CommerceBrief, type CommercePublicJob, type CommerceRecognition } from "../server/commerceTypes";
import "./commerce.css";

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
    <dl><div><dt>平台</dt><dd>{brief.platform} · {brief.channel}</dd></div><div><dt>顾客</dt><dd>{brief.buyer}</dd></div><div><dt>方向</dt><dd>{brief.mode === "explore" ? "帮我探索" : brief.focus}</dd></div><div><dt>备选</dt><dd>{brief.count}张独立主图 + {brief.count}条标题</dd></div></dl>
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
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const [factsText, setFactsText] = useState("");
  const [keywordText, setKeywordText] = useState("");
  const [lightbox, setLightbox] = useState<{ id: string; name: string }>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestKey = useRef(crypto.randomUUID());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const uploadVersion = useRef(0);
  const mounted = useRef(true);

  const change = <K extends keyof CommerceBrief>(key: K, value: CommerceBrief[K]) => {
    setBrief(b => ({ ...b, [key]: value })); requestKey.current = crypto.randomUUID();
  };
  const toggle = (key: "facts" | "keywords", value: string) => {
    setBrief(b => ({ ...b, [key]: b[key].includes(value) ? b[key].filter(v => v !== value) : [...b[key], value].slice(0, key === "facts" ? 10 : 5) }));
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
      setRecognition(recognition);
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
      const result = await api<{ job: CommercePublicJob }>("/api/commerce/jobs", { method: "POST", body: JSON.stringify({ brief, agentId, requestKey: requestKey.current }) });
      setJob(result.job); sessionStorage.setItem(lastKey, result.job.id); void loadHistory().catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : "整理方案失败"); }
    finally { setWorking(false); }
  }

  async function jobAction(action: "generate" | "retry", variantId?: string) {
    if (!job || working) return;
    setWorking(true); setError("");
    try {
      await api(`/api/commerce/jobs/${job.id}/${action}`, { method: "POST", body: JSON.stringify({ variantId }) });
      await openJob(job.id); void loadHistory().catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setWorking(false); }
  }

  function editJob() {
    if (job) setBrief(job.brief);
    setJob(undefined); setStep(0); setError(""); setNotice("");
    sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID();
  }
  function newTask() {
    setJob(undefined); setStep(0); setBrief(defaultCommerceBrief()); setRecognition(undefined); setNotice(""); setError("");
    sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID();
  }
  const complete = job?.variants.filter(v => v.status === "completed").length || 0;
  const inProgress = !!job && busyStatuses.includes(job.status);
  const allFactOptions = [...new Set([...(recognition?.facts || []), ...brief.facts])];
  const keywordOptions = [...new Set([...(recognition?.keywords || []), brief.productName, brief.category, ...brief.keywords].filter(Boolean))];
  const steps = ["商品资料", "顾客与场景", "表达重点"];

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
        <nav className="creative-steps" aria-label="制作步骤">{steps.map((label, i) => <button type="button" key={label} aria-label={label} aria-current={step === i ? "step" : undefined} disabled={i > step} onClick={() => setStep(i)}><span>{i < step ? <Check size={14} aria-hidden="true" /> : `0${i + 1}`}</span>{label}</button>)}</nav>
        <div className="creative-layout"><div className="creative-form"><div className="creative-form-heading"><span>第 {step + 1} 步 / 共 3 步</span><h2 ref={headingRef} tabIndex={-1}>{["先认识这件商品", "这张图，要打动谁？", "让顾客先看到什么？"][step]}</h2><p>{["上传白底图，核对商品资料。参考图可以稍后添加。", "购买的人和使用的人可能不同，选择最接近的情况就好。", "有明确想法就直接选；拿不准时，让 AI 给你几个起点。"][step]}</p></div>
          {step === 0 && <>
            <UploadArea title="商品白底图" ids={brief.productImageIds} disabled={uploading || recognizing} onUpload={files => void upload(files, "productImageIds")} onRemove={id => { uploadVersion.current++; setRecognizing(false); change("productImageIds", brief.productImageIds.filter(x => x !== id)); }} />
            <div aria-live="polite" className="creative-inline-status">{uploading ? <><LoaderCircle size={15} className="creative-spin" />正在上传图片…</> : recognizing ? <><LoaderCircle size={15} className="creative-spin" />正在读取包装上的商品信息…</> : brief.productImageIds.length > 0 ? <button type="button" className="creative-text-button" onClick={() => void recognize()} disabled={!ready}><RefreshCw size={14} aria-hidden="true" />重新识别商品信息</button> : "支持 PNG、JPG、WebP，每张不超过10MB"}</div>
            {notice && <p className="creative-note" role="status">{notice}</p>}
            <div className="creative-fields"><label>商品名称<input value={brief.productName} onChange={e => change("productName", e.target.value)} maxLength={120} placeholder="上传后识别，也可以直接填写" /></label><label>品牌 <span>选填</span><input value={brief.brand} onChange={e => change("brand", e.target.value)} maxLength={80} placeholder="如包装上标明的品牌" /></label><label className="creative-field-wide">本次展示的规格／组合 <span>选填</span><input value={brief.specification} onChange={e => change("specification", e.target.value)} maxLength={160} placeholder="例如：20片装；多件组合请分别写明" /></label></div>
            <Choices title="商品属于哪个品类？" values={options.categories} selected={brief.category} onSelect={v => change("category", v)} />
            {allFactOptions.length > 0 && <Choices title="哪些商品信息可以用于主图？" hint="只勾选已核对的包装信息和卖点，不确定的先不选。" values={allFactOptions} selected={brief.facts} multi onSelect={v => toggle("facts", v)} />}
            <details className="creative-details"><summary>{brief.facts.length ? "补充其他商品信息" : "添加可使用的商品卖点（选填）"}</summary><label className="creative-custom">品牌资料中的原文<input value={factsText} onChange={e => setFactsText(e.target.value)} maxLength={120} placeholder="一次添加一条，保留真实信息" /></label><button type="button" className="creative-secondary" disabled={!factsText.trim() || brief.facts.length >= 10} onClick={() => { if (!brief.facts.includes(factsText.trim())) change("facts", [...brief.facts, factsText.trim()]); setFactsText(""); }}><Plus size={14} />添加卖点</button></details>
            <UploadArea title="参考图" optional ids={brief.referenceImageIds} disabled={uploading || recognizing} onUpload={files => void upload(files, "referenceImageIds")} onRemove={id => change("referenceImageIds", brief.referenceImageIds.filter(x => x !== id))} />
          </>}
          {step === 1 && <>
            <Choices title="在哪个平台使用？" values={options.platforms} selected={brief.platform} onSelect={v => change("platform", v)} />
            <Choices title="顾客从哪里看到它？" values={options.channels} selected={brief.channel} onSelect={v => change("channel", v)} />
            <Choices title="主要是谁买、给谁用？" values={options.buyers} selected={brief.buyer} onSelect={v => change("buyer", v)} />
            <Choices title="顾客对产品有多熟悉？" hint="这里说的是使用经验，和是否第一次来你的店不同。" values={options.familiarity} selected={brief.familiarity} onSelect={v => change("familiarity", v)} />
            <Choices title={brief.channel === "搜索结果" ? "顾客可能搜索什么？" : "这次希望关联哪些商品词？"} hint="可以多选，最多5个；这些是候选词，不代表搜索热度。" values={keywordOptions} selected={brief.keywords} multi onSelect={v => toggle("keywords", v)} />
            <details className="creative-details"><summary>补充关键词（选填）</summary><label className="creative-custom">关键词<input value={keywordText} onChange={e => setKeywordText(e.target.value)} maxLength={120} placeholder="例如：日常护理、旅行便携" /></label><button type="button" className="creative-secondary" disabled={!keywordText.trim() || brief.keywords.length >= 5} onClick={() => { if (!brief.keywords.includes(keywordText.trim())) change("keywords", [...brief.keywords, keywordText.trim()]); setKeywordText(""); }}><Plus size={14} />添加关键词</button></details>
          </>}
          {step === 2 && <>
            <div className="creative-mode-choices"><button type="button" className={brief.mode === "explore" ? "selected" : ""} aria-pressed={brief.mode === "explore"} onClick={() => change("mode", "explore")}><Sparkles size={21} aria-hidden="true" /><strong>帮我探索</strong><span>给我几个有依据的方向，从中找思路</span></button><button type="button" className={brief.mode === "direct" ? "selected" : ""} aria-pressed={brief.mode === "direct"} onClick={() => change("mode", "direct")}><Check size={21} aria-hidden="true" /><strong>我有明确方向</strong><span>围绕我选的重点，尝试不同表达</span></button></div>
            {brief.mode === "direct" && <Choices title="只选一个主要重点" values={options.focuses} selected={brief.focus} onSelect={v => change("focus", v)} />}
            <Choices title="这次为什么制作主图？" values={options.goals} selected={brief.goal} onSelect={v => change("goal", v)} />
            <Choices title="希望是什么感觉？" values={options.styles.filter(s => s !== "沿用参考图结构" || brief.referenceImageIds.length > 0)} selected={brief.style} onSelect={v => change("style", v)} />
            <fieldset className="creative-question"><legend>排版偏好</legend><div className="creative-layout-choices">{options.layouts.map((layout, i) => <button type="button" key={layout} className={brief.layout === layout ? "selected" : ""} aria-pressed={brief.layout === layout} onClick={() => change("layout", layout)}><span className={`creative-layout-sketch sketch-${i}`} aria-hidden="true"><i /><b /></span>{layout}</button>)}</div></fieldset>
            <Choices title="需要几套备选？" hint="每张主图分别制作、分别保存。" values={["4套", "5套"]} selected={`${brief.count}套`} onSelect={v => change("count", v === "4套" ? 4 : 5)} />
            <details className="creative-details"><summary>价格、赠品与其他要求（选填）</summary><label className="creative-custom">本次真实优惠或赠品<textarea value={brief.offer} onChange={e => change("offer", e.target.value)} maxLength={300} rows={2} placeholder="没有可留空；有条件的优惠请一并写明" /></label><label className="creative-custom">其他要求<textarea value={brief.notes} onChange={e => change("notes", e.target.value)} maxLength={500} rows={2} placeholder="例如：使用人群、季节场景、保留某个文字、不要出现的内容" /></label></details>
          </>}
          <footer className="creative-form-footer"><button type="button" className="creative-secondary" disabled={step === 0 || working} onClick={() => setStep(step - 1)}>上一步</button>{step < 2 ? <button type="button" className="creative-primary" disabled={uploading || recognizing || step === 0 && (!brief.productImageIds.length || !brief.productName.trim())} onClick={() => { setError(""); setStep(step + 1); }}>下一步<ArrowRight size={16} aria-hidden="true" /></button> : <button type="button" className="creative-primary" disabled={working || !ready} onClick={() => void plan()}>{working ? <LoaderCircle size={16} className="creative-spin" /> : <Sparkles size={16} aria-hidden="true" />}整理本次方案</button>}</footer>
        </div><BriefSummary brief={brief} /></div>
      </> : <>
        <div className="creative-job-heading"><div><span className="creative-eyebrow">{job.brief.platform} · {job.brief.mode === "explore" ? "帮我探索" : "明确方向"}</span><h2>{job.brief.productName}</h2><p>{job.phase}</p></div><div className="creative-job-actions">{!inProgress && <button type="button" className="creative-secondary" onClick={editJob}>修改选择</button>}{!inProgress && <button type="button" className="creative-secondary" onClick={newTask}><Plus size={15} />新建创作</button>}{complete > 0 && <a className="creative-secondary" href={`/api/commerce/jobs/${job.id}/download`}><Download size={16} aria-hidden="true" />打包下载</a>}</div></div>
        {job.error && <p className="creative-note" role="alert">{job.error}</p>}
        {job.status === "planning" ? <div className="creative-planning"><LoaderCircle size={32} className="creative-spin" /><h3>把你的选择整理成几个起点</h3><p>正在分析商品资料、人群与参考图，再安排不同的画面和标题。</p><span>可以离开页面，稍后从创作记录继续查看。</span></div> : <>
          {job.summary && <div className="creative-plan-summary"><div><span className="creative-eyebrow">本次方案摘要</span><p>{job.summary}</p></div><details><summary>查看本次选择</summary><dl><div><dt>人群与经验</dt><dd>{job.brief.buyer} · {job.brief.familiarity}</dd></div><div><dt>渠道与关键词</dt><dd>{job.brief.channel} · {job.brief.keywords.join("、") || "未指定关键词"}</dd></div><div><dt>规格与优惠</dt><dd>{[job.brief.specification, job.brief.offer].filter(Boolean).join("；") || "未指定"}</dd></div><div><dt>商品信息</dt><dd>{job.brief.facts.join("；") || "仅使用商品名称和包装信息"}</dd></div></dl></details></div>}
          {job.status === "review" && <div className="creative-generate-bar"><p>下面是准备尝试的 {job.variants.length} 个方向。主图将依次、逐张制作。</p><button type="button" className="creative-primary" disabled={working || !ready} onClick={() => void jobAction("generate")}><ImagePlus size={17} aria-hidden="true" />开始生成 {job.variants.length} 张主图</button></div>}
          {inProgress && <div className="creative-progress" role="status"><LoaderCircle size={18} className="creative-spin" /><div><strong>{job.phase}</strong><span>已完成 {complete}/{job.variants.length} 张，完成的图片可以先查看和下载。</span></div><progress value={complete} max={job.variants.length || 1} aria-label="主图制作进度" /></div>}
          {!job.variants.length && ["failed", "interrupted"].includes(job.status) && <button type="button" className="creative-primary" disabled={working} onClick={() => void jobAction("retry")}><RefreshCw size={16} />重新整理方案</button>}
          <div className="creative-results">{job.variants.map((variant, i) => <article key={variant.id} className="creative-result"><div className="creative-result-label"><span>方案 0{i + 1}</span><strong>{variant.name}</strong></div>
            {variant.imageAttachmentId ? <button type="button" className="creative-result-image" aria-label={`放大查看${variant.name}`} onClick={() => setLightbox({ id: variant.imageAttachmentId!, name: variant.name })}><img src={assetUrl(variant.imageAttachmentId)} alt={`${job.brief.productName} · ${variant.name}`} loading="lazy" /></button> : <div className={`creative-result-placeholder ${variant.status === "generating" ? "is-generating" : ""}`}>{variant.status === "generating" ? <><LoaderCircle size={28} className="creative-spin" /><strong>正在制作这一张</strong></> : <><div className="creative-idea"><span>{variant.headline || job.brief.productName}</span>{job.brief.productImageIds[0] && <img src={assetUrl(job.brief.productImageIds[0])} alt="方案使用的原商品图" />}<small>{variant.subline}</small></div><span>{variant.status === "failed" ? "这一张暂未完成" : job.status === "review" ? "方向预览 · 尚未生成主图" : "等待制作"}</span></>}</div>}
            <div className="creative-result-body"><span className="creative-platform-label">{job.brief.platform} · 商品标题</span><h3>{variant.title}</h3><p className="creative-reason">{variant.reason}</p><details><summary>标题为什么这样写？</summary><p>{variant.titleReason}</p></details>
              {variant.qualityNote && <p className={`creative-quality ${variant.quality === "review" ? "needs-review" : ""}`}>{variant.quality === "passed" ? <Check size={14} aria-hidden="true" /> : <span aria-hidden="true">!</span>}{variant.qualityNote}</p>}
              {variant.error && <p className="creative-result-error" role="alert">{variant.error}</p>}
              {!!variant.previousImageIds?.length && <details><summary>之前的图片（{variant.previousImageIds.length}）</summary><div className="creative-result-actions">{variant.previousImageIds.map((id, n) => <a key={id} href={`${assetUrl(id)}?download=1`} download><Download size={14} aria-hidden="true" />第{n + 1}版</a>)}</div></details>}
              <div className="creative-result-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(variant.title).then(() => setNotice("标题已复制"), () => setError("复制失败，请手动选择标题复制"))}><Copy size={14} aria-hidden="true" />复制标题</button>{variant.imageAttachmentId && <a href={`${assetUrl(variant.imageAttachmentId)}?download=1`} download><Download size={14} aria-hidden="true" />下载主图</a>}{!inProgress && job.status !== "review" && <button type="button" disabled={working} onClick={() => void jobAction("retry", variant.id)}><RefreshCw size={14} aria-hidden="true" />{variant.status === "failed" ? "重试这张" : "再做一张"}</button>}</div>
            </div></article>)}</div>
          {job.variants.length > 0 && <p className="creative-result-footnote">方案理由用于帮助比较方向。实际点击表现需要在相同投放条件下验证；使用前请核对商品外观、文字和优惠信息。</p>}
        </>}
      </>}
      {notice && job && <div className="creative-toast" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
    <dialog ref={dialogRef} className="creative-lightbox" onCancel={() => setLightbox(undefined)} onClick={e => { if (e.target === e.currentTarget) setLightbox(undefined); }}><div><strong>{lightbox?.name}</strong><button type="button" autoFocus className="creative-icon-button" aria-label="关闭大图" onClick={() => setLightbox(undefined)}><X size={20} /></button></div>{lightbox && <img src={assetUrl(lightbox.id)} alt={lightbox.name} />}</dialog>
  </section>;
}
