import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, History, ImagePlus, LoaderCircle, Menu, RefreshCw, X } from "lucide-react";
import type { CommercePublicJob } from "../server/commerceTypes";
import "./commerce.css";
import "./image-edit.css";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type EditHistory = { id: string; productName: string; status: CommercePublicJob["status"]; phase: string; createdAt: string };
const busy = (job?: CommercePublicJob) => !!job && ["queued", "generating", "planning"].includes(job.status);
const assetUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;

// An operator has a finished image and one small correction to make.
// The source and result lead side by side; the instruction and single blue action stay
// together. Reuse the workspace paper/inset palette, quiet borders, Chinese system type,
// 14/20/24px hierarchy and 4px spacing. This is a correction desk, without a wizard.
export function ImageEditWorkspace({ api, userId, agentId, onBack, onOpenSidebar }: {
  api: Api; userId: string; agentId: string; onBack: () => void; onOpenSidebar: () => void;
}) {
  const draftKey = `image-edit-draft-${userId}`, lastKey = `image-edit-last-${userId}`;
  const [draft, setDraft] = useState<{ imageId: string; instruction: string }>(() => {
    try { const v = JSON.parse(sessionStorage.getItem(draftKey) || "null"); return { imageId: typeof v?.imageId === "string" ? v.imageId : "", instruction: typeof v?.instruction === "string" ? v.instruction : "" }; }
    catch { return { imageId: "", instruction: "" }; }
  });
  const [job, setJob] = useState<CommercePublicJob>();
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<EditHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [lightbox, setLightbox] = useState<{ id: string; name: string }>();
  const mounted = useRef(true), version = useRef(0), requestKey = useRef(crypto.randomUUID());
  const fileRef = useRef<HTMLInputElement>(null), instructionRef = useRef<HTMLTextAreaElement>(null), dialogRef = useRef<HTMLDialogElement>(null);
  const resultRef = useRef<HTMLElement>(null), wasBusy = useRef(false);
  const inProgress = busy(job), variant = job?.variants[0];
  const disabled = working || uploading || inProgress;

  const loadHistory = async () => {
    const { jobs } = await api<{ jobs: EditHistory[] }>("/api/commerce/jobs?kind=image_edit");
    if (mounted.current) setHistory(jobs);
    return jobs;
  };
  const openJob = async (id: string) => {
    const { job } = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${encodeURIComponent(id)}`);
    if (!mounted.current) return;
    if (job.kind !== "image_edit") throw Error("这不是图片修改任务");
    setJob(job); setDraft({ imageId: job.brief.productImageIds[0], instruction: job.brief.notes });
    setShowHistory(false); sessionStorage.setItem(lastKey, id);
  };
  useEffect(() => { sessionStorage.setItem(draftKey, JSON.stringify(draft)); }, [draft, draftKey]);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const config = await api<{ ready: boolean; message: string }>("/api/commerce/edit-config");
        if (!mounted.current) return;
        setReady(config.ready); if (config.message) setError(config.message);
        const jobs = await loadHistory();
        if (!mounted.current) return;
        const active = jobs.find(j => ["planning", "queued", "generating"].includes(j.status));
        const last = sessionStorage.getItem(lastKey);
        if (active || last && jobs.some(j => j.id === last)) await openJob(active?.id || last!);
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "加载失败"); }
    })();
    return () => { mounted.current = false; version.current++; };
  }, [agentId, userId]);
  useEffect(() => {
    if (!job || !inProgress) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { job: next } = await api<{ job: CommercePublicJob }>(`/api/commerce/jobs/${job.id}`);
        if (stopped) return;
        setJob(next);
        if (!busy(next)) { void loadHistory().catch(() => undefined); return; }
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "状态更新失败，正在重试"); }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, inProgress]);
  useEffect(() => { if (lightbox) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [lightbox]);
  useEffect(() => {
    if (wasBusy.current && !inProgress && window.matchMedia("(max-width: 1000px)").matches) resultRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
    wasBusy.current = inProgress;
  }, [inProgress]);

  async function upload(file?: File) {
    if (!file || disabled) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024) { setError("请上传10MB以内的 PNG、JPG 或 WebP 图片"); return; }
    const token = ++version.current; setUploading(true); setError("");
    try {
      const form = new FormData(); form.append("files", file);
      const { attachments } = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
      if (!mounted.current || token !== version.current) return;
      setDraft({ imageId: attachments[0].id, instruction: "" }); setJob(undefined);
      sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID(); instructionRef.current?.focus();
    } catch (e) { if (mounted.current && token === version.current) setError(e instanceof Error ? e.message : "上传失败"); }
    finally { if (mounted.current && token === version.current) setUploading(false); }
  }
  async function generate() {
    if (disabled || !ready) return;
    setWorking(true); setError("");
    try {
      if (job && variant) {
        await api(`/api/commerce/jobs/${job.id}/retry`, { method: "POST", body: JSON.stringify({ variantId: variant.id }) });
        await openJob(job.id);
      } else {
        const { job } = await api<{ job: CommercePublicJob }>("/api/commerce/edits", { method: "POST", body: JSON.stringify({ ...draft, agentId, requestKey: requestKey.current }) });
        if (mounted.current) { setJob(job); sessionStorage.setItem(lastKey, job.id); }
      }
      void loadHistory().catch(() => undefined);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "图片修改未完成，请重试"); }
    finally { if (mounted.current) setWorking(false); }
  }
  function editInstruction(value: string) {
    setDraft(d => ({ ...d, instruction: value })); setJob(undefined); setError(""); sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID();
  }
  function continueWithResult() {
    if (!variant?.imageAttachmentId) return;
    setDraft({ imageId: variant.imageAttachmentId, instruction: "" }); setJob(undefined); setError("");
    sessionStorage.removeItem(lastKey); requestKey.current = crypto.randomUUID(); instructionRef.current?.focus();
  }

  return <section className="creative-workspace image-edit-workspace">
    <header className="creative-header"><div className="creative-header-title"><button type="button" className="mobile-menu" aria-label="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button><button type="button" className="creative-icon-button" aria-label="返回智能体" onClick={onBack}><ArrowLeft size={19} /></button><div><h1>小修小改</h1><p>传一张图，说清要改哪里。</p></div></div><button type="button" className="creative-secondary" disabled={disabled} aria-expanded={showHistory} onClick={() => { setShowHistory(v => !v); void loadHistory().catch(e => setError(e.message)); }}><History size={16} />修改记录</button></header>
    <div className="creative-body image-edit-body">
      {error && <div role="alert" className="error creative-alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
      {showHistory && <section className="creative-history"><h2>修改记录</h2>{!history.length && <p className="creative-help">还没有修改记录，生成后会保存在这里。</p>}{history.map(h => <button type="button" key={h.id} onClick={() => void openJob(h.id).catch(e => setError(e.message))}><span><strong>{h.productName}</strong><small>{new Date(h.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</small></span><span>{h.phase}</span></button>)}</section>}
      <div className="image-edit-layout">
        <section className="image-edit-panel"><div className="image-edit-panel-heading"><div><span className="creative-eyebrow">原图</span><h2>这次要改哪张？</h2></div>{draft.imageId && <button type="button" className="creative-text-button" disabled={disabled} onClick={() => fileRef.current?.click()}>换张图</button>}</div>
          <input ref={fileRef} className="image-edit-file" aria-label="上传需要修改的图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
          {draft.imageId ? <button type="button" className="image-edit-preview" aria-label="放大查看原图" onClick={() => setLightbox({ id: draft.imageId, name: "原图" })}><img src={assetUrl(draft.imageId)} alt="本次修改的原图" /></button> : <button type="button" className="image-edit-upload" disabled={disabled} onClick={() => fileRef.current?.click()}><ImagePlus size={32} /><strong>{uploading ? "正在上传…" : "上传一张图片"}</strong><span>PNG、JPG、WebP · 10MB以内</span></button>}
          <label className="image-edit-instruction">想改什么地方？<textarea ref={instructionRef} value={draft.instruction} maxLength={1000} rows={4} disabled={disabled} placeholder="例如：把右下角的79元改成69元，其他保持不变。" onChange={e => editInstruction(e.target.value)} /></label>
          <div className="image-edit-submit"><span>只描述这次要改的内容即可。</span><button type="button" className="creative-primary" disabled={disabled || !ready || !draft.imageId || !draft.instruction.trim() || !!job && (variant?.attempts || 0) >= 5} onClick={() => void generate()}>{disabled ? <LoaderCircle size={16} className="creative-spin" /> : <RefreshCw size={16} />}{uploading ? "正在上传" : inProgress ? "正在修改" : job ? variant?.status === "failed" ? "重试修改" : "再生成一版" : "生成修改版"}</button></div>
          {(variant?.attempts || 0) >= 5 && <p className="creative-help">已生成5次，修改要求后可开始新的任务。</p>}
        </section>
        <section ref={resultRef} className="image-edit-panel image-edit-result" aria-label="修改结果"><div className="image-edit-panel-heading"><div><span className="creative-eyebrow">修改结果</span><h2>{inProgress ? "正在按要求修改" : variant?.imageAttachmentId ? "新版本已保存" : "改好后，在这里查看"}</h2></div>{inProgress && <LoaderCircle size={20} className="creative-spin" />}</div>
          {variant?.imageAttachmentId ? <><button type="button" className="image-edit-preview" aria-label="放大查看修改结果" onClick={() => setLightbox({ id: variant.imageAttachmentId!, name: "修改结果" })}><img src={assetUrl(variant.imageAttachmentId)} alt="修改后的图片" /></button><div className="image-edit-result-actions"><a className="creative-primary" href={`${assetUrl(variant.imageAttachmentId)}?download=1`} download><Download size={16} />下载修改版</a><button type="button" className="creative-secondary" disabled={disabled} onClick={continueWithResult}>在这版上继续改</button></div><p className="creative-help">请核对修改内容、文字及未修改区域，再保存使用。</p></> : <div className="image-edit-result-empty" role={inProgress ? "status" : undefined}>{inProgress ? <LoaderCircle size={32} className="creative-spin" /> : <ImagePlus size={32} />}<strong>{inProgress ? job?.phase : "一张新图，可直接下载"}</strong><p>{inProgress ? "可以离开页面，稍后从修改记录继续查看。" : "上传原图并写下修改要求，就可以开始。"}</p></div>}
          {(job?.error || variant?.error) && <p role="alert" className="creative-result-error">{job?.error || variant?.error}</p>}
          {!!variant?.previousImageIds?.length && <details className="image-edit-versions"><summary>之前的版本（{variant.previousImageIds.length}）</summary>{variant.previousImageIds.map((id, i) => <a key={id} href={`${assetUrl(id)}?download=1`} download>下载第{i + 1}版</a>)}</details>}
        </section>
      </div>
    </div>
    <dialog ref={dialogRef} className="creative-lightbox" onCancel={() => setLightbox(undefined)} onClick={e => { if (e.target === e.currentTarget) setLightbox(undefined); }}><div><strong>{lightbox?.name}</strong><button type="button" autoFocus className="creative-icon-button" aria-label="关闭大图" onClick={() => setLightbox(undefined)}><X size={20} /></button></div>{lightbox && <img src={assetUrl(lightbox.id)} alt={lightbox.name} />}</dialog>
  </section>;
}
