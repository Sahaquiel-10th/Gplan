import { ChevronDown, Database } from "lucide-react";
import type { EnterpriseDataEvidence } from "../server/enterpriseDataPolicy";
import { enterpriseEvidenceStatus } from "../server/enterpriseDataPolicy";

function queryDescription(filters: Record<string, unknown>) {
  const labels: Record<string, string> = { shopIds: "店铺", warehouseIds: "仓库", skuCodes: "SKU", brands: "品牌" };
  return Object.entries(labels).flatMap(([key, label]) => Array.isArray(filters[key]) && filters[key].length ? [label + "：" + filters[key].join("、")] : []).join(" · ");
}

export function EnterpriseDataSources({ evidence }: { evidence?: EnterpriseDataEvidence }) {
  if (!evidence) return null;
  const status = enterpriseEvidenceStatus(evidence);
  return <details className="enterprise-data-sources">
    <summary><Database size={14} aria-hidden="true" /><span>{status === "queried" ? "万里牛 · 已查询" : status === "partial" ? "万里牛 · 部分查询成功" : status === "skipped" ? "本轮未查询万里牛" : "企业数据未取得结果"}</span><ChevronDown size={14} aria-hidden="true" /></summary>
    <div className="enterprise-data-source-list">
      {evidence.timing ? <p>数据准备用时{(evidence.timing.totalMs / 1000).toFixed(1)}秒，其中查询规划{(evidence.timing.planningMs / 1000).toFixed(1)}秒、数据查询{(evidence.timing.queryMs / 1000).toFixed(1)}秒。</p> : null}
      {evidence.task ? <p>识别时间：{evidence.task.startDate} 至 {evidence.task.endDate} · {evidence.task.completed ? "所需指标已齐全" : "部分指标尚未取得"}</p> : null}
      {evidence.sources.map((source, index) => <div className="enterprise-data-source" key={index}>
        <strong>{source.title}<span>{source.status === "error" ? source.failureReason === "timeout" ? "数据查询超时" : source.failureReason === "budget" ? "查询时间预算已用完" : "查询失败" : source.mode === "live" ? "实时只读接口" : `返回${source.returnedRows}行${source.hasMore || source.partial ? " · 部分结果" : ""}`}</span></strong>
        {Boolean(source.filters.startDate || source.filters.search) && <p>{[source.filters.startDate ? `${source.filters.startDate} 至 ${source.filters.endDate}` : "", source.filters.search ? `关键词：${source.filters.search}` : ""].filter(Boolean).join(" · ")}</p>}
        {queryDescription(source.filters) && <p>{queryDescription(source.filters)}</p>}
        {source.coverage && <p>已查询范围共{source.coverage.queriedDays}天。{source.coverage.recordsByCurrency.map(record => record.daysWithRecords == null ? "" : `${record.currencyCode}：${record.daysWithRecords}天有记录${record.firstRecordDate ? `（${record.firstRecordDate}至${record.lastRecordDate}）` : ""}。`).join("")}</p>}
        <p>查询于 {new Date(source.queriedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}{source.sync?.length ? ` · 最新入库：${source.sync.map(s => s.lastSuccessAt).join("、")}` : ""}</p>
        <p>{source.note}</p>
        {source.querySteps?.length ? <details><summary>查询执行详情（{source.querySteps.length}步）</summary>
          {source.querySteps.map((step, index) => <p key={index}>{step.name}：{step.status === "success" ? `成功，返回${step.returnedRows}行` : "失败"}，耗时{(step.durationMs / 1000).toFixed(2)}秒</p>)}
          {source.fields?.length ? <p>返回字段：{source.fields.join("、")}</p> : null}
        </details> : null}
      </div>)}
      {evidence.notices.map((notice, index) => <p key={index}>{notice}</p>)}
      {evidence.context ? <p>企业数据上下文：{evidence.context.characters.toLocaleString()}字符，摘要 {evidence.context.sha256.slice(0, 12)}。不含模型密钥。</p> : null}
      {!evidence.sources.length && !evidence.notices.length && <p>当前问题无需查询经营数据。</p>}
    </div>
  </details>;
}
