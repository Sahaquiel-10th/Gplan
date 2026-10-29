import React, { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, LoaderCircle, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { commerceModuleTypes, type CommerceBrief, type CommerceComposition, type CommerceModule, type CommerceModuleType, type CommerceReference } from "../server/commerceTypes";
import { defaultComposition, mergeReferenceModules } from "../server/commerceComposition";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
const imageUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;
const emphasisOptions = { primary: "优先突出", normal: "正常展示", secondary: "辅助说明" } as const;

// Operators compare a reference against their own replacement, not a blank prompt editor.
// The highlighted artwork leads; source text is muted, editable content uses the existing
// paper/inset/blue tokens, inherited 14px type, quiet borders and a 4px spacing rhythm.
export function CommerceModules({ api, brief, onChange, onBusy }: {
  api: Api; brief: CommerceBrief; onChange: (value: CommerceComposition) => void; onBusy: (busy: boolean) => void;
}) {
  const c = brief.composition || defaultComposition(brief);
  const [active, setActive] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const version = useRef(0);
  const attempted = useRef(new Set<string>());
  const alive = useRef(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const revealSource = (id: string) => { setActive(id); if (window.matchMedia("(max-width: 760px)").matches) stageRef.current?.scrollIntoView({ behavior: "auto", block: "start" }); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; version.current++; onBusy(false); }; }, []);
  const loading = (value: boolean) => { setBusy(value); onBusy(value); };
  const patch = (id: string, fields: Partial<CommerceModule>) => onChange({ ...c, modules: c.modules.map(m => m.id === id ? { ...m, ...fields } : m) });
  const selected = c.modules.find(m => m.id === active);
  const source = selected?.source;
  const shown = c.modules.filter(m => m.enabled || m.source);
  const available = c.modules.filter(m => !m.enabled && !m.source);

  function chooseReference(id: string) {
    version.current++; setError(""); setMessage(""); setActive("");
    onChange({ ...c, primaryReferenceId: id, reference: undefined, overall: { layout: "", background: "", palette: "", visualStyle: "" }, modules: c.modules.map(m => ({ ...m, source: undefined, location: m.source ? "" : m.location, appearance: m.source ? "" : m.appearance })) });
  }
  async function recognize() {
    if (!c.primaryReferenceId || busy) return;
    const token = ++version.current;
    loading(true); setError(""); setMessage("");
    try {
      const { reference } = await api<{ reference: CommerceReference }>("/api/commerce/reference/recognize", { method: "POST", body: JSON.stringify({ imageId: c.primaryReferenceId }) });
      if (!alive.current || token !== version.current) return;
      const merged = mergeReferenceModules(c, reference);
      onChange(merged); setActive(merged.modules.find(m => m.source)?.id || "");
      setMessage("已拆解参考图。原图文字仅供对照，请勾选模块并填写本次内容。");
    } catch (e) { if (alive.current && token === version.current) setError(e instanceof Error ? e.message : "识别暂未完成，可手动添加模块"); }
    finally { if (alive.current && token === version.current) loading(false); }
  }
  useEffect(() => {
    if (c.primaryReferenceId && !c.reference && !attempted.current.has(c.primaryReferenceId)) {
      attempted.current.add(c.primaryReferenceId); void recognize();
    }
  }, [c.primaryReferenceId]);

  async function suggest(m: CommerceModule) {
    const token = ++version.current; loading(true); setError("");
    try {
      const result = await api<{ suggestions: string[] }>("/api/commerce/modules/suggest", { method: "POST", body: JSON.stringify({ type: m.type, productName: brief.productName, brand: brief.brand, specification: brief.specification, facts: brief.facts }) });
      if (alive.current && token === version.current) setSuggestions(s => ({ ...s, [m.id]: result.suggestions }));
    } catch (e) { if (alive.current && token === version.current) setError(e instanceof Error ? e.message : "建议暂未完成"); }
    finally { if (alive.current && token === version.current) loading(false); }
  }
  async function uploadAsset(m: CommerceModule, file?: File) {
    if (!file || busy) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { setError("请上传10MB以内的 PNG、JPG 或 WebP 素材"); return; }
    if (!m.assetId && new Set(c.modules.map(m => m.assetId).filter(Boolean)).size >= 3) { setError("模块素材最多3张，请先移除不需要的素材"); return; }
    const token = ++version.current; loading(true); setError("");
    try {
      const form = new FormData(); form.append("files", file);
      const result = await api<{ attachments: { id: string }[] }>("/api/attachments", { method: "POST", body: form });
      if (alive.current && token === version.current) patch(m.id, { assetId: result.attachments[0].id });
    } catch (e) { if (alive.current && token === version.current) setError(e instanceof Error ? e.message : "素材上传失败"); }
    finally { if (alive.current && token === version.current) loading(false); }
  }

  const assetControl = (m: CommerceModule) => m.assetId ? <div className="creative-module-asset"><img src={imageUrl(m.assetId)} alt={`${m.name}本次素材`} /><span>{m.type === "gift" ? "仅作赠品，不替换主品" : `仅用于「${m.name}」`}</span><button type="button" className="creative-icon-button" disabled={busy} aria-label={`移除${m.name}素材`} onClick={() => patch(m.id, { assetId: "" })}><X size={14} /></button></div> : <label className="creative-module-asset-upload"><ImagePlus size={16} />{m.type === "gift" ? "上传本次赠品图" : "上传此模块素材"}<input aria-label={`${m.name}素材`} type="file" disabled={busy} accept="image/png,image/jpeg,image/webp" onChange={e => { void uploadAsset(m, e.target.files?.[0]); e.target.value = ""; }} /></label>;

  return <section className="creative-module-editor" aria-label="主图模块配置">
    <div className="creative-module-intro"><h3>把参考图，改成你的内容</h3><p>勾选要用的模块，填写本次内容。取消勾选就不展示，清空只清掉本次填写。</p></div>
    {brief.referenceImageIds.length > 0 && <fieldset className="creative-question"><legend>先拆解哪张的模块？</legend><p className="creative-help">这里只选模块拆解的原图。生成每张主图时，还可以分别选择要用的参考。</p><div className="creative-reference-picker">{brief.referenceImageIds.map((id, i) => <button type="button" disabled={busy} className={c.primaryReferenceId === id ? "selected" : ""} aria-pressed={c.primaryReferenceId === id} aria-label={`参考图${i + 1}作为主要参考`} key={id} onClick={() => chooseReference(id)}><img src={imageUrl(id)} alt={`参考图${i + 1}`} /><span>{c.primaryReferenceId === id && <Check size={13} />}参考图 {i + 1}</span></button>)}</div></fieldset>}
    {busy && <p className="creative-inline-status" role="status"><LoaderCircle size={16} className="creative-spin" />正在识别、上传或整理建议，请稍等…</p>}
    {message && <p className="creative-help" role="status">{message}</p>}
    {error && <p className="creative-note" role="alert">{error}</p>}
    <div className="creative-module-workbench">
      <aside className="creative-reference-panel">
        {c.primaryReferenceId ? <>
          <div ref={stageRef} className="creative-reference-stage"><img src={imageUrl(c.primaryReferenceId)} alt="主要参考图，点击模块查看对应区域" />
            {source?.bbox && <div className="creative-reference-region" style={{ left: `${source.bbox[0] * 100}%`, top: `${source.bbox[1] * 100}%`, width: `${source.bbox[2] * 100}%`, height: `${source.bbox[3] * 100}%` }} aria-hidden="true"><span>{selected?.name}</span></div>}
          </div>
          <p className="creative-help">{source ? `正在对照：${source.name} · ${source.location || "位置待核对"}` : "点选右侧模块，在原图中查看大致位置。"}</p>
          <button type="button" className="creative-text-button" disabled={busy} onClick={() => void recognize()}><RefreshCw size={14} />{c.reference ? "重新识别参考图" : "识别参考图模块"}</button>
        </> : <div className="creative-module-empty"><ImagePlus size={28} /><strong>没有参考图，也可以制作</strong><p>先从商品、卖点、活动等固定模块开始。需要参考时，返回商品资料添加图片。</p></div>}
        <fieldset className="creative-question creative-background-choice"><legend>背景怎么处理？</legend><div className="creative-module-suggestions"><button type="button" disabled={busy} aria-pressed={!c.overall.background} className={!c.overall.background ? "selected" : ""} onClick={() => onChange({ ...c, overall: { ...c.overall, background: "" } })}>按商品推荐</button>{c.reference && <button type="button" disabled={busy} aria-pressed={!!c.overall.background && c.overall.background === c.reference.overall.background} className={c.overall.background === c.reference.overall.background ? "selected" : ""} onClick={() => onChange({ ...c, overall: { ...c.overall, background: c.reference!.overall.background } })}>沿用参考背景</button>}</div><label className="creative-custom">或指定背景<input disabled={busy} aria-label="背景" value={c.overall.background} maxLength={300} placeholder="例如：简洁实验室、浅色柔光" onChange={e => onChange({ ...c, overall: { ...c.overall, background: e.target.value } })} /></label></fieldset>
        <details className="creative-details"><summary>更多视觉配置</summary><div className="creative-module-overall">{([['layout', '整体构图'], ['palette', '主要配色'], ['visualStyle', '视觉风格']] as const).map(([key, label]) => <label key={key}>{label}<input disabled={busy} value={c.overall[key]} maxLength={300} placeholder="未指定，让 AI 合理安排" onChange={e => onChange({ ...c, overall: { ...c.overall, [key]: e.target.value } })} /></label>)}<button type="button" className="creative-text-button" disabled={busy} onClick={() => onChange({ ...c, overall: { layout: "", background: "", palette: "", visualStyle: "" } })}>清空整体配置</button></div></details>
      </aside>
      <div className="creative-module-list">
        {shown.map((m, i) => <article key={m.id} className={`creative-module-card ${m.enabled ? "is-enabled" : ""} ${active === m.id ? "is-active" : ""}`} onFocusCapture={() => setActive(m.id)}>
          <header><label className="creative-module-toggle"><input type="checkbox" disabled={busy} checked={m.enabled} onChange={e => { patch(m.id, { enabled: e.target.checked }); setActive(m.id); }} aria-label={`使用${m.name}`} /><strong>{m.name}</strong></label><button type="button" className="creative-text-button" onClick={() => revealSource(m.id)} aria-label={`查看${m.name}原图位置`}>{m.source ? "查看原图位置" : "固定模块"}<span className="creative-module-number">{String(i + 1).padStart(2, '0')}</span></button></header>
          {m.source && <div className="creative-module-original"><span>原图配置 · {m.source.location || "位置待核对"}</span><p>{m.source.texts.join(" / ") || "图片素材，无可辨认文字"}</p><small>{m.source.appearance || "视觉配置待核对"}</small>{(m.source.confidence !== "high" || m.source.uncertainties.length > 0) && <small className="creative-module-warning">请核对：{m.source.uncertainties.join("；") || "识别把握有限，可修改下方配置"}</small>}</div>}
          {m.enabled ? <div className="creative-module-fields">
            <label>本次{m.type === "product" ? "商品展示要求" : "使用的内容"}<textarea disabled={busy} value={m.content} maxLength={600} rows={2} placeholder={m.type === "product" ? `按白底图突出主品${brief.productName}，也可补充数量与摆放要求` : m.type === "gift" ? "例如：下单即赠便携装30g × 1；在商品旁辅助展示" : "填写自己的文字，AI 会根据内容自动分行和排版"} onChange={e => patch(m.id, { content: e.target.value })} /></label>
            {m.type === "product" && <p className="creative-help">主品使用第一步的商品白底图，包装、Logo、形状与规格保持一致。</p>}
            {m.type === "gift" && <>{assetControl(m)}<p className="creative-help">赠品仅使用本模块的素材。主品保持突出，赠品不替换主品，也不沿用参考图里的赠品。</p></>}
            {!m.content.trim() && !m.assetId && m.type !== "product" && <p className="creative-module-warning">待补充：填写本次内容、上传素材，或取消使用。不会沿用参考图文字。</p>}
            <div className="creative-module-tools"><button type="button" className="creative-text-button" disabled={busy || !m.content && !m.assetId} onClick={() => { patch(m.id, { content: "", assetId: "" }); setSuggestions(s => ({ ...s, [m.id]: [] })); }}>清空填写</button>{["product", "brand", "benefit", "other"].includes(m.type) && <button type="button" className="creative-text-button" disabled={busy} onClick={() => void suggest(m)}><Sparkles size={13} />帮我写</button>}</div>
            {m.type === "benefit" && brief.facts.length > 0 && <div className="creative-module-suggestions">{brief.facts.map(f => <button type="button" disabled={busy} key={f} onClick={() => patch(m.id, { content: [...new Set([...m.content.split('\n').filter(Boolean), f])].join('\n') })}>{f}<Plus size={12} /></button>)}</div>}
            {suggestions[m.id]?.length > 0 && <div className="creative-module-suggestions" aria-label={`${m.name}文案建议`}>{suggestions[m.id].map(t => <button type="button" disabled={busy} key={t} onClick={() => patch(m.id, { content: t })}>{t}<Plus size={12} /></button>)}</div>}
            <fieldset className="creative-module-emphasis"><legend>展示层级</legend>{Object.entries(emphasisOptions).map(([key, label]) => <button type="button" disabled={busy} key={key} aria-pressed={m.emphasis === key} className={m.emphasis === key ? "selected" : ""} onClick={() => patch(m.id, { emphasis: key as CommerceModule['emphasis'] })}>{label}</button>)}</fieldset>
            <details className="creative-details"><summary>调整位置、样式或素材</summary><div className="creative-module-visual-fields"><label>位置<input disabled={busy} value={m.location} maxLength={160} placeholder="例如：顶部横条、商品右侧" onChange={e => patch(m.id, { location: e.target.value })} /></label><label>颜色、大小与排列<textarea disabled={busy} value={m.appearance} maxLength={500} rows={2} placeholder="例如：红底白字，重点数字更大" onChange={e => patch(m.id, { appearance: e.target.value })} /></label><label>模块名称<input disabled={busy} value={m.name} maxLength={60} onChange={e => patch(m.id, { name: e.target.value })} /></label>
              <div className="creative-module-tools"><button type="button" className="creative-text-button" disabled={busy} onClick={() => patch(m.id, { location: "", appearance: "" })}>清空视觉配置</button>{m.source && <button type="button" className="creative-text-button" disabled={busy} onClick={() => patch(m.id, { location: m.source!.location, appearance: m.source!.appearance })}>恢复原图配置</button>}</div>
              {m.type !== "gift" && assetControl(m)}
            </div></details>
          </div> : <p className="creative-module-disabled">本次不展示。勾选后填写你的内容。</p>}
        </article>)}
        <details className="creative-details creative-module-add"><summary><Plus size={15} />添加模块</summary><div className="creative-module-add-options">{available.map(m => <button type="button" className="creative-secondary" disabled={busy} key={m.id} onClick={() => { patch(m.id, { enabled: true }); setActive(m.id); }}>{m.name}</button>)}<button type="button" className="creative-secondary" disabled={busy || c.modules.length >= 40} onClick={() => { const id = `custom-${crypto.randomUUID()}`; onChange({ ...c, modules: [...c.modules, { id, type: "other" as CommerceModuleType, name: "自定义模块", enabled: true, content: "", location: "", appearance: "", emphasis: "normal", assetId: "" }] }); setActive(id); }}>自定义模块</button></div></details>
      </div>
    </div>
  </section>;
}

export function CompositionSummary({ value }: { value?: CommerceComposition }) {
  if (!value) return null;
  return <div className="creative-composition-summary"><strong>本次主图内容</strong>{value.modules.filter(m => m.enabled).map(m => <p key={m.id}><span>{m.name}</span>{m.content || (m.type === "product" ? "按原商品图展示" : "使用指定素材")}{m.location && <small> · {m.location}</small>}{m.assetId && m.content && <small> · 指定素材</small>}</p>)}<p className="creative-help">不展示：{value.modules.filter(m => !m.enabled).map(m => m.name).join("、") || "无"}</p></div>;
}
