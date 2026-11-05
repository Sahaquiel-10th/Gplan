import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {Download,Plus,Upload,Search,LockKeyhole,ChevronRight,RefreshCw,X} from 'lucide-react';
import {AlipayAccounts,type AlipaySelection} from './AlipayAccounts';
import {financeSources,type FinanceAccountView,type FinanceDirectoryState,type FinanceDraftInput,type FinanceImportPreview} from '../shared/financeCatalog';
import './finance-accounts.css';
type Api=<T>(url:string,options?:RequestInit)=>Promise<T>;
const base='/api/admin/data-platform/finance-directory';
const blank=():FinanceDraftInput=>({legalEntity:'',sourceId:'alipay',name:'',last4:'',currency:'CNY',note:''});
const credentialLabels={not_configured:'未配置',incomplete:'待补齐',configured:'已保存'};
const checkLabels={not_tested:'未检测',partial:'待复核',available:'只读查询通过',failed:'未通过'};

/** Finance onboarding: a ledger of preparation, never a claim of bank connectivity. */
export function FinanceAccounts({api}:{api:Api}){
 const[state,setState]=useState<FinanceDirectoryState|null>(null),[mode,setMode]=useState<'single'|'import'|null>(null);
 const[draft,setDraft]=useState<FinanceDraftInput>(blank),[editing,setEditing]=useState<FinanceAccountView|null>(null);
 const[fields,setFields]=useState<Record<string,string>>({}),[notice,setNotice]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState('');
 const[csv,setCsv]=useState(''),[fileName,setFileName]=useState(''),[preview,setPreview]=useState<FinanceImportPreview|null>(null);
 const[search,setSearch]=useState(''),[entity,setEntity]=useState(''),[source,setSource]=useState('');
 const[selection,setSelection]=useState<AlipaySelection|null>(null);
 const message=useRef<HTMLDivElement>(null),form=useRef<HTMLFormElement>(null),credentialPanel=useRef<HTMLDetailsElement>(null);
 const load=useCallback(async()=>{const next=await api<FinanceDirectoryState>(base);setState(next);return next;},[api]);
 useEffect(()=>{load().catch(()=>setError('账户清单加载失败，请刷新重试'));},[load]);
 useEffect(()=>{if(mode==='single')form.current?.querySelector<HTMLInputElement>('input')?.focus();},[mode,editing?.id]);
 useEffect(()=>{const handle=()=>{load().catch(()=>undefined);};window.addEventListener('focus',handle);return()=>window.removeEventListener('focus',handle);},[load]);
 async function perform(name:string,fn:()=>Promise<void>){setBusy(name);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败，请重试');const details=e&&typeof e==='object'&&'fields'in e?(e as {fields?:Record<string,string>}).fields:undefined;setFields(details||{});requestAnimationFrame(()=>message.current?.focus());}finally{setBusy('');}}
 function openSingle(account?:FinanceAccountView){setMode('single');setEditing(account||null);setDraft(account?{legalEntity:account.legalEntity,sourceId:account.sourceId,name:account.name,last4:account.last4,currency:account.currency,note:account.note}:blank());setFields({});setError('');setNotice('');setPreview(null);setCsv('');setFileName('');}
 function openImport(){setMode('import');setError('');setNotice('');setFields({});setPreview(null);setCsv('');setFileName('');}
 async function save(event:FormEvent){event.preventDefault();await perform('save',async()=>{await api(`${base}/accounts${editing?'/'+editing.id:''}`,{method:editing?'PUT':'POST',body:JSON.stringify({...draft,...(editing?{revision:editing.revision}:{})})});setMode(null);setEditing(null);await load();setNotice('账户资料已保存。尚未配置的凭证可以之后补齐，保存资料不会启动同步。');});}
 async function readFile(file?:File){setPreview(null);setCsv('');setFileName('');if(!file)return;await perform('file',async()=>{if(file.size>256*1024||!file.name.toLowerCase().endsWith('.csv'))throw Error('请选择不超过256KB的CSV UTF-8文件；Excel可另存为该格式。');let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw Error('文件不是UTF-8编码，请在Excel另存为“CSV UTF-8（逗号分隔）”。');}setCsv(text);setFileName(file.name);});}
 function configure(account:FinanceAccountView){setSelection({financeAccountId:account.id,linkedAlipayId:account.linkedAlipayId,name:account.name,legalEntity:account.legalEntity,selectionKey:Date.now()});if(credentialPanel.current){credentialPanel.current.open=true;credentialPanel.current.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}}
 const filtered=state?.accounts.filter(a=>(!entity||a.legalEntityId===entity)&&(!source||a.sourceId===source)&&(!search||[a.name,a.legalEntity,a.last4,financeSources.find(s=>s.id===a.sourceId)?.name].join(' ').toLowerCase().includes(search.toLowerCase())))||[];
 const sourceInfo=financeSources.find(s=>s.id===draft.sourceId)!;
 const change=(field:keyof FinanceDraftInput,value:string)=>{setDraft(d=>({...d,[field]:value}));setFields(f=>({...f,[field]:''}));};
 const hint=(field:string)=>fields[field]?<small className="finance-field-error" id={'finance-error-'+field}>{fields[field]}</small>:null;
 return <>
 <section className="data-section finance-panel" aria-labelledby="finance-title">
  <header className="finance-heading"><div><small>资金数据 · 永久只读</small><h3 id="finance-title">资金账户清单</h3><p>先登记公司与账户，凭证和银行授权可以稍后补齐。</p></div><div className="finance-actions"><button className="secondary" disabled={!!busy} onClick={openImport}><Upload size={16} aria-hidden="true"/>批量导入</button><button className="primary" disabled={!!busy} onClick={()=>openSingle()}><Plus size={16} aria-hidden="true"/>添加账户</button></div></header>
  <div ref={message} className={`finance-message${error?' error':''}`} role={error?'alert':'status'} tabIndex={-1} hidden={!notice&&!error}>{error||notice}{Object.keys(fields).some(k=>fields[k])&&<ul>{Object.entries(fields).filter(([,v])=>v).map(([k,v])=><li key={k}><a href={'#finance-'+k}>{v}</a></li>)}</ul>}</div>
  {mode==='single'&&<form ref={form} className="finance-editor" onSubmit={save} aria-label={editing?'编辑账户资料':'添加账户资料'}>
   <div className="finance-heading"><h4>{editing?'编辑账户资料':'添加账户资料'}</h4><button type="button" className="secondary" disabled={!!busy} onClick={()=>setMode(null)}><X size={16} aria-hidden="true"/>取消</button></div>
   <div className="finance-form-grid">
    <label>公司名称<input id="finance-legalEntity" required maxLength={100} value={draft.legalEntity} list="finance-entities" readOnly={!!editing?.linkedAlipayId} onChange={e=>change('legalEntity',e.target.value)} aria-invalid={!!fields.legalEntity} aria-describedby={fields.legalEntity?'finance-error-legalEntity':undefined}/>{hint('legalEntity')}</label>
    <datalist id="finance-entities">{state?.entities.map(e=><option key={e.id} value={e.name}/>)}</datalist>
    <label>银行／来源<select id="finance-sourceId" disabled={!!editing?.linkedAlipayId} value={draft.sourceId} onChange={e=>change('sourceId',e.target.value)}>{financeSources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>{hint('sourceId')}</label>
    <label>账户名称<input id="finance-name" required maxLength={60} value={draft.name} readOnly={!!editing?.linkedAlipayId} placeholder="例如：电商收款户" onChange={e=>change('name',e.target.value)} aria-invalid={!!fields.name} aria-describedby={fields.name?'finance-error-name':undefined}/>{hint('name')}</label>
    <label>账号尾号 <span className="finance-optional">选填</span><input id="finance-last4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={draft.last4} placeholder="仅最后4位" onChange={e=>change('last4',e.target.value)} aria-invalid={!!fields.last4} aria-describedby={fields.last4?'finance-last4-hint finance-error-last4':'finance-last4-hint'}/><small id="finance-last4-hint">不知道可以留空，不要填写完整账号。</small>{hint('last4')}</label>
    <label>币种<input id="finance-currency" required maxLength={3} value={draft.currency} readOnly={!!editing?.linkedAlipayId} placeholder="CNY" onChange={e=>change('currency',e.target.value.toUpperCase())} aria-invalid={!!fields.currency} aria-describedby={fields.currency?'finance-error-currency':undefined}/>{hint('currency')}</label>
    <label>备注 <span className="finance-optional">选填</span><input id="finance-note" maxLength={200} value={draft.note} placeholder="不填密码、验证码或密钥" onChange={e=>change('note',e.target.value)} aria-invalid={!!fields.note} aria-describedby={fields.note?'finance-error-note':undefined}/>{hint('note')}</label>
   </div>
   <div className="finance-prerequisites"><strong>{sourceInfo.stage}</strong><span>{sourceInfo.requirements.join('；')}。</span></div>
   <div className="finance-form-footer"><p>这里只保存账户清单，不会调用银行接口或自动同步。</p><button className="primary" disabled={!!busy}>{busy==='save'?'保存中…':'保存账户资料'}</button></div>
  </form>}
  {mode==='import'&&<section className="finance-editor" aria-label="批量导入账户">
   <div className="finance-heading"><h4>批量导入账户</h4><button className="secondary" disabled={!!busy} onClick={()=>{setMode(null);setPreview(null);setCsv('');setFileName('');}}><X size={16} aria-hidden="true"/>取消</button></div>
   <ol className="finance-import-steps"><li><a className="secondary" href={base+'/template.csv'}><Download size={16} aria-hidden="true"/>下载空白模板</a><p>用Excel填写6列资料，再另存为CSV UTF-8。</p></li><li><label className="finance-file-label">选择填好的CSV<input type="file" accept=".csv,text/csv" disabled={!!busy} onChange={e=>{void readFile(e.target.files?.[0]);e.target.value='';}}/></label><p>每批最多500行、256KB，只收账号尾号，不收密钥。</p></li><li><button className="secondary" disabled={!csv||!!busy} onClick={()=>perform('preview',async()=>{setPreview(null);setPreview(await api<FinanceImportPreview>(base+'/imports/preview',{method:'POST',body:JSON.stringify({csv})}));})}>{busy==='preview'?'检查中…':'预览并检查'}</button><p>先检查，再确认。重复记录跳过，资料冲突需先修正。</p></li></ol>
   {fileName&&<p className="finance-file-name">已选择：{fileName}</p>}
   {preview&&<div className="finance-preview"><div className="finance-heading"><div><h4>导入预览</h4><p role="status">新增 {preview.creates} 个 · 已有 {preview.skips} 个 · 错误 {preview.errors} 行</p></div><button className="primary" disabled={!!busy||preview.errors>0||preview.creates===0} onClick={()=>perform('import',async()=>{const result=await api<{created:number;skipped:number}>(base+'/imports/commit',{method:'POST',body:JSON.stringify({csv,digest:preview.digest})});setMode(null);setPreview(null);setCsv('');setFileName('');await load();setNotice(`已新增${result.created}个账户，跳过${result.skipped}个已有账户。尚未启用同步。`);})}>{busy==='import'?'导入中…':`确认新增 ${preview.creates} 个账户`}</button></div>
    {preview.errors>0&&<p role="alert" className="finance-field-error">请先修正错误行并重新上传。本次不会写入任何账户。</p>}
    <ul className="finance-preview-rows">{preview.rows.map(r=><li key={r.rowNumber} className={r.action==='error'?'has-error':''}><span className="finance-row-number">第 {r.rowNumber} 行</span><div>{r.values?<><strong>{r.values.name}</strong><span>{r.values.legalEntity} · {financeSources.find(s=>s.id===r.values!.sourceId)?.name} · {r.values.last4?'尾号 '+r.values.last4:'尾号待补'} · {r.values.currency}</span></>:r.errors.map((e,i)=><span className="finance-field-error" key={i}>{e}</span>)}</div><span>{r.action==='create'?'将新增':r.action==='skip'?'已有，跳过':'需修正'}</span></li>)}</ul>
   </div>}
  </section>}
  <div className="finance-ledger-toolbar"><p>{state?`${state.entities.length} 家公司 · ${state.accounts.length} 个账户`:'正在读取账户清单…'}</p><div className="finance-filters"><label className="finance-search"><Search size={16} aria-hidden="true"/><input aria-label="搜索公司、账户或尾号" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索公司、账户或尾号"/></label><select aria-label="按公司筛选" value={entity} onChange={e=>setEntity(e.target.value)}><option value="">所有公司</option>{state?.entities.map(e=><option value={e.id} key={e.id}>{e.name}</option>)}</select><select aria-label="按银行筛选" value={source} onChange={e=>setSource(e.target.value)}><option value="">所有来源</option>{financeSources.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select><button className="secondary" aria-label="刷新账户清单" disabled={!!busy} onClick={()=>perform('refresh',async()=>{await load();})}><RefreshCw size={16} aria-hidden="true"/></button></div></div>
  <div className="finance-ledger" aria-busy={!state&&!error}>
   {filtered.length?filtered.map(a=><article className="finance-account-row" key={a.id} aria-label={a.name+' '+a.legalEntity}>
    <div className="finance-account-identity"><h4>{a.name}</h4><p>{a.legalEntity}</p><small>{financeSources.find(s=>s.id===a.sourceId)?.name} · {a.last4?'尾号 '+a.last4:'尾号待补'} · {a.currency}</small>{a.note&&<small>{a.note}</small>}</div>
    <dl className="finance-statuses"><div><dt>凭证配置</dt><dd>{credentialLabels[a.credentialStatus]}</dd></div><div><dt>接口检测</dt><dd className={a.checkStatus==='failed'?'finance-field-error':''}>{checkLabels[a.checkStatus]}</dd></div><div><dt>自动同步</dt><dd>未启用</dd></div></dl>
    <div className="finance-account-actions"><button className="secondary" disabled={!!busy} onClick={()=>openSingle(a)}>编辑资料</button>{a.sourceId==='alipay'&&state?.credentialConfigurationOpen?<button className="secondary" onClick={()=>configure(a)}>配置凭证<ChevronRight size={15} aria-hidden="true"/></button>:<small>{a.sourceId==='alipay'?'凭证配置入口已锁定':'待银行规范与授权'}</small>}</div>
   </article>):<div className="finance-empty"><h4>{state?.accounts.length?'没有匹配的账户':'先把账户记下来，凭证稍后补'}</h4><p>{state?.accounts.length?'调整公司、来源筛选或搜索条件。':'可以逐个添加，也可以用空白模板批量导入。登记清单不需要银行Key。'}</p>{!state?.accounts.length&&state&&<button className="secondary" onClick={openImport}><Upload size={16} aria-hidden="true"/>批量导入账户</button>}</div>}
  </div>
  <details className="finance-source-guide"><summary>12 个来源的接入准备要求</summary><div>{financeSources.map(s=><article key={s.id}><div><strong>{s.name}</strong><small>{s.stage}</small></div><p>{s.requirements.join('；')}。</p></article>)}</div></details>
  <p className="finance-boundary"><LockKeyhole size={16} aria-hidden="true"/>清单与凭证分开管理。登记不代表接通，检测通过不代表账单已入库或自动同步已启用。</p>
 </section>
 <details ref={credentialPanel} className="data-section finance-credential-panel"><summary>企业支付宝 · 加密凭证与只读检测</summary><AlipayAccounts api={api} selection={selection} onChanged={()=>{void load();}}/></details>
 </>;
}
