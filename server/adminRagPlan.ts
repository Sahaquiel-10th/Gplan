import type { Message } from "./types.js";
import type { RetrievedItem } from "./bailian.js";

export type Plan = {queries:string[]; followup:boolean};
export const plannerPrompt = '根据用户当前问题和最近对话，补全品牌、课程等指代。只返回 JSON {"queries":[],"followup":false}。企业数据开关由用户控制；询问企业规则或课程，用1至2个短词组查知识库；纯创作或常识可留空。只问数字通常不用查知识库。综合经营分析要同时查数和复盘规则、指标口径，并设followup=true。不要解释。';

export function parsePlan(text:string): Plan {
  const v=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));
  if (!v || typeof v.followup!=="boolean" || !Array.isArray(v.queries) ||
      v.queries.length>2 || v.queries.some((q:unknown)=>typeof q!=="string" || !q.trim() || q.trim().length>64)) throw Error("invalid_plan");
  return {queries:[...new Set<string>(v.queries.map((q:string)=>q.trim()))], followup:v.followup};
}
export async function planSearch(messages:Message[], decide:(history:Message[])=>Promise<string>) {
  const question=messages[messages.length-1].content;
  if (messages.length===1 && /^(?:(?:请|帮我|请帮我)?(?:对个对联|对个下联|对下联)|上联[是：:][\p{Script=Han}]{2,16}[，,]帮我对个下联)[。？！!？]?$/u.test(question))
    return {queries:[],followup:false,via:"直接回答"};
  try {
    return {...parsePlan(await decide(messages.slice(-5).map(m=>({...m,content:m.content.slice(-1000)})))),via:"智能判断"};
  } catch {
    return {queries:[question],followup:false,via:"原问题检索（判断服务暂不可用）"};
  }
}
export function queriesFromFacts(results:Record<string,unknown>[]) {
  const queries=new Set<string>();
  for (const result of results) {
    const source=result.source as {tool?:string;status?:string;filters?:{groupBy?:string}}|undefined;
    const group=source?.filters?.groupBy;
    if (source?.status!=="success" || source.tool!=="sales_summary" || !["brand","shop","product"].includes(group || "") || !Array.isArray(result.rows)) continue;
    for (const row of result.rows) {
      const name=row?.name || row?.dimension;
      if (typeof name!=="string" || !name.trim() || !(Number(row.amount)>0)) continue;
      if (Number(row.amountSharePercent)>=30)
        queries.add(name.trim().slice(0,48)+" 销售集中度 经营复盘口径");
      if (group==="product" && /赠品|赠送/.test(name))
        queries.add(name.trim().slice(0,48)+" 赠品活动 销售件数统计口径");
      if(queries.size>=2) return [...queries].slice(0,2);
    }
  }
  return [...queries];
}
export function mergeEvidence(groups:RetrievedItem[][],limit:number) {
  const selected=new Map<string,RetrievedItem>();
  const add=(item:RetrievedItem)=>{
    const key=item.text.trim().replace(/\s+/g," ");
    if(key && (selected.has(key) ? selected.get(key)!.score<item.score : selected.size<limit)) selected.set(key,item);
  };
  for(const group of groups) if(group[0]) add(group[0]);
  groups.flat().sort((a,b)=>b.score-a.score).forEach(add);
  return [...selected.values()];
}

type PreviewTurn = {scope:string; history:Message[]; expires:number};
const previews = new Map<string,PreviewTurn>();
export function previewHistory(id:string,scope:string) {
  const entry=previews.get(id);
  if (!entry || entry.expires<Date.now() || entry.scope!==scope)
    throw Object.assign(new Error("测试对话已过期，请重新开始测试"),{status:409});
  return entry.history;
}
export function savePreview(id:string,scope:string,history:Message[],limit:number) {
  for(const [key,entry] of previews) if(entry.expires<Date.now()) previews.delete(key);
  if(previews.size>=128) previews.delete(previews.keys().next().value!);
  previews.set(id,{scope,history:limit>0 ? history.slice(-limit) : [],expires:Date.now()+30*60_000});
}
