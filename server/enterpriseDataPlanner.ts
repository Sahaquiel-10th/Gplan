import type { Message } from "./types.js";
import { normalizeDataQuery, shanghaiDate } from "./enterpriseDataQueries.js";

const shift = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);

export function planCompanyAnalysis(messages: Message[], today = shanghaiDate()) {
  const last = messages.filter(message => message.role === "user").at(-1);
  if (!last || !/分析|梳理/.test(last.content) || !/全方位|全面|多方面|深度|深入|结合|这些数据|这一天|当天/.test(last.content)) return undefined;
  if (!/这一天|当天|这些数据|上述|刚才|这些品牌|全公司|各品牌|所有品牌/.test(last.content)) return undefined;
  // This path is limited to a single, company-wide day already established in
  // the conversation. Specific scopes and explicit comparison periods use the
  // general planner so their filters and periods remain intact.
  if (/店|仓|sku|供应商|渠道|剔除|排除|不含|不包括|只看|仅|指定|其中|同比|环比|上周|上月|本月|今年|去年|季度|最近\d|近\d|\d+天/i.test(last.content)) return undefined;
  let date: string | undefined;
  if (/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|昨天|昨日|今天|今日|前天/.test(last.content)) {
    const explicit = planBrandReport([{ ...last, content: last.content + " 所有品牌销售额" }], today);
    if (!explicit || explicit.startDate !== explicit.endDate) return undefined;
    date = explicit.startDate;
  } else {
    for (const message of [...messages].reverse()) {
      const source = message.enterpriseData?.sources.find(source => source.tool === "sales_summary" && source.status === "success");
      if (!source) continue;
      const filters = source.filters;
      if (filters.startDate !== filters.endDate || ["shopIds", "warehouseIds", "skuCodes", "brands"].some(key => Array.isArray(filters[key]) && filters[key].length) || filters.search) return undefined;
      date = String(filters.startDate || "");
      break;
    }
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const daily = { startDate: date, endDate: date };
  const calls = [
    { tool: "sales_summary", params: { ...daily, groupBy: "brand", limit: 100 } },
    { tool: "sales_brand_documents", params: { ...daily, limit: 100 } },
    { tool: "sales_summary", params: { startDate: shift(date, -7), endDate: shift(date, -1), groupBy: "day", limit: 100 } },
    { tool: "sales_summary", params: { ...daily, groupBy: "shop", limit: 20 } },
    { tool: "sales_summary", params: { ...daily, groupBy: "product", limit: 20 } },
    { tool: "inbound_summary", params: { ...daily, groupBy: "brand", limit: 100 } },
    { tool: "inventory", params: { limit: 10 } },
  ];
  return {
    calls, startDate: date, endDate: date,
    requestedMetrics: ["amount", "amountSharePercent", "quantity", "quantitySharePercent", "documentCount", "documentSharePercent"],
    note: `围绕${date}分析当天销售、品牌、店铺、商品与采购入库；历史对照先采用目标日前7天（${shift(date, -7)}至${shift(date, -1)}）。店铺和商品展示前20项，库存展示当前快照前10项，汇总按各来源实际覆盖范围使用；更长历史及未返回明细须明确列为后续分析范围。`,
  };
}

// A small, conservative path for the common company-wide brand report. Other
// scopes still use the model; never silently drop a shop, SKU or warehouse filter.
export function planBrandReport(messages: Message[], today = shanghaiDate()) {
  const users = messages.filter(m => m.role === "user").slice(-12);
  const last = users.at(-1)?.content.trim() || "";
  const brandIntent = /(?:各.{0,6}品牌|所有.{0,6}品牌|全部.{0,6}品牌|品牌.{0,12}占比)/;
  const followup = /^(?:那|那么|再|帮我|请|查看|查询|统计|呢|？|\?|\s|\d|年|月|日|至|到|-|\/|上上周|上周|本周|这周|最近一周|近一周|最近\d+天|近\d+天)+$/;
  const isReport = (text: string) => brandIntent.test(text) && /销售|出库|金额|占比/.test(text);
  const prior = [...users].reverse().find(m => isReport(m.content));
  if (!isReport(last) && !(prior && (followup.test(last) || ((last.match(/\d{4}-\d{2}-\d{2}/g) || []).length >= 2 && /查|看|统计/.test(last) && !/库存|采购|入库|支付宝/.test(last))))) return undefined;
  const intent = isReport(last) ? last : prior!.content;
  if (/店|仓|sku|供应商|渠道|剔除|排除|不含|不包括|只看|仅|指定|其中|按月|分月|逐月|按天|逐日|趋势|环比|同比|对比|比较|退款|成交|到账|净|实时/i.test(intent + last)) return undefined;
  if (/(?:上上周|上周|本周|这周)[一二三四五六日天1-7]|(?:昨天|前天|今天|昨日|今日).*(?:至|到).*(?:昨天|今天|今日|昨日)/.test(last)) return undefined;
  let startDate: string, endDate = today, note = "";
  const dates = [...last.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g)].map(m => `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`);
  if (dates.length >= 2) [startDate, endDate] = dates;
  else if (dates.length === 1) startDate = endDate = dates[0];
  else if (/大前天|前天|昨天|昨日|今天|今日/.test(last)) {
    const days = /大前天/.test(last) ? 3 : /前天/.test(last) ? 2 : /昨天|昨日/.test(last) ? 1 : 0;
    startDate = endDate = shift(today, -days);
  }
  else if (/上上周|上周|本周|这周/.test(last)) {
    const weekday = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7;
    const monday = shift(today, -weekday);
    const weeks = last.includes("上上周") ? 2 : last.includes("上周") ? 1 : 0;
    startDate = shift(monday, -7 * weeks);
    endDate = weeks ? shift(startDate, 6) : today;
    note = "周按北京时间、周一至周日计算；本周截至今天。";
  } else if (/最近一周|近一周|最近7天|近7天/.test(last)) startDate = shift(today, -6);
  else if (/最近\d+天|近\d+天/.test(last)) startDate = shift(today, 1 - Number(last.match(/(?:最近|近)(\d+)天/)![1]));
  else if (/本月|这个月/.test(last)) startDate = today.slice(0, 8) + "01";
  else if (/上月|上个月/.test(last)) {
    endDate = shift(today.slice(0, 8) + "01", -1);
    startDate = endDate.slice(0, 8) + "01";
  } else {
    // An unhandled explicit period must go to the general planner, never silently
    // become the default 30-day range.
    if (/今年|去年|季度|半年|年初|月初|上周[一二三四五六日天]|\d+月\d+日|最近[^，。]*(?:月|年)/.test(last)) return undefined;
    const earlierDates = [...intent.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => m[0]);
    if (earlierDates.length >= 2) [startDate, endDate] = earlierDates;
    else { startDate = shift(today, -29); note = "未指定起止日期，按最近30天（含今天）统计。"; }
  }
  const { params } = normalizeDataQuery("sales_summary", { startDate, endDate, groupBy: "brand", limit: 100 });
  const requestedMetrics = ["amount", "amountSharePercent"];
  if (/件数|数量|销量/.test(intent + last)) requestedMetrics.push("quantity", "quantitySharePercent");
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [{ tool: "sales_summary", params }];
  if (/笔数|单据数|单数|订单数/.test(intent + last)) {
    requestedMetrics.push("documentCount", "documentSharePercent");
    calls.push({ tool: "sales_brand_documents", params: { startDate, endDate, limit: 100 } });
  }
  return { calls, note, requestedMetrics, startDate, endDate };
}
