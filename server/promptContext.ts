import { companyKnowledgeConfig } from "./bailian.js";
import { RetrievedItem, RetrievedMemory } from "./bailian.js";

const maxContextChars = Number(process.env.MAX_CONTEXT_CHARS ?? 8000);

function clip(value: string, remaining: number) {
  if (value.length <= remaining) return value;
  return `${value.slice(0, Math.max(0, remaining - 12))}\n[已截断]`;
}

export function buildPromptContext(params: {
  memories: RetrievedMemory[];
  companyKnowledge: RetrievedItem[];
}) {
  const sections: string[] = [
    "你是企业内部 AI 助手。回答用户问题时，可以参考以下上下文。上下文可能包含用户个人记忆、历史偏好、企业知识库片段。请优先使用高相关、时间较新的信息。如果上下文不足以回答，不要编造。"
  ];

  const userSavedMemories = params.memories
    .filter((item) => item.metadata?.visibility === "explicit")
    .slice(0, 10);
  const implicitMemories = params.memories
    .filter((item) => item.metadata?.visibility !== "explicit")
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5);
  const memories = [...userSavedMemories, ...implicitMemories];
  if (memories.length) {
    sections.push(`【用户个人记忆】\n${memories.map((item) => `- ${item.text}`).join("\n")}`);
  }

  const companyKnowledge = params.companyKnowledge
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, companyKnowledgeConfig.topK);
  if (companyKnowledge.length) {
    sections.push(
      `【企业知识库片段】\n${companyKnowledge
        .map((item, index) => `${index + 1}. 来源：${item.source || "企业知识库"}\n内容：${item.text}`)
        .join("\n\n")}`
    );
  }

  let remaining = Number.isFinite(maxContextChars) && maxContextChars > 0 ? maxContextChars : 8000;
  const clipped: string[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const value = clip(section, remaining);
    clipped.push(value);
    remaining -= value.length + 2;
  }
  return clipped.join("\n\n");
}
