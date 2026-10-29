import { ChevronDown, Database } from "lucide-react";
import type { EnterpriseDataEvidence } from "../server/enterpriseDataPolicy";

function queryDescription(filters: Record<string, unknown>) {
  const labels: Record<string, string> = { shopIds: "店铺", warehouseIds: "仓库", skuCodes: "SKU", brands: "品牌" };
  return Object.entries(labels).flatMap(([key, label]) => Array.isArray(filters[key]) && filters[key].length ? [label + "：" + filters[key].join("、")] : []).join(" · ");
}

export function EnterpriseDataSources({ evidence }: { evidence?: EnterpriseDataEvidence }) {
  if (!evidence) return null;
  return <details className="enterprise-data-sources">
    <summary><Database size={14} aria-hidden="true" /><span>{evidence.status === "queried" ? "万里牛 · 已查询" : evidence.status === "skipped" ? "本轮未查询万里牛" : "企业数据未取得结果"}</span><ChevronDown size={14} aria-hidden="true" /></summary>
    <div className="enterprise-data-source-list">
      {evidence.sources.map((source, index) => <div className="enterprise-data-source" key={index}>
        <strong>{source.title}<span>{source.status === "error" ? "查询失败" : source.mode === "live" ? "实时只读接口" : `返回${source.returnedRows}行${source.hasMore ? " · 部分结果" : ""}`}</span></strong>
        {Boolean(source.filters.startDate || source.filters.search) && <p>{[source.filters.startDate ? `${source.filters.startDate} 至 ${source.filters.endDate}` : "", source.filters.search ? `关键词：${source.filters.search}` : ""].filter(Boolean).join(" · ")}</p>}
        {queryDescription(source.filters) && <p>{queryDescription(source.filters)}</p>}
        <p>查询于 {new Date(source.queriedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}{source.sync?.length ? ` · 最新入库：${source.sync.map(s => s.lastSuccessAt).join("、")}` : ""}</p>
        <p>{source.note}</p>
      </div>)}
      {evidence.notices.map((notice, index) => <p key={index}>{notice}</p>)}
      {!evidence.sources.length && !evidence.notices.length && <p>当前问题无需查询经营数据。</p>}
    </div>
  </details>;
}
