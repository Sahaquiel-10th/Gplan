import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, KeyRound, LockKeyhole, Plus, RefreshCw, Save, X } from "lucide-react";
import "./alipay-accounts.css";

type Capability = { status: "not_tested" | "available" | "no_bill" | "failed"; message: string; checkedAt?: string; code?: string };
type Account = { id: string; name: string; legalEntity: string; appId: string; mode: "public_key" | "certificate"; configured: boolean; applicationPublicKey: string; capabilities: { balance: Capability; bill: Capability }; syncStatus: "not_enabled" };
type State = { configurationOpen: boolean; encryptionReady: boolean; accounts: Account[] };
type Draft = { id?: string; name: string; legalEntity: string; appId: string; mode: Account["mode"]; privateKey: string; alipayPublicKey: string; appCert: string; alipayCert: string; rootCert: string };
type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
const blank = (): Draft => ({ name: "", legalEntity: "", appId: "", mode: "public_key", privateKey: "", alipayPublicKey: "", appCert: "", alipayCert: "", rootCert: "" });
const base = "/api/admin/data-platform/alipay";
const capabilityLabel = (value: Capability) => ({ not_tested: "未检测", available: "查询通过", no_bill: "待账单复核", failed: "未通过" })[value.status];

export function AlipayAccounts({ api }: { api: Api }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmLock, setConfirmLock] = useState(false);
  const [loading, setLoading] = useState(true);
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
  }, [load]);
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
      setNotice("配置已加密保存。请分别检测真实接口权限；尚未开启自动同步。");
      await load();
    });
  }
  async function generate() {
    if (!draft) return;
    await perform("generate", async () => {
      const result = await api<{ account: Account }>(`${base}/accounts/generate-key`, { method: "POST", body: JSON.stringify({ name: draft.name, legalEntity: draft.legalEntity, appId: draft.appId, mode: "public_key" }) });
      setDraft({ ...blank(), ...result.account });
      setNotice("新应用密钥已生成，私钥只保存在服务器。请复制下方应用公钥到支付宝，再填回支付宝公钥并保存。");
      await load();
    });
  }
  async function readFile(key: keyof Draft, file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 32000) { setError("密钥或证书文件不能超过32KB"); return; }
    try {
      const text = await file.text();
      setDraft(old => old ? { ...old, [key]: text } : null);
      setNotice("文件已选取，点击保存后才会加密提交到服务器。");
    } catch { setError("文件无法读取，请重新选择"); }
  }
  const current = state?.accounts.find(a => a.id === draft?.id);
  if (loading) return <section className="data-section alipay-panel" aria-busy="true">正在读取企业支付宝账户…</section>;
  return <section className="data-section alipay-panel">
    <div className="alipay-heading">
      <div><small>资金数据 · 只读接入</small><h3>企业支付宝账户</h3><p>逐个配置、逐项检测。配置完成后锁定入口，账户凭证不再向页面提供。</p></div>
      {state?.configurationOpen && <button className="secondary" disabled={!!busy || !state.encryptionReady} onClick={() => { setDraft(blank()); setError(""); setNotice(""); }}><Plus size={16} aria-hidden="true" />添加账户</button>}
    </div>
    <div ref={messageRef} tabIndex={-1} role={error ? "alert" : "status"} className={`alipay-message${error ? " error" : ""}`} hidden={!error && !notice}>{error || notice}</div>
    {!state?.encryptionReady && <p className="alipay-warning">服务器尚未配置资金凭证加密主密钥，不能保存或生成密钥。请由维护人员先完成服务器配置。</p>}
    {!state?.configurationOpen && <p className="alipay-locked"><LockKeyhole size={16} aria-hidden="true" />账户配置入口已关闭。当前页面只显示接入状态；维护需由服务器侧临时开放。</p>}
    <div className="alipay-account-list">
      {state?.accounts.length ? state.accounts.map(account => <article className="alipay-account" key={account.id}>
        <div className="alipay-account-title"><div><h4>{account.name}</h4><p>{account.legalEntity}</p><small>APP_ID {account.appId} · {account.mode === "certificate" ? "证书模式" : "公钥模式"}</small></div><span className="status-pill waiting">{account.configured ? "配置已保存" : "待完成配置"}</span></div>
        <dl className="alipay-capabilities">{([['balance', '当前余额'], ['bill', '昨日资金账单']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd><span className={`alipay-capability ${account.capabilities[key].status}`}>{capabilityLabel(account.capabilities[key])}</span><small>{account.capabilities[key].message}{account.capabilities[key].code ? `（${account.capabilities[key].code}）` : ""}</small>{account.capabilities[key].checkedAt && <time>{new Date(account.capabilities[key].checkedAt!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>}</dd></div>)}</dl>
        <div className="alipay-account-footer"><small>自动同步：未启用，待单日入库与核对验收</small>{state.configurationOpen && <div className="alipay-actions"><button className="secondary" disabled={!!busy} onClick={() => { setDraft({ ...blank(), id: account.id, name: account.name, legalEntity: account.legalEntity, appId: account.appId, mode: account.mode }); setNotice(""); setError(""); }}>配置</button><button className="secondary" disabled={!!busy || !account.configured} onClick={() => perform(account.id, async () => { await api(`${base}/accounts/${account.id}/check`, { method: "POST", body: "{}" }); await load(); setNotice("接口检测结束，请查看该账户的逐项结果。检测不等于数据已同步。"); })}><RefreshCw size={15} aria-hidden="true" />{busy === account.id ? "检测中…" : "检测只读接口"}</button></div>}</div>
      </article>) : <p className="alipay-empty">尚未添加账户。{state?.configurationOpen ? "请在财务电脑上逐个登记企业支付宝应用。" : "请联系维护人员开放首次配置。"}</p>}
    </div>
    {state?.configurationOpen && draft && <form ref={formRef} className="alipay-form" onSubmit={save} aria-label="支付宝账户配置">
      <div className="alipay-heading"><h4>{draft.id ? "完成 / 更新账户配置" : "添加企业支付宝账户"}</h4><button type="button" className="secondary" disabled={!!busy} onClick={() => setDraft(null)}><X size={15} aria-hidden="true" />取消</button></div>
      <div className="alipay-fields">
        <label>账户名称<input required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：某店铺企业支付宝" /></label>
        <label>支付宝认证企业主体<input required maxLength={100} value={draft.legalEntity} onChange={e => setDraft({ ...draft, legalEntity: e.target.value })} /><small>按支付宝认证信息填写；此名称仅为登记信息，不代表已核验账户归属。</small></label>
        <label>APP_ID<input required inputMode="numeric" pattern="[0-9]{16,32}" maxLength={32} readOnly={!!draft.id} value={draft.appId} onChange={e => setDraft({ ...draft, appId: e.target.value })} /><small>使用客户企业自有应用，已有账户不能更换 APP_ID。</small></label>
        <label>接口加签模式<select value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value as Account["mode"] })}><option value="public_key">公钥模式（RSA2）</option><option value="certificate">公钥证书模式（RSA2）</option></select></label>
      </div>
      {!draft.id && draft.mode === "public_key" && <div className="alipay-generate"><div><strong>新应用，还没有密钥？</strong><p>服务器生成独立密钥，私钥不经过微信、不回显。请勿用于替换已有系统正在使用的密钥。</p></div><button type="button" className="secondary" disabled={!!busy || !draft.name || !draft.legalEntity || !/^\d{16,32}$/.test(draft.appId)} onClick={generate}><KeyRound size={15} aria-hidden="true" />{busy === "generate" ? "生成中…" : "为新应用生成密钥"}</button></div>}
      {current?.applicationPublicKey && <div className="alipay-public-key"><label>应用公钥（复制到支付宝，不是下方的支付宝公钥）<textarea readOnly rows={4} value={current.applicationPublicKey.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "")} /></label><button type="button" className="secondary" onClick={() => { navigator.clipboard.writeText(current.applicationPublicKey.replace(/-----[^\n]+-----/g, "").replace(/\s/g, "")).then(() => setNotice("应用公钥已复制")).catch(() => setError("复制失败，请手动选择公钥复制")); }}><Copy size={15} aria-hidden="true" />复制应用公钥</button></div>}
      <label className="alipay-file-field">应用私钥文件{draft.id ? "（留空保留已有私钥）" : "（本机生成时上传）"}<input type="file" accept=".pem,.txt,.key" disabled={!!busy} onChange={e => { void readFile("privateKey", e.target.files?.[0]); e.target.value = ""; }} /><small>{draft.privateKey ? "已读取，待加密保存" : draft.id ? "服务器已有私钥，不会回显或下载" : "支持 PKCS1 / PKCS8；证书模式请上传已有私钥及配套证书"}</small></label>
      {draft.mode === "public_key" ? <label className="alipay-file-field">支付宝公钥<textarea rows={3} value={draft.alipayPublicKey} autoComplete="off" spellCheck={false} onChange={e => setDraft({ ...draft, alipayPublicKey: e.target.value })} placeholder={draft.id && current?.configured ? "留空保留已保存的支付宝公钥" : "从支付宝应用开发设置复制，不是应用公钥"} /><input aria-label="上传支付宝公钥文件" type="file" accept=".pem,.txt,.key" disabled={!!busy} onChange={e => { void readFile("alipayPublicKey", e.target.files?.[0]); e.target.value = ""; }} /></label> : <div className="alipay-fields">{([['appCert', '应用公钥证书'], ['alipayCert', '支付宝公钥证书'], ['rootCert', '支付宝根证书']] as const).map(([key, label]) => <label className="alipay-file-field" key={key}>{label}<input type="file" accept=".crt,.pem,.cer,.txt" disabled={!!busy} onChange={e => { void readFile(key, e.target.files?.[0]); e.target.value = ""; }} /><small>{draft[key] ? "已读取，待保存" : draft.id && current?.configured ? "留空保留已有证书" : "请选择配套的 PEM 证书文件"}</small></label>)}</div>}
      <div className="alipay-form-end"><p>网关由系统固定为支付宝正式接口，无需填写回调 URL。这里只做只读查询；保存后仍须检测接口权限。</p><button className="primary" disabled={!!busy || !state.encryptionReady}><Save size={15} aria-hidden="true" />{busy === "save" ? "加密保存中…" : "加密保存配置"}</button></div>
    </form>}
    {state?.configurationOpen && <div className="alipay-lock-area"><div><h4>配置结束，锁定入口</h4><p>锁定后所有配置与手动检测接口立即关闭，管理员也无法修改。不会删除已保存的凭证，也不会停止后续已验收的同步任务。</p><label><input type="checkbox" checked={confirmLock} onChange={e => setConfirmLock(e.target.checked)} />我确认本次配置已完成；重新开放需要服务器维护人员操作。</label></div><button className="secondary" disabled={!!busy || !confirmLock} onClick={() => perform("lock", async () => { await api(`${base}/lock`, { method: "POST", body: "{}" }); setDraft(null); setConfirmLock(false); await load(); setNotice("配置已锁定，服务器也已拒绝配置请求。"); })}><LockKeyhole size={16} aria-hidden="true" />{busy === "lock" ? "锁定中…" : "完成并锁定"}</button></div>}
  </section>;
}
