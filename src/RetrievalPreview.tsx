import React,{useEffect,useRef,useState} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Diagnostics={via:string;planningMs:number;totalMs:number;searches:{query:string;round:number;status:string;matched:number;ms:number}[];sources:{source:string;score:number;full:boolean;excerpt:string}[]};
type Result={previewId:string;message:{content:string};diagnostics:Diagnostics};
type Props={api:<T>(path:string,options?:RequestInit)=>Promise<T>; initialText:string; modelId:string; modelName:string; conversationId?:string;
  workspaceId?:string; agentId?:string; attachmentIds:string[]; webSearch:boolean; enterpriseData:boolean; onClose:()=>void; onCopyQuestion:(s:string)=>void};
export function RetrievalPreview(p:Props){
  const dialog=useRef<HTMLDialogElement>(null);
  const [text,setText]=useState(p.initialText);
  const [turns,setTurns]=useState<{question:string;result:Result}[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{const el=dialog.current;el?.showModal();return ()=>el?.close();},[]);
  const turnAttachments = turns.length ? [] : p.attachmentIds;
  async function send(e:React.FormEvent){
    e.preventDefault();
    const question=text.trim();
    if(busy || (!question && !turnAttachments.length))return;
    setBusy(true);setError("");
    try {
      const result=await p.api<Result>("/api/chat",{method:"POST",body:JSON.stringify({retrievalPreview:true,
        content:question,modelId:p.modelId,conversationId:p.conversationId,workspaceId:p.workspaceId,agentId:p.agentId,
        webSearch:p.webSearch,enterpriseData:p.enterpriseData,attachmentIds:turnAttachments,previewId:turns.at(-1)?.result.previewId})});
      setTurns(old=>[...old,{question,result}]);setText("");
    } catch(err){setError(err instanceof Error?err.message:"测试请求失败");}finally{setBusy(false);}
  }
  return <dialog ref={dialog} className="retrieval-preview" aria-labelledby="retrieval-preview-title" onCancel={e=>{e.preventDefault();p.onClose();}}>
    <header><h2 id="retrieval-preview-title">中间层测试</h2><button type="button" onClick={p.onClose}>返回原聊天</button></header>
    <p>{p.modelName} · 企业数据{p.enterpriseData?"已开启":"已关闭"} · 联网搜索{p.webSearch?"已开启":"已关闭"}{turnAttachments.length?" · 已带入 "+turnAttachments.length+" 个附件":""}</p>
    <div className="preview-turns">{turns.map(({question,result},i)=><section key={result.previewId}>
      <strong>{question || "分析附件"}</strong>
      <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{result.message.content}</ReactMarkdown></div>
      <details><summary>检索记录 · {result.diagnostics.sources.length} 个候选片段 · 总耗时 {(result.diagnostics.totalMs/1000).toFixed(1)} 秒</summary>
        <p>{result.diagnostics.via} · 判断耗时 {result.diagnostics.planningMs} 毫秒</p>
        {result.diagnostics.searches.map((s,j)=><p key={j}>第 {s.round} 轮 · {s.query} · {s.status}（{s.matched} 段，{s.ms} 毫秒）</p>)}
        {result.diagnostics.sources.map((s,j)=><p key={j}>{s.source} · {s.score.toFixed(3)} · {s.full?"已完整带入":"未完整带入"}<br/>{s.excerpt}</p>)}
      </details><button type="button" onClick={()=>{p.onCopyQuestion(question);p.onClose();}}>把第 {i+1} 问带回原输入框</button>
    </section>)}</div>
    <form onSubmit={send}><label htmlFor="preview-question">测试问题</label><textarea id="preview-question" rows={3} value={text} onChange={e=>setText(e.target.value)} autoFocus/>
      <div>{turns.length>0 && <button type="button" disabled={busy} onClick={()=>{setTurns([]);setError("");setText(p.initialText);}}>重新对照</button>}
      <button className="primary" disabled={busy || (!text.trim()&&!turnAttachments.length)}>{busy?"正在处理…":"发送测试问题"}</button></div>
      {error && <p role="alert">{error}</p>}
    </form>
  </dialog>;
}
