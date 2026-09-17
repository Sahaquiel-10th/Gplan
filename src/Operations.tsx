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
import "./operations.css";

type Api = <T>(url: string, options?: RequestInit) => Promise<T>;
type AdminAgent = {
  id: string;
  name: string;
  modelId: string;
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
              <h4>成员与数据范围</h4>
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
                <div className="op-grant" key={g.userId}>
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
                </div>
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [canExplain, setCanExplain] = useState(false);
  const [filter, setFilter] = useState("all");
  const generation = useRef(0);
  const accessVersion = useRef("");
  async function load(value = date) {
    const run = ++generation.current;
    accessVersion.current = "";
    setLoading(true);
    setReport(undefined);
    setAnswer("");
    setError("");
    setExplaining(false);
    try {
      const result = await api<{
        report: OperationsReport;
        accessVersion: string;
        canExplain: boolean;
      }>(
        `/api/operations/${agent.id}/report${value ? "?date=" + encodeURIComponent(value) : ""}`,
      );
      if (run === generation.current) {
        accessVersion.current = result.accessVersion;
        setCanExplain(result.canExplain);
        setReport(result.report);
        setDate(result.report.date);
      }
    } catch (e) {
      if (run === generation.current) setError((e as Error).message);
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    load(initialDate || "");
    return () => {
      generation.current++;
    };
  }, [agent.id, initialDate]);
  // Revalidate permission on focus and periodically; never retain a report after a failed check.
  useEffect(() => {
    const validate = async () => {
      if (document.visibilityState !== "visible" || !accessVersion.current)
        return;
      const run = generation.current;
      try {
        const response = await api<{ accessVersion: string }>(
          `/api/operations/${agent.id}/access`,
        );
        if (run !== generation.current) return;
        if (response.accessVersion !== accessVersion.current)
          throw new Error("授权或口径已变更，请重新查看结果");
      } catch (error) {
        if (run !== generation.current) return;
        generation.current++;
        accessVersion.current = "";
        setReport(undefined);
        setAnswer("");
        setExplaining(false);
        setLoading(false);
        setError((error as Error).message);
      }
    };
    window.addEventListener("focus", validate);
    const timer = setInterval(validate, 60000);
    return () => {
      window.removeEventListener("focus", validate);
      clearInterval(timer);
    };
  }, [agent.id]);
  async function explain(action: string) {
    const run = generation.current;
    setExplaining(true);
    setAnswer("");
    setError("");
    try {
      const result = await api<{ content: string }>(
        `/api/operations/${agent.id}/explain`,
        {
          method: "POST",
          body: JSON.stringify({ action, date: report?.date || date }),
        },
      );
      if (run === generation.current) setAnswer(result.content);
    } catch (e) {
      if (run === generation.current) {
        const message = (e as Error).message;
        setError(message);
        if (/权限|未授权|不存在|停用|未登录/.test(message))
          setReport(undefined);
      }
    } finally {
      if (run === generation.current) setExplaining(false);
    }
  }
  const rows = (report?.rows || []).filter((r) => {
    const status = String(r.status || "");
    if (filter === "pending") return /待|缺失/.test(status);
    if (filter === "spike") return /放大|上升/.test(status);
    if (filter === "risk")
      return (
        /关注|缺货/.test(status) ||
        (typeof r.profit === "number" && r.profit < 0)
      );
    return true;
  });
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
        <button
          className="secondary"
          disabled={loading}
          onClick={() => {
            setDate("");
            load("");
          }}
        >
          昨日
        </button>
        <label>
          统计截止日
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button className="primary" disabled={loading} onClick={() => load()}>
          <RefreshCw size={15} />
          {loading ? "读取中…" : "查看结果"}
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="op-empty">正在读取授权范围内的数据…</div>}
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
          {report.incomplete && (
            <div className="op-warning">
              部分数据待核实或结果不完整。请展开计算说明；当前结果不代表全部异常。
            </div>
          )}
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
              .filter(([id]) =>
                agent.operationKind === "inventory" ||
                agent.operationKind === "loss"
                  ? agent.operationKind !== "loss" || id !== "spike"
                  : id === "all" || id === "spike" || id === "pending",
              )
              .map(([id, label]) => (
                <button
                  key={id}
                  className={filter === id ? "active" : ""}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
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
                {rows.map((r, i) => (
                  <tr key={i}>
                    {report.columns.map((c) => (
                      <td
                        key={c.key}
                        className={
                          c.key === "profit" &&
                          typeof r[c.key] === "number" &&
                          Number(r[c.key]) < 0
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
                当前范围内没有符合筛选条件的记录。数据完整性请查看计算说明。
              </div>
            )}
          </div>
          <details className="op-method">
            <summary>
              计算说明 · 口径 v{report.revision} · {report.date}
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
            <small>
              本次生成：{new Date(report.generatedAt).toLocaleString("zh-CN")}
            </small>
          </details>
          <div className="op-explain">
            <h3>继续了解</h3>
            {!canExplain && (
              <p className="op-muted">尚未启用智能解读，报表可以正常查看。</p>
            )}
            <div className="op-tabs">
              {[
                ["summary", "帮我看重点"],
                ["method", "解释计算口径"],
                ["next", "接下来查什么"],
              ].map(([action, label]) => (
                <button
                  key={action}
                  disabled={explaining || loading || !canExplain}
                  onClick={() => explain(action)}
                >
                  {label}
                </button>
              ))}
            </div>
            {explaining && <p>正在解释当前授权报表…</p>}
            {answer && (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {answer}
                </ReactMarkdown>
              </div>
            )}
          </div>
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
  onOpen: (id: string, date: string) => void;
}) {
  const [items, setItems] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      const r = await api<{ notifications: Notice[] }>(
        "/api/operations-notifications",
      );
      setItems(r.notifications);
      setError("");
    } catch {
      setItems([]);
      setError("通知暂不可用");
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, []);
  async function select(n: Notice) {
    try {
      await api(`/api/operations-notifications/${n.id}/read`, {
        method: "POST",
      });
      setOpen(false);
      onOpen(n.agentId, n.date);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    }
  }
  const count = items.filter((n) => !n.readAt).length;
  return (
    <div className="op-bell">
      <button
        className="nav-item"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          load();
        }}
      >
        <Bell size={16} />
        经营通知 {count > 0 && <span className="op-badge">{count}</span>}
      </button>
      {open && (
        <div className="op-notices">
          <strong>经营通知</strong>
          {error && <p role="alert">{error}</p>}
          {!items.length && !error && <p>暂无需要关注的通知</p>}
          {items.map((n) => (
            <button key={n.id} onClick={() => select(n)}>
              <strong>
                {!n.readAt ? "● " : ""}
                {n.agentName}
              </strong>
              <span>
                {n.date} ·{" "}
                {n.status === "alert" ? "发现需关注事项" : "数据有待核实"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
