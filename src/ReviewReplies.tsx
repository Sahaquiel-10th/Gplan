import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, ChevronRight, Copy, Download, History, ImagePlus, LoaderCircle, Menu, MessageSquareText, Plus, Save, Settings2, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { ReviewCandidate, ReviewConfig, ReviewDraft, ReviewFactStatus, ReviewInput, ReviewProfile, ReviewResult, ReviewRun, ReviewRunInput, ReviewSettings } from "../server/reviewReplyTypes";
import "./commerce.css";
import "./review-replies.css";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type Props = { api: Api; userId: string; agentId: string; onBack: () => void; onOpenSidebar: () => void };
type Editor = { id: string; revision: number; draft: ReviewDraft; baseline: string };
type Pending = { input: ReviewRunInput; createdAt: number };
type Mutation = { runId: string; itemId: string; candidateId: string; instruction: string; requestKey: string };
type Session = { selectedId: string; products: Record<string, string>; reviews: ReviewInput[]; sourceImages: string[]; editor?: Editor; trial: boolean; lastRunId: string; pending?: Pending; mutation?: Mutation };
const base = "/api/review-replies";
const uid = () => crypto.randomUUID();
const clone = <T,>(value: T): T => structuredClone(value);
const blankDraft = (): ReviewDraft => ({ name: "我的店铺回复规则", shopName: "", brand: "", platform: "天猫", settings: { tone: "真诚温和", length: "medium", count: 2, marketing: "light", address: "自然称呼", emoji: false, signature: "", closing: "", goals: ["回应客户体验", "解答产品疑问"], forbiddenPhrases: [], afterSales: "", sceneRules: {} }, products: [], facts: [], examples: [], rules: [], sourceAttachmentIds: [] });
const newReview = (productId = ""): ReviewInput => ({ id: uid(), text: "", productId, afterSalesStatus: "不清楚" });
const emptySession = (): Session => ({ selectedId: "", products: {}, reviews: [newReview()], sourceImages: [], trial: false, lastRunId: "" });
function readSession(key: string): Session {
  try { const value = JSON.parse(sessionStorage.getItem(key) || "null"); return value && Array.isArray(value.reviews) ? { ...emptySession(), ...value } : emptySession(); } catch { return emptySession(); }
}
const profileDraft = (profile: ReviewProfile): ReviewDraft => ({ name: profile.name, shopName: profile.shopName, brand: profile.brand, platform: profile.platform, settings: clone(profile.settings), products: clone(profile.products), facts: clone(profile.facts), examples: clone(profile.examples), rules: [...profile.rules], sourceAttachmentIds: [...profile.sourceAttachmentIds] });
const validProductId = (id: string, draft: ReviewDraft | undefined) => draft?.products.some(product => product.id === id) ? id : "";
const validReviewProducts = (reviews: ReviewInput[], draft: ReviewDraft) => reviews.map(item => ({ ...item, productId: validProductId(item.productId, draft) }));
const busyRun = (run?: ReviewRun) => !!run && (run.status === "generating" || run.mutations.some(item => item.status === "generating"));
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请稍后再试";
const statusLabel: Record<ReviewRun["status"], string> = { generating: "正在生成", completed: "已完成", failed: "未完成", interrupted: "已中断" };
const factLabels: Record<ReviewFactStatus, string> = { approved: "已确认，可公开", pending: "待核实，勿引用", internal: "仅内部使用", forbidden: "禁用" };

// Each operator's unfinished form and request keys are scoped to their account and agent.
export function ReviewRepliesWorkspace(props: Props) { return <ReviewRepliesInner key={`${props.userId}:${props.agentId}`} {...props} />; }

function ReviewRepliesInner({ api, userId, agentId, onBack, onOpenSidebar }: Props) {
  const storageKey = `review-replies:${userId}:${agentId}`;
  const [session, setSession] = useState<Session>(() => readSession(storageKey));
  const sessionRef = useRef(session);
  const [tab, setTab] = useState<"reply" | "rules">("reply");
  const [config, setConfig] = useState<ReviewConfig>();
  const [profiles, setProfiles] = useState<ReviewProfile[]>([]);
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [run, setRun] = useState<ReviewRun>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importText, setImportText] = useState("");
  const [importFiles, setImportFiles] = useState<{ id: string; name: string }[]>([]);
  const [analysis, setAnalysis] = useState<{ draft: ReviewDraft; warnings: string[] }>();
  const [recognitionWarnings, setRecognitionWarnings] = useState<string[]>([]);
  const [proposed, setProposed] = useState<{ profileId: string; rule: string }>();
  const active = useRef(true), action = useRef(false);
  const screenshotRef = useRef<HTMLInputElement>(null), materialsRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const selected = profiles.find(item => item.id === session.selectedId);
  const effectiveDraft = session.trial ? session.editor?.draft : selected ? profileDraft(selected) : run?.profileSnapshot;
  const locked = !!working || busyRun(run);
  const editor = session.editor;
  const dirty = !!editor && JSON.stringify(editor.draft) !== editor.baseline;
  const unfinishedReviews = run?.results.filter(item => item.candidates.length === 0) || [];

  function persist(patch: Partial<Session>) {
    const next = { ...sessionRef.current, ...patch };
    sessionRef.current = next; sessionStorage.setItem(storageKey, JSON.stringify(next)); setSession(next);
  }
  function updateEditor(patch: Partial<ReviewDraft>) { if (editor) persist({ editor: { ...editor, draft: { ...editor.draft, ...patch } } }); }
  function updateSettings(patch: Partial<ReviewSettings>) { if (editor) updateEditor({ settings: { ...editor.draft.settings, ...patch } }); }
  function replaceProfile(next: ReviewProfile) {
    setProfiles(previous => [next, ...previous.filter(item => item.id !== next.id)]);
    const open = sessionRef.current.editor;
    if (open?.id === next.id && JSON.stringify(open.draft) === open.baseline) {
      const draft = profileDraft(next); persist({ editor: { id: next.id, revision: next.revision, draft, baseline: JSON.stringify(draft) } });
    }
  }
  async function perform(label: string, task: () => Promise<void>) {
    if (action.current || busyRun(run)) return;
    action.current = true; setWorking(label); setError("");
    try { await task(); } catch (e) { if (active.current) setError(errorText(e)); }
    finally { action.current = false; if (active.current) setWorking(""); }
  }
  async function refreshRuns() { const result = await api<{ runs: ReviewRun[] }>(`${base}/runs`); if (active.current) setRuns(result.runs); return result.runs; }
  function acceptRun(next: ReviewRun) { if (!active.current) return; setRun(next); persist({ lastRunId: next.id }); setRuns(previous => [next, ...previous.filter(item => item.id !== next.id)]); }
  useEffect(() => {
    active.current = true;
    void (async () => {
      try {
        const [settings, saved, history] = await Promise.all([api<ReviewConfig>(`${base}/config`), api<{ profiles: ReviewProfile[] }>(`${base}/profiles`), api<{ runs: ReviewRun[] }>(`${base}/runs`)]);
        if (!active.current) return;
        setConfig(settings); setProfiles(saved.profiles); setRuns(history.runs);
        const state = sessionRef.current;
        if (!saved.profiles.some(item => item.id === state.selectedId)) persist({ selectedId: saved.profiles[0]?.id || "" });
        const pendingRun = state.pending && history.runs.find(item => item.requestKey === state.pending?.input.requestKey);
        const last = pendingRun || history.runs.find(item => item.id === state.lastRunId);
        if (last) { acceptRun(last); if (pendingRun) persist({ pending: undefined }); }
      } catch (e) { if (active.current) setError(errorText(e)); }
      finally { if (active.current) setLoading(false); }
    })();
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!run || !busyRun(run)) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const { run: next } = await api<{ run: ReviewRun }>(`${base}/runs/${encodeURIComponent(run.id)}`); if (stopped || !active.current) return; acceptRun(next); if (!busyRun(next)) { void refreshRuns().catch(() => undefined); return; } }
      catch (e) { if (!stopped && active.current) setError(`状态更新暂未完成：${errorText(e)}。稍后会继续查询。`); }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [run?.id, run?.status, run?.mutations.map(item => `${item.requestKey}:${item.status}`).join("|")]);
  useEffect(() => {
    const mutation = session.mutation;
    if (!mutation || !run || mutation.runId !== run.id) return;
    const saved = run.mutations.find(item => item.requestKey === mutation.requestKey);
    if (saved) { persist({ mutation: undefined }); if (saved.error) setError(saved.error); }
  }, [run]);
  useEffect(() => {
    if (!notice) return; const timer = setTimeout(() => setNotice(""), 4500); return () => clearTimeout(timer);
  }, [notice]);

  function startEditor(draft: ReviewDraft, profile?: ReviewProfile) {
    if (locked || action.current) return;
    if (session.pending || session.mutation) { setError("上次请求的结果尚未确认，请回到“开始回复”查询或继续同一请求"); return; }
    if (dirty && !window.confirm("当前规则草稿尚未保存。要放弃这份草稿并打开另一份规则吗？")) return;
    const next = clone(draft);
    persist({ editor: { id: profile?.id || "", revision: profile?.revision || 0, draft: next, baseline: JSON.stringify(next) }, trial: false });
    setAnalysis(undefined); setImportFiles([]); setImportText(""); setTab("rules"); setError("");
  }
  async function saveEditor(goReply = false) {
    if (!editor) return;
    await perform("正在保存规则", async () => {
      const { profile } = await api<{ profile: ReviewProfile }>(editor.id ? `${base}/profiles/${encodeURIComponent(editor.id)}` : `${base}/profiles`, { method: editor.id ? "PUT" : "POST", body: JSON.stringify({ draft: editor.draft, ...(editor.id ? { expectedRevision: editor.revision } : {}) }) });
      if (!active.current) return;
      replaceProfile(profile); const draft = profileDraft(profile);
      persist({ selectedId: profile.id, editor: { id: profile.id, revision: profile.revision, draft, baseline: JSON.stringify(draft) }, trial: false, products: { ...sessionRef.current.products, [profile.id]: validProductId(sessionRef.current.products[profile.id] || "", draft) }, reviews: validReviewProducts(sessionRef.current.reviews, draft) });
      setNotice("店铺规则已保存"); if (goReply) { setTab("reply"); setRun(undefined); persist({ lastRunId: "", pending: undefined }); }
    });
  }
  async function uploadFiles(files: File[]) {
    const uploaded: { id: string; name: string }[] = [];
    for (let offset = 0; offset < files.length; offset += 4) {
      const batch = files.slice(offset, offset + 4), form = new FormData(); batch.forEach(file => form.append("files", file));
      const { attachments } = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
      if (attachments.length !== batch.length) throw Error("部分资料上传未完成，请重新选择未上传的文件");
      uploaded.push(...attachments.map((item, index) => ({ id: item.id, name: batch[index].name })));
    }
    return uploaded;
  }
  async function addMaterials(files: File[]) {
    if (!files.length) return;
    if (files.length + importFiles.length > 12) { setError("每次最多准备 12 份资料"); return; }
    await perform("正在上传店铺资料", async () => {
      const added = await uploadFiles(files); if (active.current) setImportFiles(previous => [...previous, ...added]);
    });
  }
  async function analyzeMaterials() {
    await perform("正在提炼店铺规则", async () => {
      const result = await api<{ draft: ReviewDraft; warnings: string[] }>(`${base}/analyze`, { method: "POST", body: JSON.stringify({ attachmentIds: importFiles.map(item => item.id), text: importText }) });
      if (active.current) setAnalysis(result);
    });
  }
  function applyAnalysis() {
    if (!analysis || !editor) return;
    if (!window.confirm("用本次识别结果替换当前规则草稿？请先确认需要保留的手工配置已保存。")) return;
    persist({ editor: { ...editor, draft: { ...clone(analysis.draft), sourceAttachmentIds: [...new Set([...analysis.draft.sourceAttachmentIds, ...importFiles.map(item => item.id)])] } } });
    setAnalysis(undefined); setNotice("已应用识别结果，请检查商品事实和待核实内容后保存");
  }
  async function recognize(files: File[]) {
    if (!files.length) return;
    if (session.sourceImages.length + files.length > 4) { setError("每批最多上传 4 张评价截图，可开始新一批后继续"); return; }
    if (files.some(file => !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 10 * 1024 * 1024)) { setError("请上传 10MB 以内的 JPG、PNG 或 WebP 截图"); return; }
    await perform("正在识别评价截图", async () => {
      const added = await uploadFiles(files), ids = added.map(item => item.id);
      if (!active.current) return;
      const result = await api<{ reviews: { text: string; productId?: string }[]; warnings: string[] }>(`${base}/recognize`, { method: "POST", body: JSON.stringify({ imageIds: ids }) });
      if (!active.current) return;
      const existing = sessionRef.current.reviews.filter(item => item.text.trim());
      if (existing.length + result.reviews.length > 10) throw Error("识别出的评价加上现有评价超过 10 条，请分批处理后重新上传");
      const products = effectiveDraft?.products || [];
      const reviews = result.reviews.map(item => ({ ...newReview(products.some(product => product.id === item.productId) ? item.productId : ""), text: item.text }));
      persist({ reviews: [...existing, ...reviews].length ? [...existing, ...reviews] : [newReview()], sourceImages: [...sessionRef.current.sourceImages, ...ids] });
      setRecognitionWarnings(result.warnings); setNotice("已提取评价，请检查原文和对应商品");
    });
  }
  function newBatch() {
    if (locked) return;
    if (session.pending || session.mutation) { setError("上次请求的结果尚未确认，请先查询或继续同一请求"); return; }
    const productId = validProductId(session.products[session.selectedId] || "", effectiveDraft);
    setRun(undefined); setRecognitionWarnings([]); persist({ products: { ...session.products, [session.selectedId]: productId }, reviews: [newReview(productId)], sourceImages: [], lastRunId: "" });
  }
  function changeReview(id: string, patch: Partial<ReviewInput>) {
    persist({ reviews: session.reviews.map(item => item.id === id ? { ...item, ...patch } : item) });
    if (patch.productId !== undefined && !session.trial) persist({ products: { ...session.products, [session.selectedId]: patch.productId } });
  }
  async function generate(pending = session.pending) {
    if (!effectiveDraft || !config?.ready) return;
    await perform("正在生成评价回复", async () => {
      const requestDraft = pending?.input.draft || effectiveDraft;
      const reviews = validReviewProducts(pending?.input.reviews || session.reviews, requestDraft).filter(item => item.text.trim());
      if (reviews.reduce((total, item) => total + item.text.length, 0) > 14000) throw Error("本次评价总长度最多 14000 字，请分批生成");
      if (!reviews.length) throw Error("请先粘贴一条评价或上传评价截图");
      const input = pending ? { ...pending.input, reviews } : { ...(session.trial ? { draft: clone(effectiveDraft) } : { profileId: session.selectedId }), reviews, sourceImageIds: session.sourceImages, requestKey: uid() };
      persist({ reviews: validReviewProducts(session.reviews, requestDraft), products: { ...session.products, [session.selectedId]: validProductId(session.products[session.selectedId] || "", requestDraft) }, pending: { input, createdAt: pending?.createdAt || Date.now() } });
      const { run: next } = await api<{ run: ReviewRun }>(`${base}/runs`, { method: "POST", body: JSON.stringify(input) });
      if (!active.current) return; acceptRun(next); persist({ pending: undefined }); setHistoryOpen(false);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    });
  }
  async function checkPending() {
    await perform("正在查询上次请求", async () => {
      const items = await refreshRuns(), pending = sessionRef.current.pending;
      const match = pending && items.find(item => item.requestKey === pending.input.requestKey);
      if (match) { acceptRun(match); persist({ pending: undefined }); }
      else setError("还没有查到已保存的任务。可点“继续上次请求”，系统会沿用原请求编号。");
    });
  }
  async function openRun(id: string) {
    await perform("正在加载历史回复", async () => {
      const { run: next } = await api<{ run: ReviewRun }>(`${base}/runs/${encodeURIComponent(id)}`);
      if (!active.current) return;
      acceptRun(next);
      persist({ selectedId: profiles.some(profile => profile.id === next.profileId) ? next.profileId : "", trial: false });
      setHistoryOpen(false); setTab("reply");
    });
  }
  async function refine(item: ReviewResult, candidate: ReviewCandidate, instruction: string, retry?: Mutation) {
    if (!run || !instruction.trim()) return;
    const mutation = retry || { runId: run.id, itemId: item.id, candidateId: candidate.id, instruction: instruction.trim(), requestKey: uid() };
    await perform("正在优化这条回复", async () => {
      persist({ mutation });
      const { run: next } = await api<{ run: ReviewRun }>(`${base}/runs/${encodeURIComponent(mutation.runId)}/refine`, { method: "POST", body: JSON.stringify({ itemId: mutation.itemId, candidateId: mutation.candidateId, instruction: mutation.instruction, requestKey: mutation.requestKey }) });
      if (!active.current) return; acceptRun(next); persist({ mutation: undefined });
    });
  }
  async function editCandidate(item: ReviewResult, candidate: ReviewCandidate, text: string): Promise<boolean> {
    if (!run || !text.trim()) return false;
    let saved = false;
    await perform("正在保存手工修改", async () => {
      const { run: next } = await api<{ run: ReviewRun }>(`${base}/runs/${encodeURIComponent(run.id)}/edit`, { method: "POST", body: JSON.stringify({ itemId: item.id, candidateId: candidate.id, text }) });
      if (active.current) { acceptRun(next); setNotice("手工修改已保存"); saved = true; }
    });
    return saved;
  }
  async function proposeRule(item: ReviewResult, candidate: ReviewCandidate, instruction: string) {
    if (!run?.profileId) { setError("这次是草稿试回复，请先保存店铺规则，再使用长期规则功能"); return; }
    await perform("正在整理长期规则草案", async () => {
      const { rule } = await api<{ rule: string }>(`${base}/runs/${encodeURIComponent(run.id)}/propose-rule`, { method: "POST", body: JSON.stringify({ itemId: item.id, candidateId: candidate.id, instruction }) });
      if (active.current) setProposed({ profileId: run.profileId, rule });
    });
  }
  async function addRule() {
    if (!proposed?.rule.trim()) return;
    await perform("正在保存长期规则", async () => {
      const currentProfile = profiles.find(item => item.id === proposed.profileId);
      if (!currentProfile) throw Error("原店铺规则已不存在，请先保存为一份新的店铺规则");
      const { profile } = await api<{ profile: ReviewProfile }>(`${base}/profiles/${encodeURIComponent(currentProfile.id)}/rules`, { method: "POST", body: JSON.stringify({ rule: proposed.rule, expectedRevision: currentProfile.revision }) });
      if (!active.current) return; replaceProfile(profile); setProposed(undefined); setNotice("已记入店铺规则，下次生成时生效");
    });
  }
  async function collectExample(item: ReviewResult, candidate: ReviewCandidate) {
    if (!run?.profileId) { setError("请先保存店铺规则，再收藏为店铺示例"); return; }
    await perform("正在收藏回复示例", async () => {
      const profile = profiles.find(value => value.id === run.profileId);
      if (!profile) throw Error("原店铺规则不存在");
      if (profile.examples.some(value => value.review === item.text && value.reply === candidate.text)) { setNotice("这条回复已在示例中"); return; }
      const draft = profileDraft(profile); draft.examples.push({ id: uid(), review: item.text, reply: candidate.text });
      const { profile: next } = await api<{ profile: ReviewProfile }>(`${base}/profiles/${encodeURIComponent(profile.id)}`, { method: "PUT", body: JSON.stringify({ draft, expectedRevision: profile.revision }) });
      if (active.current) { replaceProfile(next); setNotice("已收藏为店铺回复示例"); }
    });
  }
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("回复已复制"); }
    catch { setError("复制未完成，可选中回复文字后手动复制"); }
  }
  async function copyProfile(profile: ReviewProfile) {
    await perform("正在复制规则", async () => {
      const { profile: next } = await api<{ profile: ReviewProfile }>(`${base}/profiles/${encodeURIComponent(profile.id)}/copy`, { method: "POST" });
      if (active.current) { replaceProfile(next); setNotice("已复制为一份独立规则"); }
    });
  }
  async function deleteProfile(profile: ReviewProfile) {
    if (!window.confirm(`删除“${profile.name}”？已生成的历史回复仍会保留。`)) return;
    await perform("正在删除规则", async () => {
      await api(`${base}/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      if (!active.current) return;
      setProfiles(previous => previous.filter(item => item.id !== profile.id));
      persist({ ...(session.selectedId === profile.id ? { selectedId: profiles.find(item => item.id !== profile.id)?.id || "" } : {}), ...(editor?.id === profile.id ? { editor: undefined, trial: false } : {}) });
    });
  }
  async function restore(profile: ReviewProfile, revision: number) {
    if (!window.confirm(`将“${profile.name}”恢复到版本 ${revision}？当前内容仍可在版本记录中查看。`)) return;
    await perform("正在恢复历史版本", async () => {
      const { profile: next } = await api<{ profile: ReviewProfile }>(`${base}/profiles/${encodeURIComponent(profile.id)}/restore`, { method: "POST", body: JSON.stringify({ revision, expectedRevision: profile.revision }) });
      if (!active.current) return; replaceProfile(next);
      if (editor?.id === profile.id) { const draft = profileDraft(next); persist({ editor: { id: next.id, revision: next.revision, draft, baseline: JSON.stringify(draft) } }); }
      setNotice("已恢复，并保存为新版本");
    });
  }
  function trial() { if (!editor || locked) return; if (session.pending || session.mutation) { setError("上次请求的结果尚未确认，请回到“开始回复”查询或继续同一请求"); return; } persist({ trial: true, lastRunId: "", reviews: validReviewProducts(session.reviews, editor.draft), ...(editor.id ? { products: { ...session.products, [editor.id]: validProductId(session.products[editor.id] || "", editor.draft) } } : {}) }); setRun(undefined); setTab("reply"); setNotice("正在使用未保存的规则草稿试回复，草稿已保留"); }
  const templates = <div className="rr-template-grid">{config?.templates.filter(template => template.id !== "blank").sort((a, b) => a.id === "dongmianshan" ? -1 : b.id === "dongmianshan" ? 1 : 0).map(template => <button key={template.id} className="rr-template" disabled={locked} onClick={() => startEditor(template.draft)}><BookOpen size={20} /><strong>{template.name}</strong><span>{template.description}</span><b>使用这个模板 <ChevronRight size={14} /></b></button>)}<button className="rr-template rr-template-blank" disabled={locked} onClick={() => startEditor(blankDraft())}><Plus size={20} /><strong>创建自己的店铺规则</strong><span>上传资料让 AI 预填，也可以从空白开始。</span><b>创建新规则 <ChevronRight size={14} /></b></button></div>;

  return <main className="creative-workspace review-replies-workspace">
    <header className="creative-header"><div className="creative-header-title"><button className="creative-icon-button" aria-label="返回智能体" onClick={onBack}><ArrowLeft size={18} /></button><button className="mobile-menu creative-icon-button" aria-label="打开侧栏" onClick={onOpenSidebar}><Menu size={18} /></button><div><h1>店铺评价回复助手</h1><p>把店铺的表达方式存成规则，每次回复少想一步。</p></div></div><button className="creative-secondary" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History size={16} />回复记录</button></header>
    <div className="creative-body rr-body">
      <nav className="rr-tabs" aria-label="评价助手功能"><button aria-current={tab === "reply" ? "page" : undefined} onClick={() => setTab("reply")}><MessageSquareText size={17} />开始回复</button><button aria-current={tab === "rules" ? "page" : undefined} onClick={() => setTab("rules")}><Settings2 size={17} />我的店铺规则{dirty && <span className="rr-draft-dot" title="有未保存草稿" />}</button></nav>
      {error && <div role="alert" className="rr-alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
      {config && !config.ready && <div className="creative-note">{config.message || "请先由管理员配置回复模型，仍可创建和编辑店铺规则。"}</div>}
      {working && <p className="rr-busy" role="status"><LoaderCircle className="creative-spin" size={16} />{working}</p>}
      {historyOpen && <section className="creative-history"><div className="creative-section-title"><h2>最近的回复记录</h2><button className="creative-text-button" onClick={() => setHistoryOpen(false)}>收起</button></div>{runs.length === 0 ? <p className="creative-help">生成第一批回复后，会在这里保留。</p> : runs.slice(0, 40).map(item => <button key={item.id} disabled={locked || !!session.pending || !!session.mutation} onClick={() => void openRun(item.id)}><span><strong>{item.profileSnapshot.name}</strong><small>{item.results[0]?.text.slice(0, 60) || "评价回复"}</small></span><span><small>{dateLabel(item.createdAt)} · {item.results.length} 条 · {statusLabel[item.status]}</small><ChevronRight size={14} /></span></button>)}</section>}
      {loading ? <div className="rr-empty"><LoaderCircle size={24} className="creative-spin" /><p>正在加载店铺规则</p></div> : tab === "reply" ? <>
        {!effectiveDraft && !run ? <section className="rr-panel rr-welcome"><span className="creative-eyebrow">先存好店铺的表达方式</span><h2>从一份店铺规则开始</h2><p>选一个模板，检查产品资料，再拿真实评价试一试。规则默认仅自己可见。</p>{templates}{editor && <button className="creative-text-button" onClick={() => setTab("rules")}>继续编辑已保留的草稿</button>}</section> : <>
          <section className="rr-profile-bar"><div><label htmlFor="rr-profile">本次使用的店铺规则</label>{run ? <strong>{run.profileSnapshot.name}<span className="rr-tag">{run.profileId ? `v${run.profileRevision}` : "草稿试回复"}</span></strong> : session.trial ? <strong>{effectiveDraft!.name}<span className="rr-tag">草稿试回复</span></strong> : <select id="rr-profile" value={session.selectedId} disabled={locked || !!session.pending || !!session.mutation} onChange={event => { const id = event.target.value; persist({ selectedId: id, reviews: [newReview(session.products[id] || "")], sourceImages: [], lastRunId: "" }); setRun(undefined); }}><option value="">选择店铺规则</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.revision}</option>)}</select>}</div><button className="creative-secondary" disabled={locked} onClick={() => { if (run) { const source = profiles.find(item => item.id === run.profileId); startEditor(source ? profileDraft(source) : run.profileSnapshot, source); } else if (session.trial) setTab("rules"); else if (selected) startEditor(profileDraft(selected), selected); }}><Settings2 size={15} />{run && !profiles.some(item => item.id === run.profileId) ? "从这次配置新建规则" : session.trial ? "返回草稿继续配置" : "调整这份规则"}</button></section>
          {session.pending && <div className="rr-pending" role="status"><strong>上次提交的结果尚未确认</strong><p>先查询已有任务；继续请求会使用同一个编号，避免重复生成。</p><div className="rr-actions"><button className="creative-secondary" disabled={locked} onClick={() => void checkPending()}>查询任务状态</button><button className="creative-primary" disabled={locked || !config?.ready} onClick={() => void generate(session.pending)}>继续上次请求</button></div></div>}
          {session.mutation && !busyRun(run) && <div className="rr-pending"><strong>上次优化结果尚未确认</strong><p>“{session.mutation.instruction}”会沿用原请求编号继续查询或完成。</p><button className="creative-secondary" disabled={locked} onClick={() => { const pending = session.mutation!, item = run?.results.find(value => value.id === pending.itemId), candidate = item?.candidates.find(value => value.id === pending.candidateId); if (item && candidate) void refine(item, candidate, pending.instruction, pending); }}>继续上次优化</button></div>}
          {!run && <section className="rr-panel rr-input-panel"><div className="rr-section-heading"><div><span className="creative-eyebrow">评价原文</span><h2>粘贴评价，或直接传截图</h2><p>AI 会先回应客户说的重点，再按店铺规则给出 {effectiveDraft!.settings.count} 条备选。</p></div><button className="creative-secondary" disabled={locked || !!session.pending || !!session.mutation || !config?.visionReady} onClick={() => screenshotRef.current?.click()}><ImagePlus size={17} />上传评价截图</button><input ref={screenshotRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" aria-label="上传评价截图" onChange={event => { void recognize(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} /></div>
            <fieldset className="rr-fieldset" disabled={locked || !!session.pending || !!session.mutation}>
              {session.reviews.map((item, index) => <article className="rr-review-input" key={item.id}><div className="rr-row"><strong>评价 {index + 1}</strong>{session.reviews.length > 1 && <button className="creative-text-button" aria-label={`删除评价 ${index + 1}`} onClick={() => persist({ reviews: session.reviews.filter(value => value.id !== item.id) })}><Trash2 size={14} />移除</button>}</div><label className="rr-sr-only" htmlFor={`review-${item.id}`}>评价 {index + 1} 原文</label><textarea id={`review-${item.id}`} value={item.text} maxLength={3000} rows={4} placeholder="把客户评价粘贴到这里，例如：第二次买了，用起来方便，包装也很好。" onChange={event => changeReview(item.id, { text: event.target.value })} /><div className="rr-review-meta"><label>对应商品<select value={item.productId} onChange={event => changeReview(item.id, { productId: event.target.value })}><option value="">不确定 / 店铺通用</option>{effectiveDraft!.products.map(product => <option key={product.id} value={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ""}</option>)}</select></label><label>售后处理状态<select value={item.afterSalesStatus} onChange={event => changeReview(item.id, { afterSalesStatus: event.target.value })}>{["不清楚", "尚未处理", "已联系客户，处理中", "已解决", "无需售后"].map(value => <option key={value}>{value}</option>)}</select></label></div></article>)}
              <div className="rr-actions"><button className="creative-text-button" disabled={session.reviews.length >= 10} onClick={() => persist({ reviews: [...session.reviews, newReview(session.products[session.selectedId] || "")] })}><Plus size={15} />再加一条评价</button>{session.reviews.length === 1 && /\n\s*\n/.test(session.reviews[0].text) && <button className="creative-text-button" onClick={() => { const parts = session.reviews[0].text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean); if (parts.length > 10) { setError("拆分后超过 10 条，请分批粘贴"); return; } persist({ reviews: parts.map(text => ({ ...newReview(session.reviews[0].productId), text })) }); }}>按空行拆成多条</button>}</div>
            </fieldset>
            {!!session.sourceImages.length && <div className="rr-source-images">{session.sourceImages.map((id, index) => <figure key={id}><img src={`/api/attachments/${encodeURIComponent(id)}/content`} alt={`评价截图 ${index + 1}`} /><button className="creative-icon-button" disabled={locked || !!session.pending} aria-label={`移除截图 ${index + 1}`} onClick={() => persist({ sourceImages: session.sourceImages.filter(value => value !== id) })}><X size={12} /></button></figure>)}</div>}
            {recognitionWarnings.map((warning, index) => <p className="rr-caution" key={index}>{warning}</p>)}
            <div className="rr-generate-footer"><p>最多 10 条评价；截图识别后可直接修改原文。</p><button className="creative-primary" disabled={locked || !config?.ready || !session.reviews.some(item => item.text.trim()) || !!session.pending || !!session.mutation} onClick={() => void generate(undefined)}><Sparkles size={17} />生成回复{session.reviews.filter(item => item.text.trim()).length > 1 ? ` · ${session.reviews.filter(item => item.text.trim()).length} 条评价` : ""}</button></div>
          </section>}
          {run && <section ref={resultRef} className="rr-run-results"><div className="rr-section-heading"><div><span className="creative-eyebrow">{run.profileSnapshot.name} · {run.profileId ? `规则版本 ${run.profileRevision}` : "草稿试回复"}</span><h2>{busyRun(run) ? "正在准备回复" : "选一条合适的，继续调到满意"}</h2><p>{run.results.length} 条评价 · {dateLabel(run.createdAt)}</p></div><button className="creative-secondary" disabled={locked || !!session.pending || !!session.mutation} onClick={newBatch}><Plus size={16} />开始下一批</button></div>
            {busyRun(run) && <div className="creative-progress" role="status"><LoaderCircle size={20} className="creative-spin" /><div><strong>正在按店铺规则整理回复</strong><span>可以留在这里等待，刷新后也能恢复任务。</span></div></div>}
            {run.error && <div className="rr-alert"><span>{run.error}</span></div>}
            {["failed", "interrupted"].includes(run.status) && unfinishedReviews.length > 0 && <div className="rr-pending"><p>已有回复会保留。可带回 {unfinishedReviews.length} 条未完成的评价，再明确发起一次生成。</p><button className="creative-secondary" disabled={locked} onClick={() => { persist({ reviews: unfinishedReviews.map(item => ({ id: item.id, text: item.text, productId: item.productId, afterSalesStatus: item.afterSalesStatus })), sourceImages: run.sourceImageIds, trial: !run.profileId, ...(run.profileId ? { selectedId: run.profileId } : { editor: { id: "", revision: 0, draft: run.profileSnapshot, baseline: JSON.stringify(run.profileSnapshot) } }), lastRunId: "" }); setRun(undefined); }}>带回未完成的评价</button></div>}
            {run.results.map((item, index) => <article key={item.id} className="rr-result-item" aria-label={`评价 ${index + 1} 回复结果`}><div className="rr-original"><div className="rr-row"><strong>评价 {index + 1}</strong><span>{run.profileSnapshot.products.find(product => product.id === item.productId)?.name || "店铺通用 / 商品未确定"}</span></div><p>{item.text}</p><small>售后：{item.afterSalesStatus}</small></div>{item.risk === "high" && <div className="rr-high-risk" role="note">这条涉及较高风险，请核对事实和售后情况后再发布。</div>}{item.candidates.length ? <div className="rr-candidates">{item.candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate} disabled={locked || !!session.mutation || !!session.pending} onCopy={text => void copyText(text)} onEdit={text => editCandidate(item, candidate, text)} onRefine={instruction => void refine(item, candidate, instruction)} onRule={instruction => void proposeRule(item, candidate, instruction)} onCollect={() => void collectExample(item, candidate)} />)}</div> : !busyRun(run) && <p className="rr-caution">这条暂时没有生成回复，请检查任务提示后重新发起。</p>}
              <details className="rr-evidence"><summary>查看判断依据{item.scene ? ` · ${item.scene}` : ""}{item.risk === "medium" ? " · 建议人工核对" : ""}</summary><p>{item.axis || "根据评价原文和店铺规则生成"}</p>{item.checks.map((check, position) => <p key={position}>• {check}</p>)}{item.factIds.map(id => { const fact = run.profileSnapshot.facts.find(value => value.id === id); return fact && <p key={id}><strong>{factLabels[fact.status]}：</strong>{fact.text}<small>来源：{fact.source || "手工整理"}</small></p>; })}</details>
            </article>)}
          </section>}
        </>}
      </> : <div className="rr-rules-layout"><aside className="rr-rules-sidebar"><div className="rr-row"><h2>我的规则</h2><button className="creative-icon-button" aria-label="新建店铺规则" disabled={locked} onClick={() => startEditor(blankDraft())}><Plus size={16} /></button></div><p className="creative-help">默认仅自己可见，可为不同店铺分别配置。</p>{profiles.length === 0 && <p className="rr-sidebar-empty">还没有保存的规则</p>}{profiles.map(profile => <div className={`rr-profile-item ${editor?.id === profile.id ? "is-current" : ""}`} key={profile.id}><button disabled={locked} onClick={() => startEditor(profileDraft(profile), profile)}><strong>{profile.name}</strong><span>{profile.shopName || profile.brand || profile.platform} · v{profile.revision}</span></button><div className="rr-profile-actions"><button title="复制这份规则" aria-label={`复制 ${profile.name}`} disabled={locked} onClick={() => void copyProfile(profile)}><Copy size={14} /></button><a title="导出 Skill" aria-label={`导出 ${profile.name} Skill`} href={`${base}/profiles/${encodeURIComponent(profile.id)}/export`} download><Download size={14} /></a><button title="删除这份规则" aria-label={`删除 ${profile.name}`} disabled={locked} onClick={() => void deleteProfile(profile)}><Trash2 size={14} /></button></div></div>)}<details className="rr-template-disclosure"><summary>从模板新建</summary>{config?.templates.map(template => <button className="creative-text-button" disabled={locked} key={template.id} onClick={() => startEditor(template.draft)}><BookOpen size={14} />{template.name}</button>)}</details></aside>
        <section className="rr-panel rr-rule-editor">{!editor ? <div className="rr-welcome"><span className="creative-eyebrow">制作自己的评价回复 Skill</span><h2>先有一份能用的，再慢慢调顺</h2><p>上传品牌、产品和回复规范，AI 会整理成可调整的配置。</p>{templates}</div> : <><div className="rr-section-heading"><div><span className="creative-eyebrow">{editor.id ? `已保存版本 ${editor.revision}` : "新建规则"}</span><h2>把店铺的表达方式配好</h2><p>{dirty ? "有未保存修改，草稿已在本机保留" : "可先试回复，再决定如何调整"}</p></div><button className="creative-secondary" disabled={locked} onClick={trial}><Sparkles size={15} />拿一条评价试回复</button></div>
          <fieldset className="rr-fieldset" disabled={locked}>
            <details className="rr-import" open={importFiles.length > 0 || !!analysis || undefined}><summary><Upload size={17} /><span><strong>上传资料，让 AI 帮你预填规则</strong><small>支持 Word、PDF、图片，或粘贴品牌与产品介绍</small></span></summary><div className="rr-import-content"><button className="creative-secondary" onClick={() => materialsRef.current?.click()}><Plus size={15} />添加店铺资料</button><input ref={materialsRef} type="file" hidden multiple aria-label="上传店铺规则资料" accept=".docx,.pdf,.txt,.md,image/png,image/jpeg,image/webp" onChange={event => { void addMaterials(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} /><div className="rr-file-list">{importFiles.map(item => <span key={item.id}>{item.name}<button aria-label={`移除资料 ${item.name}`} onClick={() => setImportFiles(previous => previous.filter(value => value.id !== item.id))}><X size={12} /></button></span>)}</div><label>也可以粘贴资料<textarea rows={4} value={importText} maxLength={40000} placeholder="品牌介绍、产品特点、满意的回复示例、不能使用的表达……" onChange={event => setImportText(event.target.value)} /></label><button className="creative-primary" disabled={!importFiles.length && !importText.trim() || !config?.ready} onClick={() => void analyzeMaterials()}><Sparkles size={15} />识别并预填</button>{analysis && <div className="rr-analysis"><strong>已提炼：{analysis.draft.name}</strong><p>{analysis.draft.products.length} 款商品 · {analysis.draft.facts.length} 条商品事实 · {analysis.draft.rules.length} 条规则</p><p>商品：{analysis.draft.products.map(item => item.name).join("、") || "暂未识别"}</p>{analysis.warnings.map((warning, index) => <p className="rr-caution" key={index}>{warning}</p>)}<details><summary>预览提炼内容</summary><ul>{analysis.draft.facts.map(fact => <li key={fact.id}>{factLabels[fact.status]}：{fact.text}</li>)}</ul>{analysis.draft.rules.map((rule, index) => <p key={index}>• {rule}</p>)}</details><button className="creative-secondary" onClick={applyAnalysis}>应用到规则草稿</button></div>}</div></details>
            <div className="rr-form-grid"><label>规则名称<input value={editor.draft.name} maxLength={100} onChange={event => updateEditor({ name: event.target.value })} /></label><label>店铺名称<input value={editor.draft.shopName} maxLength={120} placeholder="例如：东面山天猫旗舰店" onChange={event => updateEditor({ shopName: event.target.value })} /></label><label>品牌<input value={editor.draft.brand} maxLength={100} onChange={event => updateEditor({ brand: event.target.value })} /></label><label>平台<select value={editor.draft.platform} onChange={event => updateEditor({ platform: event.target.value })}>{[...new Set(["天猫", "淘宝", "京东", "拼多多", "抖音", "小红书", "其他", editor.draft.platform])].filter(Boolean).map(platform => <option key={platform}>{platform}</option>)}</select></label></div>
            <section className="rr-editor-section"><div className="rr-row"><h3>店铺商品</h3><button className="creative-text-button" disabled={editor.draft.products.length >= 50} onClick={() => updateEditor({ products: [...editor.draft.products, { id: uid(), name: "", sku: "" }] })}><Plus size={14} />添加商品</button></div><p className="creative-help">商品分开配置，回复时只引用当前商品的信息。</p>{editor.draft.products.map((product, index) => <div className="rr-product-fields" key={product.id}><label><span>商品 {index + 1}</span><input value={product.name} maxLength={120} placeholder="商品名称" onChange={event => updateEditor({ products: editor.draft.products.map(item => item.id === product.id ? { ...item, name: event.target.value } : item) })} /></label><label><span>SKU / 规格</span><input value={product.sku} maxLength={120} placeholder="可选" onChange={event => updateEditor({ products: editor.draft.products.map(item => item.id === product.id ? { ...item, sku: event.target.value } : item) })} /></label><button className="creative-icon-button" aria-label={`删除商品 ${index + 1}`} onClick={() => { if (editor.draft.facts.some(item => item.productId === product.id) && !window.confirm("这个商品有关联的事实，删除商品也会移除这些事实。继续吗？")) return; updateEditor({ products: editor.draft.products.filter(item => item.id !== product.id), facts: editor.draft.facts.filter(item => item.productId !== product.id) }); }}><Trash2 size={14} /></button></div>)}</section>
            <section className="rr-editor-section"><div className="rr-row"><h3>品牌语气与回复方式</h3><span className="rr-tag">常用配置</span></div><div className="rr-form-grid"><label>语气<select value={["真诚温和", "专业克制", "轻松亲切"].includes(editor.draft.settings.tone) ? editor.draft.settings.tone : "自定义"} onChange={event => updateSettings({ tone: event.target.value === "自定义" ? "" : event.target.value })}>{["真诚温和", "专业克制", "轻松亲切", "自定义"].map(value => <option key={value}>{value}</option>)}</select></label>{!["真诚温和", "专业克制", "轻松亲切"].includes(editor.draft.settings.tone) && <label>描述希望的语气<input value={editor.draft.settings.tone} maxLength={1000} onChange={event => updateSettings({ tone: event.target.value })} /></label>}<label>回复长度<select value={editor.draft.settings.length} onChange={event => updateSettings({ length: event.target.value as ReviewSettings["length"] })}><option value="short">简短</option><option value="medium">适中</option><option value="long">详细</option></select></label><label>每条评价给几条备选<select value={editor.draft.settings.count} onChange={event => updateSettings({ count: Number(event.target.value) as 1 | 2 })}><option value={1}>1 条</option><option value={2}>2 条，表达各有侧重</option></select></label><label>营销程度<select value={editor.draft.settings.marketing} onChange={event => updateSettings({ marketing: event.target.value as ReviewSettings["marketing"] })}><option value="none">只回应评价</option><option value="light">相关时轻量带入</option><option value="natural">结合评价适度展开</option></select></label></div><fieldset className="rr-goals"><legend>希望回复做到什么</legend>{[...new Set(["回应客户体验", "解答产品疑问", "传递品牌", "解释产品特点", "处理售后", ...editor.draft.settings.goals])].map(goal => <label key={goal}><input type="checkbox" checked={editor.draft.settings.goals.includes(goal)} onChange={event => updateSettings({ goals: event.target.checked ? [...editor.draft.settings.goals, goal] : editor.draft.settings.goals.filter(item => item !== goal) })} />{goal}</label>)}</fieldset></section>
            <details className="rr-editor-details"><summary>商品事实与素材 · {editor.draft.facts.length} 条</summary><p className="creative-help">仅“已确认，可公开”的内容可被回复引用。待核实、内部、禁用状态都会保留。</p>{editor.draft.facts.map((fact, index) => <div className={`rr-fact rr-fact-${fact.status}`} key={fact.id}><div className="rr-row"><strong>素材 {index + 1}</strong><button className="creative-text-button" aria-label={`删除素材 ${index + 1}`} onClick={() => updateEditor({ facts: editor.draft.facts.filter(item => item.id !== fact.id) })}><Trash2 size={14} />移除</button></div><label>事实内容<textarea rows={2} value={fact.text} maxLength={1000} onChange={event => updateEditor({ facts: editor.draft.facts.map(item => item.id === fact.id ? { ...item, text: event.target.value } : item) })} /></label><div className="rr-form-grid"><label>适用商品<select value={fact.productId} onChange={event => updateEditor({ facts: editor.draft.facts.map(item => item.id === fact.id ? { ...item, productId: event.target.value } : item) })}><option value="">品牌通用</option>{editor.draft.products.map(product => <option key={product.id} value={product.id}>{product.name || "未命名商品"}</option>)}</select></label><label>使用状态<select value={fact.status} onChange={event => updateEditor({ facts: editor.draft.facts.map(item => item.id === fact.id ? { ...item, status: event.target.value as ReviewFactStatus } : item) })}>{Object.entries(factLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className="rr-wide">来源<input value={fact.source} maxLength={300} placeholder="例如：产品包装 / 客户资料待确认" onChange={event => updateEditor({ facts: editor.draft.facts.map(item => item.id === fact.id ? { ...item, source: event.target.value } : item) })} /></label></div></div>)}<button className="creative-secondary" disabled={editor.draft.facts.length >= 150} onClick={() => updateEditor({ facts: [...editor.draft.facts, { id: uid(), productId: "", text: "", source: "手工整理", status: "pending" }] })}><Plus size={14} />添加一条素材</button>{editor.draft.sourceAttachmentIds.length > 0 && <details className="rr-source-files"><summary>已保存的原始资料 · {editor.draft.sourceAttachmentIds.length} 份</summary>{editor.draft.sourceAttachmentIds.map((id, index) => <a key={id} href={`/api/attachments/${encodeURIComponent(id)}/content`} target="_blank" rel="noreferrer">查看原始资料 {index + 1}</a>)}</details>}</details>
            <details className="rr-editor-details"><summary>更多配置 · 称呼、场景、售后与长期规则</summary><div className="rr-form-grid"><label>如何称呼客户<select value={editor.draft.settings.address} onChange={event => updateSettings({ address: event.target.value as ReviewSettings["address"] })}>{["自然称呼", "您", "你"].map(value => <option key={value}>{value}</option>)}</select></label><label>表情<select value={editor.draft.settings.emoji ? "yes" : "no"} onChange={event => updateSettings({ emoji: event.target.value === "yes" })}><option value="no">不使用表情</option><option value="yes">少量使用</option></select></label><label>品牌署名<input value={editor.draft.settings.signature} maxLength={120} placeholder="可留空" onChange={event => updateSettings({ signature: event.target.value })} /></label><label>固定收尾<input value={editor.draft.settings.closing} maxLength={200} placeholder="可留空" onChange={event => updateSettings({ closing: event.target.value })} /></label></div><label>禁用表达，一行一个<textarea rows={3} value={editor.draft.settings.forbiddenPhrases.join("\n")} onChange={event => updateSettings({ forbiddenPhrases: event.target.value.split("\n") })} placeholder="例如：亲亲\n全网第一" /></label><label>售后口径<textarea rows={3} value={editor.draft.settings.afterSales} maxLength={2000} placeholder="可使用的联系渠道、处理步骤、允许承诺的内容" onChange={event => updateSettings({ afterSales: event.target.value })} /></label><div className="rr-subsection"><h4>不同评价，怎么回应</h4>{[...new Set(["具体好评", "复购", "普通好评", "产品疑问", "混合评价", "投诉与售后", ...Object.keys(editor.draft.settings.sceneRules)])].map(scene => <label key={scene}>{scene}<textarea rows={2} value={editor.draft.settings.sceneRules[scene] || ""} maxLength={1000} placeholder="留空则由 AI 按整体规则判断" onChange={event => updateSettings({ sceneRules: { ...editor.draft.settings.sceneRules, [scene]: event.target.value } })} /></label>)}</div><label>长期遵守的规则，一行一条<textarea rows={5} value={editor.draft.rules.join("\n")} placeholder="例如：只有客户提到首次购买时，才介绍新品牌。" onChange={event => updateEditor({ rules: event.target.value.split("\n") })} /></label><div className="rr-subsection"><div className="rr-row"><h4>喜欢的回复示例</h4><button className="creative-text-button" disabled={editor.draft.examples.length >= 20} onClick={() => updateEditor({ examples: [...editor.draft.examples, { id: uid(), review: "", reply: "" }] })}><Plus size={14} />添加示例</button></div>{editor.draft.examples.map((example, index) => <div className="rr-example" key={example.id}><label>评价原文 {index + 1}<textarea rows={2} value={example.review} maxLength={2000} onChange={event => updateEditor({ examples: editor.draft.examples.map(item => item.id === example.id ? { ...item, review: event.target.value } : item) })} /></label><label>满意的回复<textarea rows={3} value={example.reply} maxLength={2000} onChange={event => updateEditor({ examples: editor.draft.examples.map(item => item.id === example.id ? { ...item, reply: event.target.value } : item) })} /></label><button className="creative-text-button" onClick={() => updateEditor({ examples: editor.draft.examples.filter(item => item.id !== example.id) })}><Trash2 size={14} />移除示例</button></div>)}</div></details>
          </fieldset>
          <div className="rr-save-bar"><div><strong>{dirty ? "草稿已在本机保留" : "店铺规则"}</strong><span>保存后，后续回复会使用这份配置。</span></div><div className="rr-actions"><button className="creative-secondary" disabled={locked} onClick={() => void saveEditor()}><Save size={15} />保存规则</button><button className="creative-primary" disabled={locked} onClick={() => void saveEditor(true)}><Check size={15} />保存并开始回复</button></div></div>
          {editor.id && profiles.find(item => item.id === editor.id) && <details className="rr-editor-details rr-versions"><summary>版本记录与 Skill 导出</summary><a className="creative-text-button" href={`${base}/profiles/${encodeURIComponent(editor.id)}/export`} download><Download size={15} />下载当前已保存的 Skill</a>{[...profiles.find(item => item.id === editor.id)!.versions].reverse().map(version => <div className="rr-version" key={version.revision}><div><strong>版本 {version.revision}</strong><span>{dateLabel(version.createdAt)}</span></div><details><summary>查看配置</summary><p>{version.draft.name} · {version.draft.products.length} 款商品 · {version.draft.facts.length} 条素材</p><p>语气：{version.draft.settings.tone}；规则：{version.draft.rules.filter(Boolean).join("；") || "无"}</p></details><button className="creative-text-button" disabled={locked || version.revision === profiles.find(item => item.id === editor.id)?.revision} onClick={() => void restore(profiles.find(item => item.id === editor.id)!, version.revision)}>恢复此版本</button></div>)}</details>}
        </>}</section></div>}
      {proposed && <section className="rr-rule-proposal" role="dialog" aria-modal="false" aria-labelledby="rr-proposal-title"><div className="rr-row"><h2 id="rr-proposal-title">确认后，再记入店铺规则</h2><button className="creative-icon-button" disabled={locked} aria-label="关闭规则草案" onClick={() => setProposed(undefined)}><X size={16} /></button></div><p>请检查这条规则是否适合以后所有回复。仅调整本次回复时，无需保存到这里。</p><label>拟新增的长期规则<textarea rows={4} value={proposed.rule} maxLength={1000} onChange={event => setProposed({ ...proposed, rule: event.target.value })} /></label><div className="rr-actions"><button className="creative-secondary" disabled={locked} onClick={() => setProposed(undefined)}>暂不保存</button><button className="creative-primary" disabled={locked || !proposed.rule.trim()} onClick={() => void addRule()}><Check size={15} />确认记入店铺规则</button></div></section>}
    </div>
    {notice && <div className="creative-toast" role="status"><span>{notice}</span><button aria-label="关闭消息" onClick={() => setNotice("")}><X size={14} /></button></div>}
  </main>;
}

function CandidateCard({ candidate, disabled, onCopy, onEdit, onRefine, onRule, onCollect }: { candidate: ReviewCandidate; disabled: boolean; onCopy: (text: string) => void; onEdit: (text: string) => Promise<boolean>; onRefine: (instruction: string) => void; onRule: (instruction: string) => void; onCollect: () => void }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(candidate.text), [instruction, setInstruction] = useState(""), [ruleMode, setRuleMode] = useState(false);
  useEffect(() => { if (!editing) setText(candidate.text); }, [candidate.text, editing]);
  return <section className="rr-candidate"><div className="rr-row"><strong>{candidate.label || "备选回复"}</strong><button className="creative-text-button" disabled={editing} onClick={() => onCopy(candidate.text)}><Copy size={14} />复制</button></div>{editing ? <label className="rr-edit-candidate">编辑回复<textarea rows={5} maxLength={3000} value={text} onChange={event => setText(event.target.value)} /><span className="rr-actions"><button className="creative-secondary" disabled={disabled} onClick={() => { setEditing(false); setText(candidate.text); }}>取消</button><button className="creative-primary" disabled={disabled || !text.trim()} onClick={() => { void onEdit(text).then(saved => { if (saved) setEditing(false); }); }}>保存修改</button></span></label> : <p className="rr-reply-text">{candidate.text}</p>}
    <div className="rr-candidate-utilities"><button className="creative-text-button" disabled={disabled || editing} onClick={() => setEditing(true)}>手工编辑</button><button className="creative-text-button" disabled={disabled || editing} onClick={onCollect}>收藏为示例</button><details><summary>修改记录{candidate.versions.length ? ` · ${candidate.versions.length}` : ""}</summary>{candidate.versions.length ? candidate.versions.map((version, index) => <div className="rr-candidate-version" key={`${version.createdAt}-${index}`}><small>{dateLabel(version.createdAt)} · {version.instruction || "原始回复"}</small><p>{version.text}</p><button className="creative-text-button" onClick={() => onCopy(version.text)}>复制这个版本</button></div>) : <p>当前是第一版回复。</p>}</details></div>
    <fieldset className="rr-fieldset rr-refine" disabled={disabled || editing}><div className="rr-quick-actions">{["再短一点", "更自然", "少一点营销", "更有品牌感", "换个说法"].map(value => <button key={value} onClick={() => onRefine(value)}>{value}</button>)}</div><label className="rr-sr-only">对这条回复的调整要求</label><textarea aria-label={`对${candidate.label || "这条回复"}的调整要求`} rows={2} maxLength={1000} placeholder="例如：保留第一句，后面别太像广告。" value={instruction} onChange={event => setInstruction(event.target.value)} /><div className="rr-row"><button className="creative-text-button" disabled={!instruction.trim()} onClick={() => { setRuleMode(true); onRule(instruction); }}>以后都这样，记入规则</button><button className="creative-secondary" disabled={!instruction.trim()} onClick={() => { onRefine(instruction); setRuleMode(false); }}><Sparkles size={14} />仅优化这条</button></div>{ruleMode && <small>长期规则会先展示草案，确认后才保存。</small>}</fieldset>
  </section>;
}
