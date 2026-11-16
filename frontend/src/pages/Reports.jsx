import { Activity } from "../components/Activity";
import { CostSavings } from "../components/CostSavings";
import React, { useEffect, useState } from "react";
import { number, date, listAll } from "../api/client";
import { Icon, Badge, ErrorBox, Table, Field, Empty } from "../components/ui";
const estimatedCost = row => row?.costs?.filter(c => c.estimated_cost != null).map(c => new Intl.NumberFormat(undefined, { style: 'currency', currency: c.currency, minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(Number(c.estimated_cost))).join(' + ') || '—';
const isoDay = (d) => d.toISOString().slice(0, 10);
const usageGroups = ["model", "user", "proxy_key", "upstream_key", "provider", "day", "week", "month"];
const groupResources = {
  user: "users",
  provider: "providers",
  upstream_key: "upstream-keys",
  proxy_key: "proxy-keys",
};
export function Reports({ api, mode }) {
  const [range, setRange] = useState({
      start: isoDay(new Date(Date.now() - 29 * 86400000)),
      end: isoDay(new Date()),
    }),
    [group, setGroup] = useState("model"),
    [model, setModel] = useState(""),
    [models, setModels] = useState([]),
    [modelsLoading, setModelsLoading] = useState(true),
    [modelsError, setModelsError] = useState(""),
    [status, setStatus] = useState(""),
    [groups, setGroups] = useState([]),
    [selectedGroups, setSelectedGroups] = useState([]),
    [groupsLoading, setGroupsLoading] = useState(true),
    [groupsError, setGroupsError] = useState(""),
    [users, setUsers] = useState([]),
    [selectedUsers, setSelectedUsers] = useState([]),
    [usersLoading, setUsersLoading] = useState(true),
    [usersError, setUsersError] = useState(""),
    [filters, setFilters] = useState({}),
    [report, setReport] = useState(null),
    [today, setToday] = useState({ loading: true }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [paging, setPaging] = useState(false);
  const query = () => {
    const end = new Date(`${range.end}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const { group_id = [], user_id = [], ...otherFilters } = filters;
    const params = new URLSearchParams({
      start: `${range.start}T00:00:00Z`,
      end: end.toISOString(),
      ...otherFilters,
    });
    group_id.forEach(id => params.append("group_id", id));
    user_id.forEach(id => params.append("user_id", id));
    return params;
  };
  const changeGroups = update => {
    setSelectedUsers([]);
    setUsers([]);
    setUsersLoading(true);
    setSelectedGroups(update);
  };
  useEffect(() => {
    if (mode !== "usage") return;
    let active = true;
    setGroupsLoading(true);
    setGroupsError("");
    listAll(api, "groups")
      .then(rows => active && setGroups(rows))
      .catch(error => active && setGroupsError(error.message))
      .finally(() => active && setGroupsLoading(false));
    return () => { active = false; };
  }, [api, mode, revision]);
  useEffect(() => {
    if (mode !== "usage") return;
    let active = true;
    setUsers([]);
    setUsersLoading(true);
    setUsersError("");
    listAll(api, "users", { group_id: selectedGroups })
      .then(rows => active && setUsers(rows))
      .catch(error => active && setUsersError(error.message))
      .finally(() => active && setUsersLoading(false));
    return () => { active = false; };
  }, [api, mode, revision, selectedGroups]);
  useEffect(() => {
    if (mode !== "usage") return;
    let active = true;
    setModelsLoading(true);
    setModelsError("");
    api("/usage/models")
      .then(result => active && setModels(result.data))
      .catch(error => active && setModelsError(error.message))
      .finally(() => active && setModelsLoading(false));
    return () => { active = false; };
  }, [api, mode, revision]);
  useEffect(() => {
    if (mode !== "overview") return;
    let active = true;
    const start = new Date(`${isoDay(new Date())}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
    });
    setToday({ loading: true });
    Promise.all([
      api(`/dashboard?${params}`),
      api(`/usage?${params}&group_by=company`),
    ])
      .then(([stats, usage]) => active && setToday({
        loading: false,
        requests: stats.total_requests,
        tokens: usage.data[0]?.total_tokens,
        usage: usage.data[0],
      }))
      .catch(error => active && setToday({ loading: false, error: error.message }));
    return () => { active = false; };
  }, [api, mode, revision]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setReport(null);
    if (!range.start || !range.end || range.start > range.end) {
      setError("Choose a valid date range.");
      setLoading(false);
      return;
    }
    const params = query();
    Promise.all([
      api(`/dashboard?${params}`),
      api(`/usage?${params}&group_by=company`),
      api(`/usage?${params}&group_by=${group}`),
      api(`/usage?${params}&group_by=day`),
      api(`/requests?${params}`),
      groupResources[group] ? listAll(api, groupResources[group]) : [],
      api(`/usage/categories?${params}`),
    ])
      .then(([stats, total, usage, days, requests, records, categories]) => {
        if (active)
          setReport({
            stats,
            total: total.data[0],
            usage: usage.data,
            days: days.data,
            categories: categories.data,
            requests: requests.data,
            next: requests.next_before,
            names: new Map(records.map((record) => [String(record.id), record.name])),
          });
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api, mode, range, group, filters, revision]);
  const stats = report?.stats,
    total = report?.total;
  return (
    <>
      <header className="page-heading">
        <div>
          <span className="eyebrow">YOUR GATEWAY AT A GLANCE</span>
          <h1>{mode === "overview" ? "Overview" : "Usage & requests"}</h1>
          <p>
            {mode === "overview"
              ? "A clear view of your organization’s AI activity."
              : "Explore consumption and trace individual requests."}
          </p>
        </div>
        <button onClick={() => setRevision((x) => x + 1)} disabled={loading || (mode === "overview" && today.loading)}>
          <Icon name="refresh" size={16} />
          Refresh
        </button>
      </header>
      {mode === "overview" && (
        <>
          <div className="metrics today-metrics" aria-busy={today.loading}>
            {[
              ["Todays Requests", number(today.requests), "grid", "Across your gateway today (UTC)"],
              ["Todays Token reported", number(today.tokens), "chart", "Reported usage today (UTC)"],
              ["Todays estimated cost", estimatedCost(today.usage), "chart", "Fully priced usage today (UTC)"],
            ].map(([label, value, icon, note]) => (
              <section className="metric" key={label}>
                <div>{label}<Icon name={icon} size={18} /></div>
                <strong>{today.loading ? "…" : value}</strong>
                <small>{note}</small>
              </section>
            ))}
            <CostSavings usage={today.usage} loading={today.loading} title="Todays Savings" />
          </div>
          <ErrorBox error={today.error} />
        </>
      )}
      <div className="report-filters">
        <Field label="From (UTC)">
          <input
            type="date"
            required
            value={range.start}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
          />
        </Field>
        <Field label="Through (UTC)">
          <input
            type="date"
            required
            value={range.end}
            min={range.start}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
          />
        </Field>
        <span className="range-note">Activity for your selected period</span>
      </div>
      {mode === "usage" && (
        <form
          className="report-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({
              ...(model ? { model } : {}),
              ...(status ? { request_status: status } : {}),
              ...(selectedGroups.length ? { group_id: selectedGroups } : {}),
              ...(selectedUsers.length ? { user_id: selectedUsers } : {}),
            });
          }}
        >
          {[
            { resource: "groups", label: "Groups", rows: groups, selected: selectedGroups, setSelected: changeGroups, busy: groupsLoading, error: groupsError, note: "No selection includes everyone. Selected groups match any membership." },
            { resource: "users", label: "Users", rows: users, selected: selectedUsers, setSelected: setSelectedUsers, busy: usersLoading, error: usersError, note: selectedGroups.length ? "Users from any selected group. No selection includes all matching users." : "No selection includes all users." },
          ].map(({ resource, label, rows, selected, setSelected, busy, error, note }) => (
          <div className="group-filter" key={resource}>
            <span id={`${resource}-filter-label`}>{label}</span>
            <details>
              <summary aria-labelledby={`${resource}-filter-label ${resource}-filter-value`}>
                <span id={`${resource}-filter-value`}>{busy ? `Loading ${resource}…` : selected.length ? `${selected.length} selected` : `All ${resource}`}</span>
              </summary>
              <div className="group-options">
                <p>{note}</p>
                <button type="button" onClick={() => setSelected([])} disabled={!selected.length}>Clear selection</button>
                {error && <ErrorBox error={error}/>}
                {!busy && !error && !rows.length && <p>{resource === "users" && selectedGroups.length ? "No users belong to the selected groups." : `No ${resource} created yet.`}</p>}
                {rows.map(item => {
                  const id = String(item.id);
                  return <label key={id}>
                    <input type="checkbox" checked={selected.includes(id)} disabled={busy || (!selected.includes(id) && selected.length >= 500)} onChange={event => setSelected(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))}/>
                    <span title={item.email}>{item.name}</span>
                  </label>;
                })}
              </div>
            </details>
          </div>
          ))}
          <Field label="Model">
            <select
              value={model}
              disabled={modelsLoading}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{modelsLoading ? "Loading models…" : "All models"}</option>
              {models.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            <ErrorBox error={modelsError} />
          </Field>
          <Field label="Request status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {[
                "RECEIVED",
                "FORWARDED",
                "SUCCESS",
                "FAILED",
                "REJECTED",
                "CANCELLED",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <button>Apply filters</button>
        </form>
      )}
      <ErrorBox error={error} />
      {loading ? (
        <div className="panel empty" role="status">
          Loading gateway activity…
        </div>
      ) : (
        report && (
          <>
            <div className="metrics">
              {[
                [
                  "Total requests",
                  number(stats.total_requests),
                  "Across your gateway",
                  "grid",
                ],
                [
                  "Tokens reported",
                  number(total?.total_tokens),
                  "From usage events",
                  "chart",
                ],
                [
                  "Estimated cost",
                  estimatedCost(total),
                  `${number(total?.priced_events ?? 0)} / ${number(total?.usage_events ?? 0)} events fully priced`,
                  "chart",
                ],
                [
                  "Success rate",
                  Number(stats.total_requests)
                    ? `${((Number(stats.successful_requests || 0) / Number(stats.total_requests)) * 100).toFixed(1)}%`
                    : "—",
                  "Successful / all requests",
                  "shield",
                ],
                ...(mode === "overview" ? [] : [[
                  "Average latency",
                  stats.average_duration_ms == null
                    ? "—"
                    : `${number(stats.average_duration_ms)} ms`,
                  "Across tracked requests",
                  "server",
                ]]),
              ].map(([label, value, note, icon]) => (
                <React.Fragment key={label}>
                  <section className="metric">
                    <div>
                      {label}
                      <Icon name={icon} size={18} />
                    </div>
                    <strong>{value}</strong>
                    <small>{note}</small>
                  </section>
                  {label === "Estimated cost" && <CostSavings usage={total} />}
                </React.Fragment>
              ))}
            </div>
            <div className="overview-grid">
              <section className="panel">
                <div className="panel-toolbar">
                  <div>
                    <h2>Token activity</h2>
                    <p>Daily reported consumption</p>
                  </div>
                  <span className="legend">
                    <i /> Total tokens
                  </span>
                </div>
                <Activity days={report.days} />
              </section>
              <section className="panel breakdown">
                <h2>Request outcomes</h2>
                <p>Every request, accounted for.</p>
                {[
                  ["SUCCESS", "successful_requests"],
                  ["FAILED", "failed_requests"],
                  ["REJECTED", "rejected_requests"],
                  ["CANCELLED", "cancelled_requests"],
                ].map(([label, key]) => (
                  <div className="outcome" key={key}>
                    <Badge value={label} />
                    <strong>{number(stats[key] ?? 0)}</strong>
                  </div>
                ))}
                <div className="outcome">
                  <span className="muted">In progress / other</span>
                  <strong>
                    {number(
                      Number(stats.total_requests) -
                        [
                          "successful_requests",
                          "failed_requests",
                          "rejected_requests",
                          "cancelled_requests",
                        ].reduce((sum, k) => sum + Number(stats[k] || 0), 0),
                    )}
                  </strong>
                </div>
              </section>
            </div>
            <section className="panel">
              <div className="panel-toolbar">
                <div>
                  <h2>Category breakdown</h2>
                  <p>Usage events by category for the selected period. Complexity percentages are within each category.</p>
                </div>
              </div>
              <CategoryBreakdown rows={report.categories} />
            </section>
            <section className="panel">
              <div className="panel-toolbar">
                <div>
                  <h2>Usage breakdown</h2>
                  <p>
                    Unavailable token counts appear as —. Up to 1,000 groups.
                  </p>
                </div>
                <select
                  aria-label="Group usage by"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  {usageGroups.map((g) => (
                    <option key={g} value={g}>
                      By {g.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
              <Table
                rows={report.usage}
                columns={[
                  [
                    group.replace("_", " "),
                    (r) => (
                      <strong title={groupResources[group] && r.bucket != null ? `ID: ${r.bucket}` : undefined}>
                        {r.bucket == null
                          ? "Unknown"
                          : groupResources[group]
                            ? report.names.get(String(r.bucket)) || `#${r.bucket}`
                            : r.bucket}
                      </strong>
                    ),
                  ],
                  ["Events", (r) => number(r.usage_events)],
                  ["Input tokens", (r) => number(r.input_tokens)],
                  ["Cached input", (r) => number(r.cached_input_tokens)],
                  ["Cache write", (r) => number(r.cache_write_input_tokens)],
                  ["Estimated cost", estimatedCost],
                  ["Fully priced", r => `${number(r.priced_events)} / ${number(r.usage_events)}`],
                  ["Partial / unpriced / unsupported", r => `${number(r.partial_events)} / ${number(r.unpriced_events)} / ${number(r.unsupported_events)}`],
                  ["Output tokens", (r) => number(r.output_tokens)],
                  ["Reasoning", (r) => number(r.reasoning_tokens)],
                  [
                    "Total tokens",
                    (r) => <strong>{number(r.total_tokens)}</strong>,
                  ],
                ]}
                empty={{
                  title: "No usage reported",
                  detail:
                    "Token usage will appear after your provider reports it.",
                }}
              />
            </section>
            {mode === "usage" && <section className="panel">
              <div className="panel-toolbar">
                <div>
                  <h2>Recent requests</h2>
                  <p>
                    Request metadata only. Prompts and responses are not stored.
                  </p>
                </div>
                <span className="count">{report.requests.length}</span>
              </div>
              <Table
                rows={report.requests}
                columns={[
                  ["User Name", (r) => r.user_name ?? "—"],
                  [
                    "Request",
                    (r) => (
                      <div className="request-id" title={r.request_id}>
                        {r.request_id}
                        <small>
                          {r.http_method} {r.endpoint}
                        </small>
                      </div>
                    ),
                  ],
                  [
                    "Model",
                    (r) => r.model ?? r.model_resolved ?? r.model_requested ?? "—",
                  ],
                  ["Requested model", (r) => r.requestedModel ?? r.model ?? r.model_resolved ?? r.model_requested ?? "—"],
                  ["Category", (r) => r.category ?? "—"],
                  ["Complexity", (r) => r.complexity == null ? "—" : ["0 — Easy", "1 — Medium", "2 — Hard"][r.complexity]],
                  ["Sensitive data", (r) => r.sensitive_data == null ? "—" : r.sensitive_data ? "Yes" : "No"],
                  ["Status", (r) => <Badge value={r.request_status} />],
                  ["HTTP", (r) => r.http_status ?? "—"],
                  [
                    "Latency",
                    (r) =>
                      r.duration_ms == null
                        ? "—"
                        : `${number(r.duration_ms)} ms`,
                  ],
                  [
                    "Started",
                    (r) => <span className="muted">{date(r.started_at)}</span>,
                  ],
                ]}
                empty={{
                  title: "Ready for your first request",
                  detail:
                    "Create a user, connect a provider, and configure a proxy key to get started.",
                }}
              />
              {report.next && (
                  <div className="form-actions">
                    <button
                      disabled={paging}
                      onClick={async () => {
                        setPaging(true);
                        try {
                          const page = await api(
                            `/requests?${query()}&before=${report.next}`,
                          );
                          setReport((r) => ({
                            ...r,
                            requests: [...r.requests, ...page.data],
                            next: page.next_before,
                          }));
                        } catch (e) {
                          setError(e.message);
                        } finally {
                          setPaging(false);
                        }
                      }}
                    >
                      {paging ? "Loading…" : "Load older requests"}
                    </button>
                  </div>
              )}
            </section>}
            <p className="report-note">
              Costs are estimates from reported token usage and historical rates. Totals include fully priced events only; partial, unpriced, and unsupported events are excluded. Older usage remains unpriced. Currencies are shown separately.
            </p>
          </>
        )
      )}
    </>
  );
}
function CategoryBreakdown({ rows }) {
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const total = rows.reduce((sum, row) => sum + Number(row.usage_events), 0);
  if (!total) return <Empty title="No category activity" detail="Category counts will appear when usage events are recorded in this period." />;
  let offset = 0;
  const slices = rows.map((row, index) => {
    const count = Number(row.usage_events);
    const start = offset;
    offset += count / total * 100;
    return {
      label: row.bucket ?? "unknown",
      count,
      percent: count / total * 100,
      complexity: [
        ["Easy", row.easy_events],
        ["Medium", row.medium_events],
        ["Hard", row.hard_events],
        ["Unknown", row.unknown_complexity_events],
      ].filter(([label, events]) => label !== "Unknown" || Number(events) > 0)
        .map(([label, events]) => ({ label, percent: Number(events) / count * 100 })),
      color: `hsl(${(100 + index * 137.508) % 360} 48% 62%)`,
      start,
      end: offset,
    };
  });
  const hovered = slices[hoveredSlice];
  const showSegment = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    if (Math.hypot(x, y) > 0.5) {
      setHoveredSlice(null);
      return;
    }
    // Conic gradients start at twelve o'clock and advance clockwise.
    const percent = ((Math.atan2(x, -y) / (2 * Math.PI) + 1) % 1) * 100;
    setHoveredSlice(slices.findIndex(slice => percent >= slice.start && percent < slice.end));
  };
  return (
    <div className="category-breakdown">
      <div className="category-pie" onPointerMove={showSegment} onPointerLeave={() => setHoveredSlice(null)}>
        <div className="category-pie-chart" role="img" aria-label={`Category breakdown of ${number(total)} usage events. Counts and percentages are listed alongside the chart.`}
          style={{ background: `conic-gradient(${slices.map(slice => `${slice.color} ${slice.start}% ${slice.end}%`).join(", ")})` }} />
        {hovered && (
          <div className="category-tooltip" role="tooltip">
            <strong>{hovered.label}</strong>
            <span>{hovered.percent.toFixed(1)}%</span>
            <div className="category-tooltip-complexity">
              <ComplexityBreakdown items={hovered.complexity} />
            </div>
          </div>
        )}
      </div>
      <ul className="category-legend" aria-label="Category counts and percentages">
        {slices.map((slice, index) => (
          <li key={index}>
            <i style={{ background: slice.color }} aria-hidden="true" />
            <span>{slice.label}</span>
            <strong>{number(slice.count)}</strong>
            <small>{slice.percent.toFixed(1)}%</small>
            <div className="category-complexity">
              <ComplexityBreakdown items={slice.complexity} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
function ComplexityBreakdown({ items }) {
  return items.map(item => <span key={item.label}>{item.label} {item.percent.toFixed(1)}%</span>);
}
