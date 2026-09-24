import React, { useEffect, useRef, useState } from "react";
import { Menu, RefreshCw, Save, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  defaultDashboardView,
  dashboardWidgets,
  dashboardColumns,
  type DashboardView,
  type DashboardPreset,
} from "../server/dashboardPreferences";
import type { OperationsReport } from "../server/operationsData";
import type { ManagementDashboardFacts } from "../server/dataPlatformDb";
import type {
  ManagementBriefDefinition,
  ManagementBriefReport,
} from "../server/types";
import "./dashboard.css";
type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type Preferences = {
  defaults: DashboardView;
  presets: DashboardPreset[];
  sources: { id: string; name: string; kind: string }[];
  admin: boolean;
};
const labels: Record<string, string> = {
  brand: "品牌",
  sku: "SKU",
  name: "商品",
  quantity: "出库数量",
  amount: "出库销售额",
  cost: "商品成本",
  orders: "涉及出库单数",
  billDate: "出库日期",
  document: "出库单号",
  shop: "店铺",
  products: "SKU数",
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - 86400000));
function Selector({
  view,
  onChange,
  admin,
}: {
  view: DashboardView;
  onChange: (v: DashboardView) => void;
  admin: boolean;
}) {
  const widgets = admin
    ? dashboardWidgets
    : dashboardWidgets.filter((w) => ["overview", "raw"].includes(w.id));
  return (
    <details className="dash-config">
      <summary>调整展示维度与列</summary>
      <div className="dash-checks">
        {widgets.map((w) => (
          <label key={w.id}>
            <input
              type="checkbox"
              checked={view.widgets.includes(w.id)}
              onChange={(e) =>
                onChange({
                  ...view,
                  widgets: e.target.checked
                    ? [...view.widgets, w.id]
                    : view.widgets.filter((x) => x !== w.id),
                })
              }
            />
            {w.name}
          </label>
        ))}
      </div>
      {admin && (
        <>
          <h4>原始表显示列</h4>
          <div className="dash-checks">
            {dashboardColumns
              .filter((c) => labels[c])
              .map((c) => (
                <label key={c}>
                  <input
                    type="checkbox"
                    checked={view.columns.includes(c)}
                    onChange={(e) =>
                      onChange({
                        ...view,
                        columns: e.target.checked
                          ? [...view.columns, c]
                          : view.columns.filter((x) => x !== c),
                      })
                    }
                  />
                  {labels[c]}
                </label>
              ))}
          </div>
        </>
      )}
      {!view.widgets.length && <p className="error">请至少选择一个维度。</p>}
    </details>
  );
}
export function DashboardSettings({ api }: { api: Api }) {
  const [view, setView] = useState<DashboardView>(),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Preferences>("/api/dashboard/preferences")
      .then((r) => setView(r.defaults))
      .catch((e) => setNotice(e.message));
  }, []);
  return (
    <section className="dash-settings">
      <h3>驾驶舱默认配置</h3>
      <p>
        作为首次打开及“公司默认”方案。个人方案独立保存；成员只会显示其已获授权的数据，不继承管理员的全公司数据访问权。
      </p>
      {view && (
        <>
          <Selector view={view} onChange={setView} admin />
          <label>
            默认原始表
            <select
              value={view.table}
              onChange={(e) =>
                setView({
                  ...view,
                  table: e.target.value as DashboardView["table"],
                })
              }
            >
              <option value="products">商品销售汇总（含零销售）</option>
              <option value="brands">品牌销售汇总</option>
              <option value="lines">出库原始明细</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={busy || !view.widgets.length || !view.columns.length}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/dashboard/default", {
                  method: "PUT",
                  body: JSON.stringify({ view }),
                });
                setNotice("公司默认配置已保存，已有个人方案保持不变。");
              } catch (e) {
                setNotice((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存公司默认
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
function RawTable({
  api,
  view,
  onChange,
  date,
}: {
  api: Api;
  view: DashboardView;
  onChange: (v: DashboardView) => void;
  date: string;
}) {
  const [brands, setBrands] = useState<string[]>([]),
    [rows, setRows] = useState<Record<string, unknown>[]>([]),
    [more, setMore] = useState(false),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [query, setQuery] = useState(view.search),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  const key = JSON.stringify([
    date,
    view.table,
    view.brand,
    view.search,
    view.sort,
    view.direction,
    view.pageSize,
  ]);
  const lastKey = useRef(key);
  useEffect(() => {
    let live = true;
    api<{ brands: string[] }>("/api/dashboard/catalog")
      .then((r) => {
        if (live) setBrands(r.brands);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => setQuery(view.search), [view.search]);
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    const run = ++generation.current;
    setBusy(true);
    setRows([]);
    setError("");
    api<{ rows: Record<string, unknown>[]; hasMore: boolean; note: string }>(
      "/api/dashboard/table",
      { method: "POST", body: JSON.stringify({ date, view, page }) },
    )
      .then((r) => {
        if (run === generation.current) {
          setRows(r.rows);
          setMore(r.hasMore);
          setNote(r.note);
        }
      })
      .catch((e) => {
        if (run === generation.current) setError(e.message);
      })
      .finally(() => {
        if (run === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [key, page, reload]);
  const available =
    view.table === "brands"
      ? ["brand", "products", "quantity", "amount", "cost"]
      : view.table === "lines"
        ? [
            "billDate",
            "document",
            "shop",
            "brand",
            "sku",
            "name",
            "quantity",
            "amount",
            "cost",
          ]
        : ["brand", "sku", "name", "quantity", "amount", "cost", "orders"];
  const columns = available.filter(
    (c) =>
      view.columns.includes(c) ||
      c === "brand" ||
      (view.table === "brands" && c === "products"),
  );
  return (
    <section className="dash-panel dash-raw">
      <h3>原始明细表</h3>
      <div className="dash-tools">
        <label>
          数据表
          <select
            aria-label="原始表类型"
            value={view.table}
            onChange={(e) =>
              onChange({
                ...view,
                table: e.target.value as DashboardView["table"],
              })
            }
          >
            <option value="products">商品销售汇总（含零销售）</option>
            <option value="brands">全部品牌销售汇总</option>
            <option value="lines">出库原始明细</option>
          </select>
        </label>
        <label>
          品牌
          <select
            aria-label="品牌筛选"
            value={view.brand}
            onChange={(e) => onChange({ ...view, brand: e.target.value })}
          >
            <option value="">全部品牌</option>
            {brands.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onChange({ ...view, search: query });
          }}
        >
          <label>
            查询
            <input
              aria-label="查询原始表"
              placeholder="SKU、商品或单号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button className="secondary">查询</button>
        </form>
        <button
          className="secondary"
          onClick={() => setReload((n) => n + 1)}
          disabled={busy}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      <p className="dash-muted">
        {note || "点击表头可对全部匹配结果排序，分页不截取前20名。"} · {date} ·
        第{page}页
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="dash-table">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  aria-sort={
                    view.sort === c
                      ? view.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  {c === "products" ? (
                    labels[c]
                  ) : (
                    <button
                      onClick={() =>
                        onChange({
                          ...view,
                          sort: c,
                          direction:
                            view.sort === c && view.direction === "desc"
                              ? "asc"
                              : "desc",
                        })
                      }
                    >
                      {labels[c]}
                      {view.sort === c
                        ? view.direction === "desc"
                          ? " ↓"
                          : " ↑"
                        : ""}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>
                    {c === "brand" ? (
                      <button
                        className="dash-link"
                        onClick={() =>
                          onChange({
                            ...view,
                            table: "products",
                            brand: String(r.brand),
                            search: "",
                          })
                        }
                      >
                        {String(r[c] ?? "—")}
                      </button>
                    ) : r[c] == null ? (
                      "—"
                    ) : (
                      String(r[c])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {busy ? (
          <p className="dash-empty">正在读取原始表…</p>
        ) : (
          !rows.length && (
            <p className="dash-empty">当前日期与筛选条件没有记录。</p>
          )
        )}
      </div>
      <div className="dash-pagination">
        <label>
          每页
          <select
            aria-label="原始表每页条数"
            value={view.pageSize}
            onChange={(e) =>
              onChange({ ...view, pageSize: Number(e.target.value) })
            }
          >
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}条
              </option>
            ))}
          </select>
        </label>
        <span>
          第{page}页 · 本页{rows.length}条
        </span>
        <button
          className="secondary"
          disabled={busy || page === 1}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </button>
        <button
          className="secondary"
          disabled={busy || !more}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
function AdminPanels({
  api,
  date,
  widgets,
  reload,
}: {
  api: Api;
  date: string;
  widgets: string[];
  reload: number;
}) {
  const [data, setData] = useState<{
      facts: ManagementDashboardFacts;
      definitions: ManagementBriefDefinition[];
      reports: ManagementBriefReport[];
    }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const run = useRef(0);
  useEffect(() => {
    const id = ++run.current;
    setData(undefined);
    setError("");
    api<{
      facts: ManagementDashboardFacts;
      definitions: ManagementBriefDefinition[];
      reports: ManagementBriefReport[];
    }>(`/api/admin/management-dashboard?date=${date}`)
      .then((r) => {
        if (id === run.current) setData(r);
      })
      .catch((e) => {
        if (id === run.current) setError(e.message);
      });
    return () => {
      run.current++;
    };
  }, [date, reload]);
  const show = (s: string) => widgets.includes(s);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="dash-empty">正在汇总经营指标…</p>;
  const f = data.facts;
  const tables = [
    {
      id: "shops",
      title: "店铺表现（前20）",
      cols: ["name", "source", "gmv", "orders", "units"],
      rows: f.shops,
    },
    {
      id: "products",
      title: "商品表现（前20）",
      cols: ["name", "skuCode", "gmv", "units"],
      rows: f.products,
    },
    {
      id: "inventory",
      title: "当前库存（前20）",
      cols: ["name", "skuCode", "units", "lockedUnits", "inTransitUnits"],
      rows: f.inventory,
    },
  ];
  const titles: Record<string, string> = {
    name: "名称",
    source: "平台",
    gmv: "GMV",
    orders: "出库单数",
    units: "数量",
    skuCode: "SKU",
    lockedUnits: "锁定",
    inTransitUnits: "在途",
  };
  return (
    <>
      {show("overview") && (
        <div className="dash-kpis">
          {[
            ["GMV", f.summary.gmv],
            ["实付金额", f.summary.actualPayment],
            ["出库单数", f.summary.orders],
            ["销售件数", f.summary.units],
            ["当前库存", f.summary.inventoryUnits],
            ["采购入库数量", f.summary.inboundUnits],
          ].map(([l, v]) => (
            <article key={l}>
              <small>{l}</small>
              <strong>
                {Number(v).toLocaleString("zh-CN", {
                  maximumFractionDigits: 2,
                })}
              </strong>
            </article>
          ))}
        </div>
      )}
      {show("trend") && (
        <section className="dash-panel">
          <h3>近30天销售趋势</h3>
          <div className="dash-trend">
            {f.dailyTrend.map((d) => (
              <div key={d.date} title={`${d.date}：${d.gmv}`}>
                <i
                  style={{
                    height: Math.max(
                      2,
                      (d.gmv / Math.max(1, ...f.dailyTrend.map((x) => x.gmv))) *
                        120,
                    ),
                  }}
                />
                <small>{d.date.slice(5)}</small>
              </div>
            ))}
          </div>
          <details>
            <summary>查看趋势数据</summary>
            <div className="dash-table">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>GMV</th>
                    <th>出库单数</th>
                  </tr>
                </thead>
                <tbody>
                  {f.dailyTrend.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{d.gmv}</td>
                      <td>{d.orders}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
      <div className="dash-grid">
        {tables
          .filter((t) => show(t.id))
          .map((t) => (
            <details className="dash-panel" key={t.id} open>
              <summary>{t.title}</summary>
              <div className="dash-table">
                <table>
                  <thead>
                    <tr>
                      {t.cols.map((c) => (
                        <th key={c}>{titles[c]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(t.rows as unknown as Record<string, unknown>[]).map(
                      (r, i) => (
                        <tr key={i}>
                          {t.cols.map((c) => (
                            <td key={c}>{String(r[c] ?? "—")}</td>
                          ))}
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
      </div>
      {show("briefs") && (
        <section className="dash-panel">
          <h3>AI 管理简报</h3>
          {data.definitions.map((d) => {
            const report = data.reports.find(
              (r) => r.definitionId === d.id && r.reportDate === date,
            );
            return (
              <details key={d.id}>
                <summary>
                  {d.name} · {report ? "已生成" : "未生成"}
                </summary>
                <p>{d.description}</p>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={async () => {
                    const version = run.current;
                    setBusy(d.id);
                    try {
                      const r = await api<{ report: ManagementBriefReport }>(
                        "/api/admin/management-dashboard/generate",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            reportDate: date,
                            definitionId: d.id,
                          }),
                        },
                      );
                      if (version === run.current)
                        setData((old) =>
                          old
                            ? {
                                ...old,
                                reports: [
                                  r.report,
                                  ...old.reports.filter(
                                    (x) => x.id !== r.report.id,
                                  ),
                                ],
                              }
                            : old,
                        );
                    } catch (e) {
                      if (version === run.current)
                        setError((e as Error).message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  {busy === d.id ? "生成中…" : report ? "重新生成" : "生成简报"}
                </button>
                {report && (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {report.content}
                    </ReactMarkdown>
                  </div>
                )}
              </details>
            );
          })}
        </section>
      )}
      <details className="dash-panel">
        <summary>数据同步状态</summary>
        {f.dataStatus.map((s) => (
          <p key={s.resource}>
            {s.resource} · {s.lastSuccessAt || "暂无同步"}
          </p>
        ))}
      </details>
    </>
  );
}
function ScopedPanels({
  api,
  view,
  date,
  onChange,
}: {
  api: Api;
  view: DashboardView;
  date: string;
  onChange: (v: DashboardView) => void;
}) {
  const [report, setReport] = useState<OperationsReport>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [hidden, setHidden] = useState<string[]>([]),
    [sort, setSort] = useState(""),
    [desc, setDesc] = useState(true);
  const generation = useRef(0);
  useEffect(() => {
    const run = ++generation.current;
    setReport(undefined);
    setError("");
    setPage(1);
    if (!view.sourceAgentId) return;
    setBusy(true);
    api<{ report: OperationsReport; accessVersion: string }>(
      `/api/dashboard/scoped-report?agentId=${encodeURIComponent(view.sourceAgentId)}&date=${date}`,
    )
      .then((r) => {
        if (run === generation.current) {
          setReport(r.report);
          access.current = r.accessVersion;
        }
      })
      .catch((e) => {
        if (run === generation.current) setError(e.message);
      })
      .finally(() => {
        if (run === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
      access.current = "";
    };
  }, [view.sourceAgentId, date]);
  const access = useRef("");
  useEffect(() => {
    const check = async () => {
      if (!access.current) return;
      const run = generation.current;
      try {
        const r = await api<{ accessVersion: string }>(
          `/api/operations/${view.sourceAgentId}/access`,
        );
        if (run === generation.current && r.accessVersion !== access.current)
          throw new Error("授权已变化，请重新选择数据来源");
      } catch (e) {
        if (run === generation.current) {
          generation.current++;
          setReport(undefined);
          access.current = "";
          setError((e as Error).message);
        }
      }
    };
    const t = setInterval(check, 60000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", check);
    };
  }, [view.sourceAgentId]);
  if (!view.sourceAgentId)
    return (
      <p className="dash-empty">
        请先选择已授权的经营助手。未授权时不会显示经营数据。
      </p>
    );
  const columns =
    report?.columns.filter((c) => view.columns.includes(c.key)) || [];
  const rows = (report?.rows || [])
    .filter((r) =>
      Object.values(r)
        .join(" ")
        .toLowerCase()
        .includes(view.search.toLowerCase()),
    )
    .sort((a, b) => {
      const x = a[view.sort],
        y = b[view.sort];
      const n =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""), "zh-CN");
      return view.direction === "desc" ? -n : n;
    });
  const pages = Math.max(1, Math.ceil(rows.length / view.pageSize)),
    current = Math.min(page, pages);
  return (
    <>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {busy && <p>正在读取授权快照…</p>}
      {report && (
        <>
          <p className="dash-muted">
            {report.title} · 快照 {report.generatedAt}
            。授权范围及报表行数上限沿用该助手；当前页面不会查询全公司原始表。
          </p>
          {view.widgets.includes("overview") && (
            <div className="dash-kpis">
              {report.summary.map((s) => (
                <article key={s.label}>
                  <small>{s.label}</small>
                  <strong>{s.value}</strong>
                </article>
              ))}
            </div>
          )}
          {view.widgets.includes("raw") && (
            <section className="dash-panel">
              <h3>授权数据明细</h3>
              <div className="dash-tools">
                <input
                  aria-label="查询授权数据"
                  placeholder="搜索当前快照"
                  value={view.search}
                  onChange={(e) => {
                    onChange({ ...view, search: e.target.value });
                    setPage(1);
                  }}
                />
              </div>
              <details>
                <summary>选择显示列</summary>
                <div className="dash-checks">
                  {report.columns.map((c) => (
                    <label key={c.key}>
                      <input
                        type="checkbox"
                        checked={view.columns.includes(c.key)}
                        onChange={(e) =>
                          onChange({
                            ...view,
                            columns: e.target.checked
                              ? [...view.columns, c.key]
                              : view.columns.filter((k) => k !== c.key),
                          })
                        }
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </details>
              <div className="dash-table">
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c.key}>
                          <button
                            onClick={() =>
                              onChange({
                                ...view,
                                sort: c.key,
                                direction:
                                  view.sort === c.key &&
                                  view.direction === "desc"
                                    ? "asc"
                                    : "desc",
                              })
                            }
                          >
                            {c.label}
                            {view.sort === c.key
                              ? view.direction === "desc"
                                ? " ↓"
                                : " ↑"
                              : ""}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows
                      .slice(
                        (current - 1) * view.pageSize,
                        current * view.pageSize,
                      )
                      .map((r, i) => (
                        <tr key={i}>
                          {columns.map((c) => (
                            <td key={c.key}>{r[c.key] ?? "—"}</td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!rows.length && (
                  <p className="dash-empty">当前快照或筛选条件没有记录。</p>
                )}
              </div>
              <div className="dash-pagination">
                <span>
                  {rows.length}条 · {current}/{pages}页
                </span>
                <button
                  className="secondary"
                  disabled={current <= 1}
                  onClick={() => setPage(current - 1)}
                >
                  上一页
                </button>
                <button
                  className="secondary"
                  disabled={current >= pages}
                  onClick={() => setPage(current + 1)}
                >
                  下一页
                </button>
              </div>
            </section>
          )}
          <details className="dash-panel">
            <summary>
              计算口径与限制{report.incomplete ? " · 数据待核实" : ""}
            </summary>
            <p>{report.methodology.formula}</p>
            {report.methodology.notes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </details>
        </>
      )}
    </>
  );
}
export function DashboardWorkspace({
  api,
  onOpenSidebar,
}: {
  api: Api;
  onOpenSidebar: () => void;
}) {
  const [prefs, setPrefs] = useState<Preferences>(),
    [view, setView] = useState<DashboardView>(defaultDashboardView),
    [date, setDate] = useState(today),
    [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false),
    [reload, setReload] = useState(0);
  function adapt(v: DashboardView, admin: boolean) {
    return admin
      ? v
      : {
          ...v,
          widgets: v.widgets.some((w) => ["overview", "raw"].includes(w))
            ? v.widgets.filter((w) => ["overview", "raw"].includes(w))
            : ["overview", "raw"],
        };
  }
  useEffect(() => {
    let live = true;
    api<Preferences>("/api/dashboard/preferences")
      .then((r) => {
        if (!live) return;
        setPrefs(r);
        setView(adapt(r.defaults, r.admin));
      })
      .catch((e) => {
        if (live) setNotice(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function save(overwrite = false) {
    if (!prefs) return;
    setSaving(true);
    setNotice("");
    try {
      const r = await api<{ preset: DashboardPreset }>(
        "/api/dashboard/presets",
        {
          method: "POST",
          body: JSON.stringify({
            id: overwrite ? selected : undefined,
            name,
            view,
          }),
        },
      );
      setPrefs({
        ...prefs,
        presets: [
          ...prefs.presets.filter((p) => p.id !== r.preset.id),
          r.preset,
        ],
      });
      setSelected(r.preset.id);
      setNotice("方案已保存，下次可一键切换。");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="dash-workspace">
      <header className="dash-header">
        <button
          className="mobile-menu"
          aria-label="打开导航"
          onClick={onOpenSidebar}
        >
          <Menu size={20} />
        </button>
        <div>
          <h2>经营驾驶舱</h2>
          <p>选择适合自己的维度，保存为常用方案。</p>
        </div>
        <label>
          经营日期
          <input
            type="date"
            max={today()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button className="secondary" onClick={() => setReload((x) => x + 1)}>
          <RefreshCw size={15} />
          刷新
        </button>
      </header>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {prefs ? (
        <>
          <section className="dash-panel">
            <div className="dash-presets">
              <button
                className={!selected ? "active" : ""}
                onClick={() => {
                  setView(adapt(prefs.defaults, prefs.admin));
                  setSelected("");
                  setName("");
                }}
              >
                公司默认
              </button>
              {prefs.presets.map((p) => (
                <button
                  key={p.id}
                  className={selected === p.id ? "active" : ""}
                  onClick={() => {
                    setView(adapt(p.view, prefs.admin));
                    setSelected(p.id);
                    setName(p.name);
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {!prefs.admin && (
              <label>
                数据来源（仅已授权助手）
                <select
                  aria-label="驾驶舱数据来源"
                  value={view.sourceAgentId}
                  onChange={(e) =>
                    setView({
                      ...view,
                      sourceAgentId: e.target.value,
                      columns: dashboardColumns,
                    })
                  }
                >
                  <option value="">请选择已授权助手</option>
                  {prefs.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!prefs.admin && !prefs.sources.length && (
              <p>
                尚未获得经营数据授权，请管理员先分配经营助手及店铺、品牌、仓库范围。
              </p>
            )}
            <Selector view={view} onChange={setView} admin={prefs.admin} />
            <div className="dash-tools">
              <input
                aria-label="方案名称"
                maxLength={40}
                placeholder="例如：每日品牌排行"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                className="secondary"
                disabled={saving || !name.trim() || !view.widgets.length}
                onClick={() => save(false)}
              >
                <Save size={14} />
                另存为新方案
              </button>
              <button
                className="secondary"
                disabled={
                  saving || !selected || !name.trim() || !view.widgets.length
                }
                onClick={() => save(true)}
              >
                更新当前方案
              </button>
              {selected && (
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await api("/api/dashboard/presets/" + selected, {
                        method: "DELETE",
                      });
                      setPrefs({
                        ...prefs,
                        presets: prefs.presets.filter((p) => p.id !== selected),
                      });
                      setSelected("");
                      setName("");
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  删除方案
                </button>
              )}
              {prefs.admin && (
                <button
                  className="secondary"
                  disabled={saving || !view.widgets.length}
                  onClick={async () => {
                    try {
                      await api("/api/dashboard/default", {
                        method: "PUT",
                        body: JSON.stringify({ view }),
                      });
                      setPrefs({
                        ...prefs,
                        defaults: {
                          ...view,
                          brand: "",
                          search: "",
                          sourceAgentId: "",
                        },
                      });
                      setNotice("已设为公司默认布局；个人方案不受影响。");
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                >
                  设为公司默认
                </button>
              )}
            </div>
            <small className="dash-muted">
              方案保存维度、列、排序和筛选，不保存固定日期；切换后沿用当前经营日期。最多20套，修改后请更新或另存。
            </small>
          </section>
          {prefs.admin ? (
            <>
              {view.widgets.includes("raw") && (
                <RawTable
                  key={reload}
                  api={api}
                  view={view}
                  onChange={setView}
                  date={date}
                />
              )}{" "}
              {view.widgets.some((w) => w !== "raw") && (
                <AdminPanels
                  api={api}
                  date={date}
                  widgets={view.widgets}
                  reload={reload}
                />
              )}
            </>
          ) : (
            <ScopedPanels
              key={reload}
              api={api}
              view={view}
              date={date}
              onChange={setView}
            />
          )}
        </>
      ) : (
        <p>正在读取驾驶舱配置…</p>
      )}
    </section>
  );
}
