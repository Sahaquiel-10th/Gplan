import React, { useState } from "react";
import type { AgentSkill } from "../server/agentSkills";
type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
export function SkillImport({
  api,
  value,
  onChange,
}: {
  api: Api;
  value?: AgentSkill;
  onChange: (s: AgentSkill) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api<{ skill: AgentSkill }>(
        "/api/admin/agent-skills/import",
        { method: "POST", body: form },
      );
      onChange(r.skill);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="skill-import">
      <h3>上传 Skill</h3>
      <p>
        上传后解析工作流程，可先预览、调试，再保存。模型和成员权限沿用下方配置。
      </p>
      <label>
        选择 .md 或 .zip（最大5MB）
        <input
          type="file"
          accept=".md,.zip"
          disabled={busy}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {busy && <p>正在解析…</p>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {value && (
        <>
          <strong>{value.name}</strong>
          <p>{value.description}</p>
          <small>
            {value.filename} · {value.documents.length}份文档 ·{" "}
            {value.documents.reduce((n, d) => n + d.content.length, 0)}字
          </small>
          {value.warnings.map((w, i) => (
            <p className="notice" key={i}>
              {w}
            </p>
          ))}
          {value.documents.map((d) => (
            <details key={d.path}>
              <summary>
                {d.path}
                {d.path === value.entry ? " · 主入口" : ""}
              </summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: 260,
                  overflow: "auto",
                }}
              >
                {d.content}
              </pre>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
