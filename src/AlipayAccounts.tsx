import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, KeyRound, LockKeyhole, Plus, RefreshCw, Save, X } from "lucide-react";
import "./alipay-accounts.css";

type Capability = { status: "not_tested" | "available" | "no_bill" | "failed"; message: string; checkedAt?: string; code?: string };
type Account = { id: string; name: string; legalEntity: string; appId: string; financeAccountId?: string; mode: "public_key" | "certificate"; configured: boolean; applicationPublicKey: string; capabilities: { balance: Capability; bill: Capability }; syncStatus: "not_enabled" };
type State = { configurationOpen: boolean; encryptionReady: boolean; accounts: Account[] };
type Draft = { id?: string; financeAccountId?: string; name: string; legalEntity: string; appId: string; mode: Account["mode"]; privateKey: string; alipayPublicKey: string; appCert: string; alipayCert: string; rootCert: string };
export type AlipaySelection = { financeAccountId: string; linkedAlipayId?: string; name: string; legalEntity: string; selectionKey: number };
type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
const blank = (): Draft => ({ name: "", legalEntity: "", appId: "", mode: "public_key", privateKey: "", alipayPublicKey: "", appCert: "", alipayCert: "", rootCert: "" });
const base = "/api/admin/data-platform/alipay";
const capabilityLabel = (value: Capability) => ({ not_tested: "未检测", available: "查询通过", no_bill: "待账单复核", failed: "未通过" })[value.status];

export function AlipayAccounts({ api, selection, onChanged, onBusyChange, onDirtyChange, onSelectAccount, refreshKey }: { api: Api; selection?: AlipaySelection | null; onChanged?: () => void; onBusyChange?: (busy:boolean)=>void; onDirtyChange?: (dirty:boolean)=>void; onSelectAccount?: (selection:AlipaySelection)=>void; refreshKey?:number }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmLock, setConfirmLock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view,setView]=useState<'configuration'|'results'>('configuration');
  const unsaved=!!draft&&!!(draft.privateKey||draft.alipayPublicKey||draft.appCert||draft.alipayCert||draft.rootCert||(!draft.id&&draft.appId)||(draft.id&&state?.accounts.find(a=>a.id===draft.id)?.mode!==draft.mode));
  useEffect(()=>{onBusyChange?.(!!busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{onDirtyChange?.(unsaved);return()=>onDirtyChange?.(false);},[unsaved,onDirtyChange]);
  const messageRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    const next = await api<State>(base);
    setState(next);
    if (!next.configurationOpen) { setDraft(null); setConfirmLock(false); }
    return next;
  }, [api]);
  useEffect(() => {
    load().catch(() => setError("资金账户状态加载失败，请刷新重试")).finally(() => setLoading(false));
  }, [load,refreshKey]);
  useEffect(() => {
    if(!selection)return;
    let cancelled=false;
    load().then(next=>{
      if(cancelled)return;
      if(!next.configurationOpen){setView('results');return;}
      const account=next.accounts.find(a=>a.id===selection.linkedAlipayId||a.financeAccountId===selection.financeAccountId);
      setDraft(account?{...blank(),id:account.id,financeAccountId:account.financeAccountId,name:account.name,legalEntity:account.legalEntity,appId:account.appId,mode:account.mode}:{...blank(),financeAccountId:selection.financeAccountId,name:selection.name,legalEntity:selection.legalEntity});
      setView('configuration');
      setError('');setNotice('已从账户清单带入公司与账户名称，请核对应用归属后配置。');
    }).catch(()=>{if(!cancelled)setError('凭证配置状态读取失败，请重试');});
    return()=>{cancelled=true;};
  }, [selection?.selectionKey,load]);
  useEffect(() => {
    if (!state?.configurationOpen) return;
    const timer = window.setInterval(() => { load().catch(() => undefined); }, 30000);
    return () => window.clearInterval(timer);
  }, [load, state?.configurationOpen]);
  useEffect(() => {
    if (draft) formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [draft?.id, !!draft]);
  async function perform(action: string, fn: () => Promise<void>) {
    setBusy(action); setError(""); setNotice("");
    try { await fn(); }
    catch (e) {
      // Drop private material on every failed submission, including a server-side lock/revocation.
      setDraft(old => old ? { ...old, privateKey: "", alipayPublicKey: "", appCert: "", alipayCert: "", rootCert: "" } : null);
      setError(e instanceof Error ? e.message : "操作失败，请重试");
      await load().catch(() => undefined);
      requestAnimationFrame(() => messageRef.current?.focus());
    } finally { setBusy(""); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await perform("save", async () => {
      await api(`${base}/accounts${draft.id ? `/${draft.id}` : ""}`, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) });
      setDraft(null);
      setView('results');
      setNotice("配置已加密保存。请分别检测真实接口权限；尚未开启自动同步。");
      await load();
      onChanged?.();
    });
  }
  async function generate() {
    if (!draft) return;
    await perform("generate", async () => {
      const result = await api<{ account: Account }>(`${base}/accounts/generate-key`, { method: "POST", body: JSON.stringify({ name: draft.name, legalEntity: draft.legalEntity, appId: draft.appId, financeAccountId: draft.financeAccountId, mode: "public_key" }) });
      setDraft({ ...blank(), ...result.account });
      setNotice("新应用密钥已生成，私钥只保存在服务器。请复制下方应用公钥到支付宝，再填回支付宝公钥并保存。");
      await load();
      onChanged?.();
    });
  }
  async function readFile(key: keyof Draft, file?: File) {
    if (!file) return;
    setDraft(old => old ? { ...old, [key]: "" } : null);
    setError("");
    if (file.size > 32000) { setError("密钥或证书文件不能超过32KB"); return; }
    try {
      const text = await file.text();
      setDraft(old => old ? { ...old, [key]: text } : null);
      setNotice("文件已选取，点击保存后才会加密提交到服务器。");
    } catch { setError("文件无法读取，请重新选择"); }
  }
  const current = state?.accounts.find(a => a.id === draft?.id);
  const visibleAccounts=state?.accounts.filter(a=>!selection||a.id===selection.linkedAlipayId||a.financeAccountId===selection.financeAccountId)||[];
  function showConfiguration(){if(!draft&&visibleAccounts[0]){const account=visibleAccounts[0];setDraft({...blank(),id:account.id,financeAccountId:account.financeAccountId,name:account.name,legalEntity:account.legalEntity,appId:account.appId,mode:account.mode});}setView('configuration');}
  if (loading) return <section className="data-section alipay-panel" aria-busy="true">正在读取企业支付宝账户…</section>;
  return <section className="data-section alipay-panel">
    {!selection&&<div className="alipay-heading">
      <div><small>资金数据 · 只读接入</small><h3>企业支付宝凭证配置</h3><p>逐个配置、逐项检测。配置完成后锁定入口，账户凭证不再向页面提供。</p></div>
      {state?.configurationOpen && !onSelectAccount && <button className="secondary" disabled={!!busy || !state.encryptionReady} onClick={() => { setDraft(blank()); setError(""); setNotice(""); }}><Plus size={16} aria-hidden="true" />添加凭证配置</button>}
    </div>}
    {selection&&<><div className="finance-account-context"><strong>{selection.name}</strong><span>{selection.legalEntity} · 企业支付宝</span><small>账户名称仅用于本平台内部识别，不是支付宝登录账号。当前只配置这一个账户。</small></div><nav className="finance-section-tabs" aria-label="此账户接入步骤"><button aria-pressed={view==='configuration'} disabled={!!busy||!state?.configurationOpen} onClick={showConfiguration}>1 · 填写凭证</button><button aria-pressed={view==='results'} disabled={!!busy} onClick={()=>setView('results')}>2 · 接口检测与结果</button></nav></>}
    <div ref={messageRef} tabIndex={-1} role={error ? "alert" : "status"} className={`alipay-message${error ? " error" : ""}`} hidden={!error && !notice}>{error || notice}</div>
    {!state?.encryptionReady && <p className="alipay-warning">服务器尚未配置资金凭证加密主密钥，不能保存或生成密钥。请由维护人员先完成服务器配置。</p>}
    {!state?.configurationOpen && <p className="alipay-locked"><LockKeyhole size={16} aria-hidden="true" />账户配置入口已关闭。当前页面只显示接入状态；维护需由服务器侧临时开放。</p>}
    {view==='results'&&unsaved&&<p className="alipay-warning">有未保存的凭证修改。请先回“填写凭证”保存，再检测，避免把旧配置的检测结果当成新配置结果。</p>}
    {(!selection||view==='results')&&<div className="alipay-account-list">
      {visibleAccounts.length ? visibleAccounts.map(account => <article className="alipay-account" key={account.id}>
        <div className="alipay-account-title"><div><h4>{account.name}</h4><p>{account.legalEntity}</p><small>APP_ID {account.appId} · {account.mode === "certificate" ? "证书模式" : "公钥模式"}</small></div><span className="status-pill waiting">{account.configured ? "配置已保存" : "待完成配置"}</span></div>
        <dl className="alipay-capabilities">{([['balance', '当前余额'], ['bill', '昨日资金账单']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd><span className={`alipay-capability ${account.capabilities[key].status}`}>{capabilityLabel(account.capabilities[key])}</span><small>{account.capabilities[key].message}{account.capabilities[key].code ? `（${account.capabilities[key].code}）` : ""}</small>{account.capabilities[key].checkedAt && <time>{new Date(account.capabilities[key].checkedAt!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>}</dd></div>)}</dl>
        <div className="alipay-account-footer"><small>自动同步：未启用，待单日入库与核对验收</small>{state?.configurationOpen && <div className="alipay-actions"><button className="secondary" disabled={!!busy} onClick={() => {if(onSelectAccount){onSelectAccount({financeAccountId:account.financeAccountId||'',linkedAlipayId:account.id,name:account.name,legalEntity:account.legalEntity,selectionKey:Date.now()});return;}if(unsaved&&!window.confirm('要放弃尚未保存的凭证修改，重新读取已保存配置吗？'))return; setDraft({ ...blank(), id: account.id, financeAccountId: account.financeAccountId, name: account.name, legalEntity: account.legalEntity, appId: account.appId, mode: account.mode });setView('configuration'); setNotice(""); setError(""); }}>修改凭证</button><button className="secondary" disabled={!!busy || !account.configured || unsaved} onClick={() => perform(account.id, async () => { await api(`${base}/accounts/${account.id}/check`, { method: "POST", body: "{}" }); await load(); onChanged?.(); setNotice("接口检测结束，请查看该账户的逐项结果。检测不等于数据已同步。"); })}><RefreshCw size={15} aria-hidden="true" />{busy === account.id ? "检测中…" : "检测只读接口"}</button></div>}</div>
      </article>) : <p className="alipay-empty">尚未添加凭证配置。{selection?'请先在“填写凭证”中保存这个账户的配置，再回来检测。':state?.configurationOpen ? '请从账户清单打开“配置与检测”，或在此登记早期已有应用。' : '请先登记账户资料，再联系维护人员开放凭证配置。'}</p>}
    </div>}
    {state?.configurationOpen && draft && (!selection||view==='configuration') && <form ref={formRef} className="alipay-form" onSubmit={save} aria-label="支付宝账户配置">
      <div className="alipay-heading"><h4>{draft.id ? "完成 / 更新凭证配置" : "添加支付宝凭证配置"}</h4>{!selection&&<button type="button" className="secondary" disabled={!!busy} onClick={() => {if(!draft.privateKey&&!draft.alipayPublicKey&&!draft.appCert&&!draft.alipayCert&&!draft.rootCert||window.confirm('有尚未保存的凭证，确定放弃？'))setDraft(null);}}><X size={15} aria-hidden="true" />取消</button>}</div>
      <p className="finance-step-note">先确认 APP_ID 与加签模式，再提供配套密钥。加密保存后会留在此弹窗，继续检测接口。</p>
      <div className="alipay-fields">
        {!selection&&<><label>账户名称（内部识别用）<input required maxLength={60} value={draft.name} readOnly={!!draft.financeAccountId} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：某店铺企业支付宝" /><small>自己起的识别名，不是登录账号或开户名称。从清单带入时无需再次填写。</small></label>
        <label>支付宝认证企业主体<input required maxLength={100} value={draft.legalEntity} readOnly={!!draft.financeAccountId} onChange={e => setDraft({ ...draft, legalEntity: e.target.value })} /><small>填支付宝认证信息中的公司全称；仅作登记，不代表系统已核验归属。</small></label></>}
        <label>APP_ID<input required inputMode="numeric" pattern="[0-9]{16,32}" maxLength={32} readOnly={!!draft.id} value={draft.appId} onChange={e => setDraft({ ...draft, appId: e.target.value })} aria-describedby="alipay-appid-help" /><small id="alipay-appid-help">在支付宝开放平台中打开该企业自有应用，复制应用的 APP_ID；不是商户 PID 或支付宝账号。保存后不可更换。</small></label>
        <label>接口加签模式<select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as Account["mode"] })} aria-describedby="alipay-mode-help"><option value="public_key">公钥模式（RSA2）</option><option value="certificate">公钥证书模式（RSA2）</option></select><small id="alipay-mode-help">与支付宝应用“开发设置”中的接口加签方式保持一致；证书模式需另外上传 3 份配套证书。不要凭感觉切换。</small></label>
      </div>
      {!draft.id && draft.mode === "public_key" && <div className="alipay-generate"><div><strong>新应用，还没有密钥？</strong><p>服务器生成独立密钥，私钥不经过微信、不回显。请勿用于替换已有系统正在使用的密钥。</p></div><button type="button" className="secondary" disabled={!!busy || !draft.name || !draft.legalEntity || !/^\d{16,32}$/.test(draft.appId)} onClick={generate}><KeyRound size={15} aria-hidden="true" />{busy === "generate" ? "生成中…" : "为新应用生成密钥"}</button></div>}
      {current?.applicationPublicKey && <div className="alipay-public-key"><label>应用公钥（复制到支付宝，不是下方的支付宝公钥）<textarea readOnly rows={4} value={current.applicationPublicKey.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "")} /><small>这是本平台生成的公开部分。复制到该应用的开发设置中；私钥仍留在服务器，不提供下载。</small></label><button type="button" className="secondary" onClick={() => { navigator.clipboard.writeText(current.applicationPublicKey.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "")).then(() => setNotice("应用公钥已复制")).catch(() => setError("复制失败，请手动选择公钥复制")); }}><Copy size={15} aria-hidden="true" />复制应用公钥</button></div>}
      <label className="alipay-file-field">应用私钥文件{draft.id ? "（留空保留已有私钥）" : "（本机生成时上传）"}<input type="file" accept=".pem,.txt,.key" disabled={!!busy} onChange={e => { void readFile("privateKey", e.target.files?.[0]); e.target.value = ""; }} aria-describedby="alipay-private-help"/><small id="alipay-private-help">选择密钥工具在财务电脑生成的应用私钥文件，支持 PKCS1 / PKCS8，最大 32KB。不要传公钥文件或网银 UKey。{draft.privateKey ? " 已读取，待加密保存。" : draft.id ? " 留空保留服务器已有私钥，不会回显或下载。" : " 仅新应用可用上方按钮在服务器生成；不需要两种方式都做。"}</small></label>
      {draft.mode === "public_key" ? <label className="alipay-file-field">支付宝公钥<textarea rows={3} value={draft.alipayPublicKey} autoComplete="off" spellCheck={false} onChange={e => setDraft({ ...draft, alipayPublicKey: e.target.value })} placeholder={draft.id && current?.configured ? "留空保留已保存的支付宝公钥" : "从支付宝应用开发设置复制，不是应用公钥"} aria-describedby="alipay-public-help" /><input aria-label="上传支付宝公钥文件" type="file" accept=".pem,.txt,.key" disabled={!!busy} onChange={e => { void readFile("alipayPublicKey", e.target.files?.[0]); e.target.value = ""; }} aria-describedby="alipay-public-help" /><small id="alipay-public-help">从该应用开发设置复制“支付宝公钥”，可粘贴或上传文件，二选一。它由支付宝提供，不是“应用公钥”；已保存的可留空保留。</small></label> : <div className="alipay-fields">{([['appCert', '应用公钥证书'], ['alipayCert', '支付宝公钥证书'], ['rootCert', '支付宝根证书']] as const).map(([key, label]) => <label className="alipay-file-field" key={key}>{label}<input type="file" accept=".crt,.pem,.cer,.txt" disabled={!!busy} onChange={e => { void readFile(key, e.target.files?.[0]); e.target.value = ""; }} /><small>{key==='appCert'?'从该应用开发设置下载，必须与应用私钥配对。':key==='alipayCert'?'从支付宝开放平台下载该应用配套的支付宝公钥证书，用于验证响应。':'从支付宝开放平台下载支付宝根证书，不能用应用证书代替。'}{draft[key] ? ' 已读取，待保存。' : draft.id && current?.configured ? ' 留空保留已有证书。' : ' 请选择 PEM 格式文件。'}</small></label>)}</div>}
      <div className="alipay-form-end"><p>网关由系统固定为支付宝正式接口，无需填写回调 URL。这里只做只读查询；保存后仍须检测接口权限。</p><button className="primary" disabled={!!busy || !state.encryptionReady}><Save size={15} aria-hidden="true" />{busy === "save" ? "加密保存中…" : "加密保存配置"}</button></div>
    </form>}
    {selection&&view==='configuration'&&!draft&&<p className="alipay-empty">当前没有正在编辑的凭证。切换到“接口检测与结果”，可选择“修改凭证”继续。</p>}
    {!selection&&state?.configurationOpen && <details className="finance-prerequisites"><summary>本次全部配置完成：锁定维护入口</summary><div className="alipay-lock-area"><div><h4>所有账户都配置完后再锁定</h4><p>锁定会关闭本企业所有账户的凭证修改与手动检测，不是只关闭当前账户。不会删除凭证。重新开放需联系服务器维护人员。</p><label><input type="checkbox" checked={confirmLock} onChange={e => setConfirmLock(e.target.checked)} />我确认所有账户已完成配置，立即锁定整个维护入口。</label></div><button className="secondary" disabled={!!busy || !confirmLock} onClick={() => perform("lock", async () => { await api(`${base}/lock`, { method: "POST", body: "{}" }); setDraft(null); setConfirmLock(false); await load(); onChanged?.(); setNotice("配置已锁定，服务器也已拒绝配置请求。"); })}><LockKeyhole size={16} aria-hidden="true" />{busy === "lock" ? "锁定中…" : "完成并锁定"}</button></div></details>}
  </section>;
}
