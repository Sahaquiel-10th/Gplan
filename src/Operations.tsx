import React, { useEffect, useRef, useState } from "react";
import { Bell, ChevronLeft, RefreshCw, Shield, Menu } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  OperationsConfig,
  OperationsGrant,
  OperationsKind,
} from "../server/operationsPolicy";
import type {
  OperationsReport,
  OperationsCatalog,
} from "../server/operationsData";
import type { OperationsAnalysis } from "../server/operationsArchive";
import "./operations.css";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type AdminAgent = {
  id: string;
  name: string;
  modelId: string;
  prompt: string;
  operations: OperationsConfig;
};
type AdminData = {
  agents: AdminAgent[];
  users: Array<{ id: string; name: string }>;
  models: Array<{ id: string; name: string }>;
  catalog?: OperationsCatalog;
  catalogError: string;
};
function Choices({
  title,
  options,
  values,
  onChange,
}: {
  title: string;
  options: Array<{ id: string; name: string }>;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = options.filter((o) =>
    `${o.name} ${o.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <fieldset className="op-choices">
      <legend>
        {title} · 已选 {values.length}
      </legend>
      <input
        aria-label={`搜索${title}`}
        placeholder={`搜索${title}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="op-choice-actions">
        <button
          type="button"
          onClick={() => onChange(options.map((o) => o.id))}
        >
          全选
        </button>
        <button
          type="button"
          onClick={() =>
            onChange([...new Set([...values, ...filtered.map((o) => o.id)])])
          }
        >
          选择搜索结果
        </button>
        <button type="button" onClick={() => onChange([])}>
          清空
        </button>
      </div>
      <div className="op-choice-list">
        {filtered.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              checked={values.includes(o.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...values, o.id]
                    : values.filter((v) => v !== o.id),
                )
              }
            />
            <span>
              {o.name}
              <small>{o.name !== o.id ? o.id : ""}</small>
            </span>
          </label>
        ))}
        {!filtered.length && <small>暂无可选项</small>}
      </div>
    </fieldset>
  );
}
export function OperationsAdmin({
  api,
  onChanged,
}: {
  api: Api;
  onChanged: () => Promise<void>;
}) {
  const [data, setData] = useState<AdminData>();
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<AdminAgent>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [billTypes, setBillTypes] = useState("");
  useEffect(() => {
    setBillTypes(draft?.operations.rules.excludedBillTypes.join(",") || "");
  }, [draft?.id, draft?.operations.revision]);
  async function load() {
    const value = await api<AdminData>("/api/admin/operations");
    setData(value);
    const id = selected || value.agents[0]?.id || "";
    setSelected(id);
    setDraft(value.agents.find((a) => a.id === id));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  function update(operations: OperationsConfig) {
    if (draft) setDraft({ ...draft, operations });
  }
  function grantChange(index: number, grant: OperationsGrant) {
    if (draft)
      update({
        ...draft.operations,
        grants: draft.operations.grants.map((g, i) =>
          i === index ? grant : g,
        ),
      });
  }
  async function install() {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/operations/install", { method: "POST" });
      await load();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/admin/operations/${draft.id}`, {
        method: "PUT",
        body: JSON.stringify({
          operations: {
            ...draft.operations,
            rules: {
              ...draft.operations.rules,
              excludedBillTypes: billTypes.trim()
                ? billTypes.split(/[,，]/).map((v) => Number(v.trim()))
                : [],
            },
          },
          revision: draft.operations.revision,
          modelId: draft.modelId,
          prompt: draft.prompt,
        }),
      });
      await load();
      await onChanged();
      setNotice(
        draft.operations.state === "disabled"
          ? "已立即停用，其他配置保持原值。"
          : "配置已保存，权限即时生效。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="op-admin">
      <div className="op-heading">
        <div>
          <h3>经营助手 · 内测管理</h3>
          <p>
            选择使用成员，并分别授权店铺、品牌和仓库。未分配范围的成员无法使用。
          </p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => load().catch((e) => setError(e.message))}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      {data?.catalogError && <div className="notice">{data.catalogError}</div>}
      {!data ? (
        <p>正在读取配置…</p>
      ) : !data.agents.length ? (
        <div className="op-empty">
          <Shield size={32} />
          <h3>准备第一期经营助手</h3>
          <p>
            创建亏损、库存、商品诊断三个入口。初始为草稿，只有配置成员和数据范围后才开放。
          </p>
          <button className="primary" disabled={busy} onClick={install}>
            创建一期助手
          </button>
        </div>
      ) : (
        <>
          <div className="op-tabs">
            {data.agents.map((a) => (
              <button
                className={selected === a.id ? "active" : ""}
                key={a.id}
                onClick={() => {
                  setSelected(a.id);
                  setDraft(a);
                  setError("");
                  setNotice("");
                }}
              >
                {a.name}
              </button>
            ))}
          </div>
          {draft && (
            <div key={draft.id} className="op-config">
              <div className="op-config-top">
                <label>
                  开放状态
                  <select
                    value={draft.operations.state}
                    onChange={(e) =>
                      update({
                        ...draft.operations,
                        state: e.target.value as OperationsConfig["state"],
                      })
                    }
                  >
                    <option value="draft">草稿</option>
                    <option value="pilot">指定成员内测</option>
                    <option value="active">正式开放（仍仅限授权成员）</option>
                    <option value="disabled">停用</option>
                  </select>
                </label>
                <label>
                  解释模型
                  <select
                    value={draft.modelId}
                    onChange={(e) =>
                      setDraft({ ...draft, modelId: e.target.value })
                    }
                  >
                    <option value="">仅结构化报表</option>
                    {data.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span>口径版本 v{draft.operations.revision}</span>
              </div>
              <div className="op-policy">
                <strong>隔离策略</strong>
                <p>
                  只读 RDS
                  授权范围；不接入通用知识库、个人记忆、联网搜索或公开分享。亏损助手的成本、利润随该助手授权开放。
                </p>
              </div>
              <details className="op-method">
                <summary>分析提示词 · 可修改</summary>
                <p className="op-muted">
                  控制表达方式和分析重点，不能改变数据权限。保存后旧版本的分析将失效。
                </p>
                <textarea
                  aria-label="分析提示词"
                  rows={6}
                  maxLength={6000}
                  value={draft.prompt}
                  onChange={(e) =>
                    setDraft({ ...draft, prompt: e.target.value })
                  }
                />
              </details>
              <h4>成员与数据范围 · {draft.operations.grants.length} 人</h4>
              <div className="op-choice-actions">
                <button
                  disabled={!data.catalog}
                  onClick={() =>
                    update({
                      ...draft.operations,
                      grants: data.users.map(
                        (u) =>
                          draft.operations.grants.find(
                            (g) => g.userId === u.id,
                          ) || {
                            userId: u.id,
                            shopIds: [],
                            brands: [],
                            warehouseIds: [],
                          },
                      ),
                    })
                  }
                >
                  添加全部成员
                </button>
                <span className="op-muted">
                  全选成员后仍需逐人配置数据范围；店铺和品牌全选仅包含当前选项。
                </span>
              </div>
              <select
                aria-label="添加内测成员"
                value=""
                disabled={!data.catalog}
                onChange={(e) => {
                  if (e.target.value)
                    update({
                      ...draft.operations,
                      grants: [
                        ...draft.operations.grants,
                        {
                          userId: e.target.value,
                          shopIds: [],
                          brands: [],
                          warehouseIds: [],
                        },
                      ],
                    });
                }}
              >
                <option value="">＋ 选择成员加入</option>
                {data.users
                  .filter(
                    (u) =>
                      !draft.operations.grants.some((g) => g.userId === u.id),
                  )
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
              {draft.operations.grants.map((g, index) => (
                <details
                  className="op-grant"
                  key={g.userId}
                  open={!g.shopIds.length || !g.brands.length}
                >
                  <summary>
                    {data.users.find((u) => u.id === g.userId)?.name ||
                      "成员已停用"}
                    <span className="op-muted">
                      {" "}
                      · {g.shopIds.length} 店铺 / {g.brands.length} 品牌 /{" "}
                      {g.warehouseIds.length} 仓库
                    </span>
                  </summary>
                  <div className="op-heading">
                    <strong>
                      {data.users.find((u) => u.id === g.userId)?.name ||
                        "成员已停用"}
                    </strong>
                    <button
                      className="secondary"
                      onClick={() =>
                        update({
                          ...draft.operations,
                          grants: draft.operations.grants.filter(
                            (x) => x.userId !== g.userId,
                          ),
                        })
                      }
                    >
                      移除授权
                    </button>
                  </div>
                  <div className="op-grids">
                    <Choices
                      title="店铺（必选）"
                      options={data.catalog?.shops || []}
                      values={g.shopIds}
                      onChange={(shopIds) =>
                        grantChange(index, { ...g, shopIds })
                      }
                    />
                    <Choices
                      title="品牌（必选）"
                      options={(data.catalog?.brands || []).map((b) => ({
                        id: b,
                        name: b,
                      }))}
                      values={g.brands}
                      onChange={(brands) =>
                        grantChange(index, { ...g, brands })
                      }
                    />
                    <Choices
                      title={
                        draft.operations.kind === "inventory"
                          ? "仓库（必选）"
                          : "仓库（可选，不选不限制）"
                      }
                      options={data.catalog?.warehouses || []}
                      values={g.warehouseIds}
                      onChange={(warehouseIds) =>
                        grantChange(index, { ...g, warehouseIds })
                      }
                    />
                  </div>
                </details>
              ))}
              {!draft.operations.grants.length && (
                <p className="op-muted">尚未授权任何成员，包括管理员自己。</p>
              )}
              <details className="op-method">
                <summary>计算口径设置</summary>
                {draft.operations.kind === "loss" ? (
                  <>
                    <p>
                      实收减商品成本；以下费用按所选字段扣除。默认只纳入物流费用。缺失必需字段进入待核算。
                    </p>
                    {(
                      [
                        "includeDeliveryCost",
                        "includeServiceFee",
                        "includeStorageFee",
                        "assumeMissingCurrencyCny",
                      ] as const
                    ).map((key, i) => (
                      <label className="op-check" key={key}>
                        <input
                          type="checkbox"
                          checked={draft.operations.rules[key]}
                          onChange={(e) =>
                            update({
                              ...draft.operations,
                              rules: {
                                ...draft.operations.rules,
                                [key]: e.target.checked,
                              },
                            })
                          }
                        />
                        {
                          [
                            "物流费用 delivery_cost",
                            "服务费 service_fee",
                            "仓储费 storage_fee",
                            "币种缺失时按人民币暂估",
                          ][i]
                        }
                      </label>
                    ))}
                    <label>
                      已核实需要排除的单据类型编码
                      <input
                        value={billTypes}
                        placeholder="例如 1,2；未核实请留空"
                        onChange={(e) => setBillTypes(e.target.value)}
                      />
                    </label>
                    <p>备注包含补发、漏发、换货时仅标记待确认，不自动排除。</p>
                  </>
                ) : (
                  <div className="op-config-top">
                    {(
                      [
                        { key: "dangerDays", label: "库存关注线（天）" },
                        { key: "targetDays", label: "库存目标（天）" },
                        { key: "spikeRatio", label: "销量放大倍数" },
                      ] as const
                    ).map(({ key, label }) => (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          step={key === "spikeRatio" ? 0.1 : 1}
                          value={draft.operations.rules[key]}
                          onChange={(e) =>
                            update({
                              ...draft.operations,
                              rules: {
                                ...draft.operations.rules,
                                [key]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}
              </details>
              <div className="op-save">
                <button className="primary" disabled={busy} onClick={save}>
                  {busy ? "保存中…" : "保存配置与授权"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const shortcuts = [
  ["summary", "帮我看重点"],
  ["method", "解释计算口径"],
  ["next", "接下来查什么"],
];
const analysisLabel = (a: OperationsAnalysis) =>
  a.question || shortcuts.find(([id]) => id === a.action)?.[1] || "经营分析";
export function OperationsWorkspace({
  api,
  agent,
  onBack,
  onOpenSidebar,
  initialDate,
}: {
  api: Api;
  agent: { id: string; name: string; operationKind?: OperationsKind };
  onBack: () => void;
  onOpenSidebar: () => void;
  initialDate?: string;
}) {
  const [date, setDate] = useState(initialDate || "");
  const [report, setReport] = useState<OperationsReport>();
  const [snapshotId, setSnapshotId] = useState("");
  const [analyses, setAnalyses] = useState<OperationsAnalysis[]>([]);
  const [activeId, setActiveId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [canExplain, setCanExplain] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const generation = useRef(0);
  const accessVersion = useRef("");
  const explainingRef = useRef(false);
  const active = analyses.find((a) => a.id === activeId);
  function clear() {
    setReport(undefined);
    setAnalyses([]);
    setActiveId("");
    setSnapshotId("");
    setQuestion("");
  }
  async function load(value = date, refresh = false) {
    const run = ++generation.current;
    accessVersion.current = "";
    setLoading(true);
    clear();
    setError("");
    setExplaining(false);
    explainingRef.current = false;
    setFilter("all");
    setSearch("");
    setPage(1);
    setExpanded(false);
    try {
      if (refresh)
        await api(`/api/operations/${agent.id}/refresh`, {
          method: "POST",
          body: JSON.stringify({ date: value }),
        });
      const result = await api<{
        report: OperationsReport;
        snapshotId: string;
        analyses: OperationsAnalysis[];
        accessVersion: string;
        canExplain: boolean;
      }>(
        `/api/operations/${agent.id}/report${value ? "?date=" + encodeURIComponent(value) : ""}`,
      );
      if (run !== generation.current) return;
      accessVersion.current = result.accessVersion;
      setCanExplain(result.canExplain);
      setReport(result.report);
      setDate(result.report.date);
      setSnapshotId(result.snapshotId);
      setAnalyses(result.analyses);
      setActiveId(result.analyses.at(-1)?.id || "");
    } catch (e) {
      if (run === generation.current) setError((e as Error).message);
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load(initialDate || "");
    return () => {
      generation.current++;
    };
  }, [agent.id, initialDate]);
  useEffect(() => {
    const validate = async () => {
      if (document.visibilityState !== "visible" || !accessVersion.current)
        return;
      const run = generation.current;
      try {
        const r = await api<{ accessVersion: string }>(
          `/api/operations/${agent.id}/access`,
        );
        if (run !== generation.current) return;
        if (r.accessVersion !== accessVersion.current)
          throw new Error("授权或配置已变更，请重新查看结果");
      } catch (e) {
        if (run !== generation.current) return;
        generation.current++;
        accessVersion.current = "";
        clear();
        setExplaining(false);
        explainingRef.current = false;
        setLoading(false);
        setError((e as Error).message);
      }
    };
    window.addEventListener("focus", validate);
    const timer = setInterval(validate, 60000);
    return () => {
      window.removeEventListener("focus", validate);
      clearInterval(timer);
    };
  }, [agent.id]);
  async function explain(action: string, text = "", regenerate = false) {
    if (explainingRef.current || !report) return;
    const run = generation.current;
    explainingRef.current = true;
    setExplaining(true);
    setError("");
    try {
      const a = await api<OperationsAnalysis>(
        `/api/operations/${agent.id}/explain`,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            question: text,
            date: report.date,
            snapshotId,
            regenerate,
          }),
        },
      );
      if (run !== generation.current) return;
      setAnalyses((old) =>
        [
          ...old.filter(
            (x) => !(x.action === a.action && x.question === a.question),
          ),
          a,
        ].slice(-20),
      );
      setActiveId(a.id);
      setExpanded(false);
      if (action === "custom") setQuestion("");
    } catch (e) {
      if (run !== generation.current) return;
      const message = (e as Error).message;
      setError(message);
      if (/权限|授权|不存在|停用|未登录|数据已刷新/.test(message)) clear();
    } finally {
      if (run === generation.current) {
        setExplaining(false);
        explainingRef.current = false;
      }
    }
  }
  function matches(r: OperationsReport["rows"][number], kind: string) {
    const status = String(r.status || "");
    return kind === "pending"
      ? /待|缺失/.test(status)
      : kind === "spike"
        ? /放大|上升/.test(status)
        : kind === "risk"
          ? /关注|缺货/.test(status) ||
            (typeof r.profit === "number" && r.profit < 0)
          : true;
  }
  const rows = (report?.rows || []).filter(
    (r) =>
      matches(r, filter) &&
      Object.values(r)
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages);
  return (
    <section className="op-workspace">
      <header className="op-heading">
        <button
          className="mobile-menu"
          aria-label="打开导航"
          onClick={onOpenSidebar}
        >
          <Menu size={20} />
        </button>
        <button className="secondary" onClick={onBack}>
          <ChevronLeft size={16} />
          智能体
        </button>
        <div>
          <h2>{agent.name}</h2>
          <p>授权范围内的经营数据 · 只读分析</p>
        </div>
      </header>
      <div className="op-toolbar">
        <label>
          统计截止日
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button className="primary" disabled={loading} onClick={() => load()}>
          {loading ? "读取中…" : "查看结果"}
        </button>
        <button
          className="secondary"
          disabled={loading}
          onClick={() => load("")}
        >
          昨日
        </button>
        {report && (
          <button
            className="secondary"
            disabled={loading || explaining}
            onClick={() => load(report.date, true)}
          >
            <RefreshCw size={15} />
            刷新数据（清空分析）
          </button>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="op-empty">正在读取授权数据；已有快照将直接打开…</div>
      )}
      {report && (
        <>
          <div className="op-stats">
            {report.summary.map((s) => (
              <div key={s.label}>
                <small>{s.label}</small>
                <strong>{s.value}</strong>
              </div>
            ))}
          </div>
          <p className="op-muted">
            数据快照：{new Date(report.generatedAt).toLocaleString("zh-CN")} ·
            再次打开直接读取已保存结果。刷新数据会清空本日旧分析；历史日期的库存仍为抓取时快照。
          </p>
          {report.incomplete && (
            <details className="op-warning">
              <summary>数据有待核实或结果不完整 · 查看说明</summary>
              <p>当前结果不代表全部异常。请查看下方计算口径中的范围与限制。</p>
              {report.methodology.notes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </details>
          )}
          <section className="op-explain">
            <div className="op-heading">
              <div>
                <h3>经营分析 · {report.date}</h3>
                <p>
                  基于本日授权数据，最多提供前200行给模型。下方筛选不改变分析范围。
                </p>
              </div>
              {active && (
                <small className="op-muted">
                  已保存 · {new Date(active.createdAt).toLocaleString("zh-CN")}
                </small>
              )}
            </div>
            <div className="op-tabs">
              {shortcuts.map(([action, label]) => (
                <button
                  key={action}
                  disabled={explaining || !canExplain}
                  onClick={() => explain(action)}
                >
                  {label}
                  {analyses.some((a) => a.action === action) ? " ✓" : ""}
                </button>
              ))}
            </div>
            {analyses.length > 0 && (
              <label className="op-history">
                已保存的分析
                <select
                  aria-label="已保存的分析"
                  value={activeId}
                  onChange={(e) => {
                    setActiveId(e.target.value);
                    setExpanded(false);
                  }}
                >
                  {analyses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {analysisLabel(a).slice(0, 80)}
                    </option>
                  ))}
                </select>
                <small>保留近90天，每日最近20份</small>
              </label>
            )}
            {explaining && (
              <p role="status">正在分析当前授权数据，完成后自动保存…</p>
            )}
            {active ? (
              <>
                <div
                  className={`markdown-body op-answer ${expanded ? "is-expanded" : ""}`}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {active.content}
                  </ReactMarkdown>
                </div>
                <div className="op-answer-actions">
                  <button
                    className="secondary"
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? "收起分析" : "展开完整分析"}
                  </button>
                  <button
                    className="secondary"
                    disabled={explaining || !canExplain}
                    onClick={() =>
                      explain(active.action, active.question, true)
                    }
                  >
                    <RefreshCw size={14} />
                    重新生成这份分析
                  </button>
                </div>
              </>
            ) : (
              !explaining && (
                <p className="op-muted">
                  还没有分析。点击常用问题或输入问题，生成后会自动保存。
                </p>
              )
            )}
            <form
              className="op-question"
              onSubmit={(e) => {
                e.preventDefault();
                void explain("custom", question.trim());
              }}
            >
              <textarea
                aria-label="经营分析问题"
                placeholder="例如：哪些商品需要优先补货？请结合当前库存说明理由。"
                rows={2}
                maxLength={2000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={!canExplain}
              />
              <button
                className="primary"
                disabled={!canExplain || explaining || !question.trim()}
                type="submit"
              >
                分析并保存
              </button>
            </form>
            {!canExplain && (
              <p className="op-muted">
                尚未启用智能解读，请管理员配置模型。已保存分析仍可查看。
              </p>
            )}
          </section>
          <details className="op-data-section" open>
            <summary>
              数据明细{" "}
              <span className="op-muted">
                · 本次报表 {report.rows.length} 条 · 可收起
              </span>
            </summary>
            <div className="op-tabs">
              {[
                ["all", "全部结果"],
                [
                  "risk",
                  agent.operationKind === "loss" ? "预估亏损" : "库存需关注",
                ],
                ["pending", "待核实"],
                ["spike", "销量放大"],
              ]
                .filter(
                  ([id]) =>
                    agent.operationKind === "inventory" ||
                    (agent.operationKind === "loss"
                      ? id !== "spike"
                      : id !== "risk"),
                )
                .map(([id, label]) => (
                  <button
                    key={id}
                    className={filter === id ? "active" : ""}
                    onClick={() => {
                      setFilter(id);
                      setPage(1);
                    }}
                  >
                    {label}{" "}
                    <span>
                      {report.rows.filter((r) => matches(r, id)).length}
                    </span>
                  </button>
                ))}
            </div>
            <div className="op-data-tools">
              <input
                aria-label="查询数据明细"
                placeholder="搜索商品、SKU、店铺或单号"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
              <span className="op-muted">
                报表 {report.rows.length} 条 / 当前匹配 {rows.length} 条
              </span>
            </div>
            <div className="op-table">
              <table>
                <thead>
                  <tr>
                    {report.columns.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                    .map((r, i) => (
                      <tr key={i}>
                        {report.columns.map((c) => (
                          <td
                            key={c.key}
                            className={
                              c.key === "profit" && Number(r[c.key]) < 0
                                ? "op-negative"
                                : undefined
                            }
                          >
                            {r[c.key] ?? "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
              {!rows.length && (
                <div className="op-empty">
                  {report.rows.length
                    ? `本次报表有 ${report.rows.length} 条数据，当前筛选或搜索无匹配记录。`
                    : "本次授权范围和日期没有可展示的记录，请检查计算口径与同步情况。"}
                  {report.rows.length > 0 && (
                    <button
                      className="secondary"
                      onClick={() => {
                        setFilter("all");
                        setSearch("");
                        setPage(1);
                      }}
                    >
                      查看全部结果
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="op-pagination">
              <label>
                每页{" "}
                <select
                  aria-label="每页条数"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                >
                  {[10, 20, 50].map((n) => (
                    <option key={n} value={n}>
                      {n} 条
                    </option>
                  ))}
                </select>
              </label>
              <span>
                {currentPage} / {pages} 页
              </span>
              <button
                className="secondary"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <button
                className="secondary"
                disabled={currentPage >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          </details>
          <details className="op-method">
            <summary>
              计算口径与数据来源 · v{report.revision} · {report.date}
            </summary>
            <p>{report.methodology.formula}</p>
            {[
              { title: "使用数据", items: report.methodology.sources },
              { title: "计入", items: report.methodology.included },
              { title: "未计入／排除", items: report.methodology.excluded },
              { title: "适用范围与限制", items: report.methodology.notes },
            ].map((s) => (
              <div key={s.title}>
                <strong>{s.title}</strong>
                <ul>
                  {s.items.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              </div>
            ))}
            <strong>最近同步</strong>
            {report.methodology.sync.map((s) => (
              <p key={s.resource}>
                {s.resource}：{s.at}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}

type Notice = {
  id: string;
  agentId: string;
  agentName: string;
  date: string;
  readAt?: string;
  status: string;
};
export function OperationsBell({
  api,
  onOpen,
}: {
  api: Api;
  onOpen: () => void;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ notifications: Notice[] }>("/api/operations-notifications")
        .then((r) => {
          if (live) setCount(r.notifications.filter((n) => !n.readAt).length);
        })
        .catch(() => {
          if (live) setCount(0);
        });
    void load();
    const timer = setInterval(load, 60000);
    window.addEventListener("operations-notices-read", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("operations-notices-read", load);
    };
  }, []);
  return (
    <button className="nav-item" onClick={onOpen}>
      <Bell size={16} />
      经营通知 {count > 0 && <span className="op-badge">{count}</span>}
    </button>
  );
}
export function OperationsNotifications({
  api,
  onOpen,
  onBack,
  onOpenSidebar,
}: {
  api: Api;
  onOpen: (id: string, date: string) => void;
  onBack: () => void;
  onOpenSidebar: () => void;
}) {
  const [items, setItems] = useState<Notice[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const request = useRef(0);
  async function load() {
    const run = ++request.current;
    try {
      const r = await api<{ notifications: Notice[] }>(
        "/api/operations-notifications",
      );
      if (run !== request.current) return;
      setItems(r.notifications);
      setError("");
    } catch (e) {
      if (run === request.current) {
        setItems([]);
        setError((e as Error).message);
      }
    } finally {
      if (run === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(load, 60000);
    window.addEventListener("focus", load);
    return () => {
      request.current++;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);
  async function select(n: Notice) {
    try {
      await api(`/api/operations-notifications/${n.id}/read`, {
        method: "POST",
      });
      window.dispatchEvent(new Event("operations-notices-read"));
      onOpen(n.agentId, n.date);
    } catch (e) {
      setItems([]);
      setError((e as Error).message);
    }
  }
  const visible = items.filter((n) => !unread || !n.readAt),
    pages = Math.max(1, Math.ceil(visible.length / 10)),
    current = Math.min(page, pages);
  return (
    <section className="op-workspace">
      <header className="op-heading">
        <button
          className="mobile-menu"
          aria-label="打开导航"
          onClick={onOpenSidebar}
        >
          <Menu size={20} />
        </button>
        <button className="secondary" onClick={onBack}>
          <ChevronLeft size={16} />
          智能体
        </button>
        <div>
          <h2>经营通知</h2>
          <p>授权范围内的每日关注事项</p>
        </div>
      </header>
      <details className="op-method">
        <summary>通知是如何产生的？</summary>
        <p>
          每天北京时间08:00之后，系统每15分钟检查一次昨日数据。发现需关注事项或数据待核实时生成站内通知；同一成员、助手、日期和权限版本不会重复提醒。点击通知进入对应日期的报表和已保存分析。通知本身不自动生成AI分析，不发送钉钉消息。
        </p>
      </details>
      <div className="op-tabs">
        <button
          className={!unread ? "active" : ""}
          onClick={() => {
            setUnread(false);
            setPage(1);
          }}
        >
          全部 {items.length}
        </button>
        <button
          className={unread ? "active" : ""}
          onClick={() => {
            setUnread(true);
            setPage(1);
          }}
        >
          未读 {items.filter((n) => !n.readAt).length}
        </button>
        <button
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <div className="op-empty">正在读取通知…</div>
      ) : !visible.length ? (
        <div className="op-empty op-notification-empty">
          <Bell size={30} />
          <h3>{unread ? "暂无未读通知" : "暂无需要关注的通知"}</h3>
          <p>助手开放并获得数据授权后，符合条件的提醒会显示在这里。</p>
        </div>
      ) : (
        <div className="op-notice-list">
          {visible.slice((current - 1) * 10, current * 10).map((n) => (
            <button key={n.id} onClick={() => select(n)}>
              <span>
                <strong>
                  {!n.readAt && <i className="op-dot" />}
                  {n.agentName}
                </strong>
                <small>
                  {n.date} ·{" "}
                  {n.status === "alert" ? "发现需关注事项" : "数据有待核实"}
                </small>
              </span>
              <span>查看报告 →</span>
            </button>
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="op-pagination">
          <span>
            {current} / {pages} 页
          </span>
          <button
            className="secondary"
            disabled={current === 1}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </button>
          <button
            className="secondary"
            disabled={current === pages}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
