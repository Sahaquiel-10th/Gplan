import React, { Fragment, useEffect, useRef, useState } from "react";
import { Menu, Plus, Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Result = {
  previewId: string;
  message: { content: string };
  diagnostics: {
    via: string;
    totalMs: number;
    searches: { query: string; status: string; matched: number }[];
    sources: { source: string; excerpt: string }[];
  };
};
type Props = {
  visible: boolean;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  models: { id: string; name: string; isDefault: boolean }[];
  onOpenMenu: () => void;
};

export function RetrievalPreview({ visible, api, models, onOpenMenu }: Props) {
  const [turns, setTurns] = useState<{ question: string; answer: Result }[]>([]);
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState("");
  const [enterpriseData, setEnterpriseData] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const modelId = selected || (models.find(model => model.isDefault) ?? models[0])?.id;
  const locked = Boolean(pending || turns.length);

  useEffect(() => {
    if (visible) end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, pending, visible]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || !modelId || pending) return;
    setSelected(modelId);
    setPending(question);
    setDraft("");
    setError("");
    try {
      const answer = await api<Result>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ content: question, modelId, enterpriseData,
          retrievalPreview: true, previewId: turns.at(-1)?.answer.previewId })
      });
      setTurns(previous => [...previous, { question, answer }]);
    } catch (cause) {
      setDraft(question);
      setError(cause instanceof Error ? cause.message : "发送失败，请重试");
    } finally {
      setPending("");
    }
  }

  if (!visible) return null;
  return <section className="chat retrieval-chat" aria-label="测试聊天">
    <header className="chat-header">
      <button className="mobile-menu" aria-label="打开导航" onClick={onOpenMenu}><Menu size={20} /></button>
      <div className="chat-title"><strong>测试聊天</strong><span>中间层已启用</span></div>
      <div className="chat-controls">
        <button type="button" className="secondary" disabled={Boolean(pending)} onClick={() => {
          setTurns([]); setDraft(""); setError("");
        }}><Plus size={15} />新测试</button>
        <select aria-label="测试模型" value={modelId ?? ""} disabled={locked} onChange={e => setSelected(e.target.value)}>
          {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </div>
    </header>
    <div className="messages">
      {turns.map(({ question, answer }) => <Fragment key={answer.previewId}>
        <article className="message user"><div className="bubble">{question}</div></article>
        <article className="message assistant"><div className="bubble">
          <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer.message.content}</ReactMarkdown></div>
          <details><summary>检索记录</summary>
            <p>{answer.diagnostics.via} · {(answer.diagnostics.totalMs / 1000).toFixed(1)} 秒</p>
            {answer.diagnostics.searches.map((s,i) => <p key={i}>{s.query} · {s.status} · {s.matched} 段</p>)}
            {answer.diagnostics.sources.map((s,i) => <p key={i}><strong>{s.source}</strong><br />{s.excerpt}</p>)}
          </details>
        </div></article>
      </Fragment>)}
      {pending && <><article className="message user"><div className="bubble">{pending}</div></article>
        <div className="typing" role="status">正在生成回答…</div></>}
      <div ref={end} />
    </div>
    <form className="composer" onSubmit={send}>
      {error && <p className="chat-error" role="alert">{error}</p>}
      <div className="test-composer">
        <label><input type="checkbox" checked={enterpriseData} disabled={locked}
          onChange={e => setEnterpriseData(e.target.checked)} /> 企业数据</label>
        <textarea aria-label="测试消息" placeholder={modelId ? "输入测试问题，可继续追问" : "请先在管理后台启用聊天模型"} rows={2}
          value={draft} disabled={Boolean(pending)} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
            e.preventDefault(); e.currentTarget.form?.requestSubmit();
          } }} />
        <button className="primary send" aria-label="发送测试消息" disabled={!modelId || !draft.trim() || Boolean(pending)}><Send size={18} /></button>
      </div>
    </form>
  </section>;
}
