import type { Message } from "./types.js";
import { normalizeDataQuery, shanghaiDate } from "./enterpriseDataQueries.js";

const shift = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);

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
  let startDate: string, endDate = today, note = "";
  const dates = [...last.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => m[0]);
  if (dates.length >= 2) [startDate, endDate] = dates;
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
    const earlierDates = [...intent.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => m[0]);
    if (earlierDates.length >= 2) [startDate, endDate] = earlierDates;
    else { startDate = shift(today, -29); note = "未指定起止日期，按最近30天（含今天）统计。"; }
  }
  const { params } = normalizeDataQuery("sales_summary", { startDate, endDate, groupBy: "brand", limit: 100 });
  return { calls: [{ tool: "sales_summary", params }], note };
}
