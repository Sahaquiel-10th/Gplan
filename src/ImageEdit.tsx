import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, History, ImagePlus, LoaderCircle, Menu, Plus, RefreshCw, X } from "lucide-react";
import type { CommercePublicJob } from "../server/commerceTypes";
import "./commerce.css";
import "./image-edit.css";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type EditHistory = { id: string; productName: string; status: CommercePublicJob["status"]; phase: string; createdAt: string };
type EditItem = { imageId: string; instruction?: string; name?: string };
type EditDraft = { items: EditItem[]; instruction: string; requestKey: string };
type PendingRetries = Record<string, { attempts: number; imageId?: string; requestKey?: string }>;
type Variant = CommercePublicJob["variants"][number];
const busy = (job?: CommercePublicJob) => !!job && ["queued", "generating", "planning"].includes(job.status);
const assetUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;
const emptyDraft = (): EditDraft => ({ items: [], instruction: "", requestKey: crypto.randomUUID() });
function normalizeDraft(draft: EditDraft): EditDraft {
  const only = draft.items.length === 1 ? draft.items[0] : undefined;
  // Removing other images must never leave a hidden override on the remaining image.
  return only?.instruction?.trim() ? { ...draft, instruction: only.instruction, items: [{ ...only, instruction: "" }] } : draft;
}
function readDraft(key: string): EditDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    const items: EditItem[] = Array.isArray(value?.items) ? value.items.filter((item: EditItem) => typeof item?.imageId === "string" && item.imageId).slice(0, 20).map((item: EditItem) => ({ imageId: item.imageId, instruction: typeof item.instruction === "string" ? item.instruction : "", name: typeof item.name === "string" ? item.name : "" })) : typeof value?.imageId === "string" && value.imageId ? [{ imageId: value.imageId }] : [];
    return normalizeDraft({ items, instruction: typeof value?.instruction === "string" ? value.instruction : "", requestKey: typeof value?.requestKey === "string" && value.requestKey ? value.requestKey : crypto.randomUUID() });
  } catch { return emptyDraft(); }
}
function draftFromJob(job: CommercePublicJob): EditDraft {
  const items = job.variants.length ? job.variants.map((variant, index) => ({ imageId: variant.productImageIds?.[0] || job.brief.productImageIds[index] || job.brief.productImageIds[0], instruction: variant.editInstruction && variant.editInstruction !== job.brief.notes ? variant.editInstruction : "" })) : job.brief.productImageIds.map(imageId => ({ imageId }));
  return normalizeDraft({ items: items.filter(item => !!item.imageId), instruction: job.brief.notes, requestKey: crypto.randomUUID() });
}
function readPendingRetries(key: string): PendingRetries {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry && typeof entry === "object" && typeof (entry as { attempts?: unknown }).attempts === "number")) as PendingRetries;
  } catch { return {}; }
}
const statusText = (variant: Variant) => variant.status === "completed" ? "已完成" : variant.status === "failed" ? "未完成" : variant.status === "generating" ? "正在修改" : "等待修改";

// Intent: an operator corrects finished product images, then checks each result.
// Hierarchy: originals and one shared instruction lead; individual exceptions disclose on demand.
// Palette: existing quiet blue, paper white, ink, muted labels and inset controls.
// Depth/surfaces: quiet borders on paper, with inset image trays; no added elevation.
// Typography: inherited Chinese system type, 14px controls and 20px/650 section headings.
// Spacing: the workspace's 4px rhythm, 24px panel padding and 12px thumbnail gaps.
export function ImageEditWorkspace({ api, userId, agentId, onBack, onOpenSidebar }: {
  api: Api; userId: string; agentId: string; onBack: () => void; onOpenSidebar: () => void;
}) {
  const draftKey = `image-edit-draft-${userId}`, lastKey = `image-edit-last-${userId}`, retryKey = `image-edit-pending-retries-${userId}`;
  const [draft, setDraft] = useState<EditDraft>(() => readDraft(draftKey));
  const [job, setJob] = useState<CommercePublicJob>();
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<EditHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [lightbox, setLightbox] = useState<{ id: string; name: string }>();
  const [pendingRetries, setPendingRetries] = useState<PendingRetries>(() => readPendingRetries(retryKey));
  const pendingRetriesRef = useRef(pendingRetries);
  const mounted = useRef(true), version = useRef(0), lifetime = useRef(0), requestPending = useRef(false), draftOwner = useRef(userId);
  const fileRef = useRef<HTMLInputElement>(null), instructionRef = useRef<HTMLTextAreaElement>(null), dialogRef = useRef<HTMLDialogElement>(null);
  const resultRef = useRef<HTMLElement>(null), wasBusy = useRef(false);
  const inProgress = busy(job), disabled = working || uploading || inProgress;
  const total = job?.variants.length || draft.items.length;
  const completed = job?.variants.filter(variant => variant.status === "completed").length || 0;
  const failed = job?.variants.filter(variant => variant.status === "failed").length || 0;
  const hasResults = job?.variants.some(variant => !!variant.imageAttachmentId);
  const isBatch = total > 1;
  const validDraft = draft.items.length > 0 && draft.items.every(item => !!(item.instruction?.trim() || draft.instruction.trim()));
  const current = (token: number) => mounted.current && token === version.current;
  const savePendingRetries = (value: PendingRetries) => {
    pendingRetriesRef.current = value; setPendingRetries(value);
    sessionStorage.setItem(retryKey, JSON.stringify(value));
  };
  const reconcileRetries = (next: CommercePublicJob) => {
    const pending = { ...pendingRetriesRef.current };
    let changed = false;
    next.variants.forEach(variant => {
      const key = `${next.id}:${variant.id}`, before = pending[key];
      if (before && (before.requestKey && variant.lastRetryRequestKey === before.requestKey || variant.attempts > before.attempts || variant.imageAttachmentId !== before.imageId || busy(next) && ["pending", "generating"].includes(variant.status))) {
        delete pending[key]; changed = true;
      }
    });
    if (changed) savePendingRetries(pending);
  };

  const loadHistory = async (token = version.current) => {
    const { jobs } = await api<{ jobs: EditHistory[] }>("/api/commerce/jobs?kind=image_edit");
    if (current(token)) setHistory(jobs);
    return jobs;
  };
  const fetchOpenJob = async (id: string, token: number) => {
    const { job: next } = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${encodeURIComponent(id)}`);
    if (!current(token)) return;
    if (next.kind !== "image_edit") throw Error("这不是图片修改任务");
    reconcileRetries(next);
    setJob(next); setDraft(draftFromJob(next)); setShowHistory(false); setError("");
    sessionStorage.setItem(lastKey, id);
    return next;
  };
  const openJob = async (id: string) => {
    if (requestPending.current || disabled) return;
    const token = ++version.current;
    try { await fetchOpenJob(id, token); }
    catch (e) { if (current(token)) setError(e instanceof Error ? e.message : "加载记录失败"); }
  };
  useEffect(() => { if (draftOwner.current === userId) sessionStorage.setItem(draftKey, JSON.stringify(draft)); }, [draft, draftKey, userId]);
  useEffect(() => {
    mounted.current = true;
    const token = ++version.current;
    const session = ++lifetime.current;
    if (draftOwner.current !== userId) {
      draftOwner.current = userId; setDraft(readDraft(draftKey)); setJob(undefined);
      const pending = readPendingRetries(retryKey); pendingRetriesRef.current = pending; setPendingRetries(pending);
    }
    setReady(false);
    void (async () => {
      try {
        const config = await api<{ ready: boolean; message: string }>("/api/commerce/edit-config");
        if (!mounted.current || session !== lifetime.current) return;
        setReady(config.ready); if (config.message && current(token)) setError(config.message);
        if (!current(token)) return;
        const jobs = await loadHistory(token);
        if (!current(token)) return;
        const active = jobs.find(item => ["planning", "queued", "generating"].includes(item.status));
        const last = sessionStorage.getItem(lastKey);
        if (active || last && jobs.some(item => item.id === last)) await fetchOpenJob(active?.id || last!, token);
      } catch (e) { if (current(token)) setError(e instanceof Error ? e.message : "加载失败"); }
    })();
    return () => { mounted.current = false; version.current++; lifetime.current++; };
  }, [agentId, userId]);
  useEffect(() => {
    if (!job || !inProgress) return;
    const token = version.current;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { job: next } = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${encodeURIComponent(job.id)}`);
        if (stopped || !current(token)) return;
        reconcileRetries(next);
        setJob(next);
        if (!busy(next)) { void loadHistory(token).catch(() => undefined); return; }
      } catch (e) { if (!stopped && current(token)) setError(e instanceof Error ? e.message : "状态更新失败，正在重试"); }
      if (!stopped && current(token)) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, inProgress]);
  useEffect(() => { if (lightbox) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [lightbox]);
  useEffect(() => {
    if (wasBusy.current && !inProgress && window.matchMedia("(max-width: 1000px)").matches) resultRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
    wasBusy.current = inProgress;
  }, [inProgress]);

  function replaceDraft(next: EditDraft) {
    version.current++; setDraft(normalizeDraft(next)); setJob(undefined); setError("");
    sessionStorage.removeItem(lastKey);
  }
  function changeDraft(patch: Partial<EditDraft>) {
    if (disabled || job) return;
    replaceDraft({ ...draft, ...patch, requestKey: crypto.randomUUID() });
  }
  function newTask() {
    if (disabled || requestPending.current) return;
    replaceDraft(emptyDraft()); setShowHistory(false);
    fileRef.current?.focus();
  }
  async function upload(files: File[]) {
    if (!files.length || disabled || requestPending.current) return;
    const base = job ? emptyDraft() : draft;
    if (base.items.length + files.length > 20) { setError(`每批最多20张，还可以添加${20 - base.items.length}张。请重新选择。`); return; }
    if (files.some(file => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024)) { setError("请上传每张10MB以内的 PNG、JPG 或 WebP 图片"); return; }
    const token = ++version.current;
    requestPending.current = true; setUploading(true); setError("");
    let added: EditItem[] = [];
    try {
      for (let offset = 0; offset < files.length; offset += 4) {
        setUploadProgress(`正在上传 ${Math.min(offset + 4, files.length)} / ${files.length} 张`);
        const batch = files.slice(offset, offset + 4), form = new FormData();
        batch.forEach(file => form.append("files", file));
        const { attachments } = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
        if (!current(token)) return;
        if (attachments.length !== batch.length) throw Error("部分图片上传未完成，请检查后补充上传。");
        added = [...added, ...attachments.map((attachment, index) => ({ imageId: attachment.id, name: batch[index].name }))];
        setDraft({ ...base, items: [...base.items, ...added], requestKey: crypto.randomUUID() });
        setJob(undefined); sessionStorage.removeItem(lastKey);
      }
      instructionRef.current?.focus();
    } catch (e) { if (current(token)) setError(`${e instanceof Error ? e.message : "上传失败"}${added.length ? ` 已保留上传成功的${added.length}张，可以继续添加。` : ""}`); }
    finally { requestPending.current = false; if (current(token)) { setUploading(false); setUploadProgress(""); } }
  }
  async function generate() {
    if (disabled || requestPending.current || !ready || job || !validDraft) return;
    const token = version.current;
    requestPending.current = true; setWorking(true); setError("");
    // Preserve the key before the request: a lost response or refresh can retry safely.
    sessionStorage.setItem(draftKey, JSON.stringify(draft));
    try {
      const { job: next } = await api<{ job: CommercePublicJob }>("/api/commerce/edits", { method: "POST", body: JSON.stringify({ items: draft.items.map(({ imageId, instruction }) => ({ imageId, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}) })), instruction: draft.instruction.trim(), agentId, requestKey: draft.requestKey }) });
      if (!current(token)) return;
      setJob(next); sessionStorage.setItem(lastKey, next.id);
      void loadHistory(token).catch(() => undefined);
    } catch (e) { if (current(token)) setError(e instanceof Error ? e.message : "提交结果暂未确认，重试会继续同一任务。"); }
    finally { requestPending.current = false; if (current(token)) setWorking(false); }
  }
  async function retry(variant: Variant) {
    if (!job || disabled || requestPending.current || !ready || variant.attempts >= 5) return;
    const token = version.current, id = job.id, pendingKey = `${job.id}:${variant.id}`;
    requestPending.current = true; setWorking(true); setError("");
    try {
      if (pendingRetriesRef.current[pendingKey] && !pendingRetriesRef.current[pendingKey].requestKey) {
        await fetchOpenJob(id, token);
        if (current(token) && pendingRetriesRef.current[pendingKey]) setError("这张的上次提交仍待确认，暂不重复生成。可稍后再确认状态。");
        return;
      }
      const retryRequestKey = pendingRetriesRef.current[pendingKey]?.requestKey || crypto.randomUUID();
      savePendingRetries({ ...pendingRetriesRef.current, [pendingKey]: { attempts: variant.attempts, imageId: variant.imageAttachmentId, requestKey: retryRequestKey } });
      await api(`/api/commerce/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ variantId: variant.id, requestKey: retryRequestKey }) });
      if (!current(token)) return;
      await fetchOpenJob(id, token);
      void loadHistory(token).catch(() => undefined);
    } catch (e) {
      if (current(token)) {
        try { await fetchOpenJob(id, token); } catch { /* Keep the last known result. */ }
        setError(pendingRetriesRef.current[pendingKey] ? "这张的提交结果暂未确认，已保留已有图片。再次点击会继续同一次重试。" : "");
      }
    } finally { requestPending.current = false; if (current(token)) setWorking(false); }
  }
  function continueWithResult(variant: Variant) {
    if (!variant.imageAttachmentId || disabled || requestPending.current) return;
    replaceDraft({ items: [{ imageId: variant.imageAttachmentId, name: "上一版修改结果" }], instruction: "", requestKey: crypto.randomUUID() });
    instructionRef.current?.focus();
  }
  function versions(variant: Variant) {
    return !!variant.previousImageIds?.length && <details className="image-edit-versions"><summary>之前的版本（{variant.previousImageIds.length}）</summary>{variant.previousImageIds.map((id, index) => <a key={`${id}-${index}`} href={`${assetUrl(id)}?download=1`} download>下载第{index + 1}版</a>)}</details>;
  }
  function resultCard(variant: Variant, index: number) {
    const sourceId = variant.productImageIds?.[0] || job?.brief.productImageIds[index] || job?.brief.productImageIds[0];
    return <article className={`image-edit-result-card ${isBatch ? "is-batch" : ""}`} key={variant.id} aria-label={`图片${index + 1}修改结果`}>
      {isBatch && <div className="image-edit-card-heading"><span>{sourceId && <img src={assetUrl(sourceId)} alt={`图片${index + 1}原图缩略图`} />}<strong>图片 {index + 1}</strong></span><small className={variant.status === "failed" ? "is-failed" : ""}>{statusText(variant)}</small></div>}
      {variant.imageAttachmentId ? <button type="button" className="image-edit-preview" aria-label={`放大查看${isBatch ? `图片${index + 1}` : ""}修改结果`} onClick={() => setLightbox({ id: variant.imageAttachmentId!, name: `图片${index + 1}修改结果` })}><img src={assetUrl(variant.imageAttachmentId)} alt={`图片${index + 1}修改后的图片`} loading="lazy" /></button> : <div className="image-edit-result-empty">{variant.status === "generating" ? <LoaderCircle size={28} className="creative-spin" /> : <ImagePlus size={28} />}<strong>{variant.status === "failed" ? "这张暂未完成" : statusText(variant)}</strong>{!isBatch && <p>可以离开页面，稍后从修改记录继续查看。</p>}</div>}
      {variant.status === "generating" && variant.imageAttachmentId && <p className="creative-help" role="status">正在生成新版本，上一版仍可下载。</p>}
      {variant.error && <p role="alert" className="creative-result-error">{variant.error}</p>}
      <div className="image-edit-result-actions">
        {variant.imageAttachmentId && <><a className={isBatch ? "creative-secondary" : "creative-primary"} href={`${assetUrl(variant.imageAttachmentId)}?download=1`} download><Download size={16} />{isBatch ? "下载这张" : "下载修改版"}</a><button type="button" className="creative-secondary" disabled={disabled} onClick={() => continueWithResult(variant)}>在这版上继续改</button></>}
        <button type="button" className="creative-text-button" disabled={disabled || !ready || variant.attempts >= 5} onClick={() => void retry(variant)}><RefreshCw size={14} />{pendingRetries[`${job?.id}:${variant.id}`] ? pendingRetries[`${job?.id}:${variant.id}`].requestKey ? "继续重试这张" : "确认这张状态" : variant.status === "failed" ? "仅重试这张" : variant.imageAttachmentId ? "重新生成这张" : "生成这张"}</button>
      </div>
      {variant.attempts >= 5 && <p className="creative-help">这张已生成5次，可在修改版上继续新任务。</p>}
      {versions(variant)}
    </article>;
  }

  return <section className="creative-workspace image-edit-workspace">
    <header className="creative-header"><div className="creative-header-title"><button type="button" className="mobile-menu" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button><button type="button" className="creative-icon-button" aria-label="返回智能体" onClick={onBack}><ArrowLeft size={19} /></button><div><h1>小修小改</h1><p>一次传多张，统一改要求，每张独立出图。</p></div></div><div className="image-edit-header-actions"><button type="button" className="creative-text-button" disabled={disabled} onClick={newTask}><Plus size={16} />开始新任务</button><button type="button" className="creative-secondary" disabled={disabled} aria-expanded={showHistory} onClick={() => { setShowHistory(value => !value); const token = version.current; void loadHistory(token).catch(e => { if (current(token)) setError(e.message); }); }}><History size={16} />修改记录</button></div></header>
    <div className="creative-body image-edit-body">
      {error && <div role="alert" className="error creative-alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
      {showHistory && <section className="creative-history"><h2>修改记录</h2>{!history.length && <p className="creative-help">还没有修改记录，生成后会保存在这里。</p>}{history.map(item => <button type="button" key={item.id} onClick={() => void openJob(item.id)}><span><strong>{item.productName}</strong><small>{new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small></span><span>{item.phase}</span></button>)}</section>}
      <div className={`image-edit-layout ${isBatch ? "has-batch" : ""}`}>
        <section className="image-edit-panel"><div className="image-edit-panel-heading"><div><span className="creative-eyebrow">原图{draft.items.length > 0 ? ` · ${draft.items.length}张` : ""}</span><h2>这次要改哪些图？</h2></div>{draft.items.length > 0 && <button type="button" className="creative-text-button" disabled={disabled || !job && draft.items.length >= 20} onClick={() => fileRef.current?.click()}><ImagePlus size={16} />{job ? "上传新一批" : "添加图片"}</button>}</div>
          <input ref={fileRef} className="image-edit-file" aria-label="上传需要修改的图片（可多选）" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={disabled} onChange={e => { void upload(Array.from(e.target.files || [])); e.target.value = ""; }} />
          {!draft.items.length ? <button type="button" className="image-edit-upload" disabled={disabled} onClick={() => fileRef.current?.click()}><ImagePlus size={32} /><strong>{uploading ? uploadProgress : "上传图片（可多选）"}</strong><span>每批最多20张 · PNG、JPG、WebP · 每张10MB以内</span></button> : draft.items.length === 1 ? <div className="image-edit-single-source"><button type="button" className="image-edit-preview" aria-label="放大查看原图" onClick={() => setLightbox({ id: draft.items[0].imageId, name: "原图" })}><img src={assetUrl(draft.items[0].imageId)} alt="本次修改的原图" /></button>{!job && <button type="button" className="image-edit-remove creative-icon-button" disabled={disabled} aria-label="移除图片1" onClick={() => changeDraft({ items: [] })}><X size={16} /></button>}</div> : <div className="image-edit-source-grid">{draft.items.map((item, index) => <div className="image-edit-source-item" key={item.imageId}><button type="button" className="image-edit-source-preview" aria-label={`放大查看原图${index + 1}`} onClick={() => setLightbox({ id: item.imageId, name: `原图${index + 1}` })}><img src={assetUrl(item.imageId)} alt={`本次修改的原图${index + 1}`} /></button><span title={item.name}>图片 {index + 1}{item.instruction?.trim() && <small>单独要求</small>}</span>{!job && <button type="button" className="image-edit-remove creative-icon-button" disabled={disabled} aria-label={`移除图片${index + 1}`} onClick={() => changeDraft({ items: draft.items.filter((_, itemIndex) => itemIndex !== index) })}><X size={14} /></button>}</div>)}{!job && draft.items.length < 20 && <button type="button" className="image-edit-add" disabled={disabled} onClick={() => fileRef.current?.click()}><Plus size={24} /><span>添加图片</span></button>}</div>}
          {uploading && draft.items.length > 0 && <p className="creative-help" role="status">{uploadProgress}</p>}
          <label className="image-edit-instruction">{draft.items.length > 1 ? "这些图统一改什么？" : "想改什么地方？"}<textarea ref={instructionRef} value={draft.instruction} maxLength={1000} rows={4} disabled={disabled || !!job} placeholder="例如：把右下角的79元改成69元，其他保持不变。" onChange={e => changeDraft({ instruction: e.target.value })} /></label>
          {draft.items.length > 1 && <details className="image-edit-overrides"><summary>个别图片有不同要求？<span>可选</span></summary><p className="creative-help">填了就按这张的要求修改；留空沿用通用要求。</p><div className="image-edit-override-list">{draft.items.map((item, index) => <label className="image-edit-override" key={item.imageId}><span><img src={assetUrl(item.imageId)} alt="" /><strong>图片 {index + 1}</strong></span><textarea aria-label={`图片${index + 1}单独修改要求`} rows={2} maxLength={1000} value={item.instruction || ""} disabled={disabled || !!job} placeholder="留空，沿用上面的通用要求" onChange={e => changeDraft({ items: draft.items.map((value, itemIndex) => itemIndex === index ? { ...value, instruction: e.target.value } : value) })} /></label>)}</div></details>}
          {!job ? <div className="image-edit-submit"><span>{draft.items.length > 1 ? "每张只用自己的原图，独立生成修改版。" : "只描述这次要改的内容即可。"}</span><button type="button" className="creative-primary" disabled={disabled || !ready || !validDraft} onClick={() => void generate()}>{disabled ? <LoaderCircle size={16} className="creative-spin" /> : <RefreshCw size={16} />}{uploading ? "正在上传" : working ? "正在提交" : draft.items.length > 1 ? `批量修改 ${draft.items.length} 张` : "生成修改版"}</button></div> : <p className="creative-help image-edit-task-note">{inProgress ? "任务进行中，可稍后从修改记录继续查看。" : "这批修改已保存。需要补改时，在对应结果上继续；上传图片会开始新一批。"}</p>}
        </section>
        <section ref={resultRef} className="image-edit-panel image-edit-result" aria-label="修改结果"><div className="image-edit-panel-heading"><div><span className="creative-eyebrow">修改结果</span><h2>{inProgress ? `正在修改 ${total} 张图片` : job ? failed ? `${completed}张完成，${failed}张未完成` : "新版本已保存" : "改好后，在这里查看"}</h2></div>{inProgress && <LoaderCircle size={20} className="creative-spin" />}</div>
          {job && <div className="image-edit-progress" role="status" aria-live="polite"><div><span>已完成 <strong>{completed} / {total}</strong></span><span>{failed > 0 ? `${failed}张未完成，可单独重试` : inProgress ? job.phase : "每张修改版均已保存"}</span></div><progress aria-label="图片修改进度" value={completed + failed} max={Math.max(total, 1)} />{isBatch && hasResults && <a className="creative-secondary" href={`/api/commerce/jobs/${encodeURIComponent(job.id)}/download`} download><Download size={16} />打包下载已完成图片</a>}</div>}
          {job?.variants.length ? <><div className={isBatch ? "image-edit-result-grid" : "image-edit-single-result"}>{job.variants.map(resultCard)}</div>{hasResults && <p className="creative-help">请核对修改内容、文字及未修改区域，再保存使用。</p>}{job.error && <p role="alert" className="creative-result-error">{job.error}</p>}</> : <div className="image-edit-result-empty"><ImagePlus size={32} /><strong>每张新图，都可单独下载</strong><p>上传原图并写下修改要求，就可以开始。</p></div>}
        </section>
      </div>
    </div>
    <dialog ref={dialogRef} className="creative-lightbox" onCancel={() => setLightbox(undefined)} onClick={e => { if (e.target === e.currentTarget) setLightbox(undefined); }}><div><strong>{lightbox?.name}</strong><button type="button" autoFocus className="creative-icon-button" aria-label="关闭大图" onClick={() => setLightbox(undefined)}><X size={20} /></button></div>{lightbox && <img src={assetUrl(lightbox.id)} alt={lightbox.name} />}</dialog>
  </section>;
}
