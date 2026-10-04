import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, statusLabel } from "./api.js";
import { pairNextStep, stageForGapStatus } from "./guidance.js";
import { reviewItems } from "./review.js";
import { EmptyState, ErrorMessage, Loading, useAction } from "./AppShell.js";
import type { Gap, Pair, PairHealth } from "./types.js";

type PairSnapshot = { snapshot?: PairHealth["snapshot"]; gaps: Gap[] };
const decisions = ["Port to target", "Investigate", "No port needed"];

export function PairPage() {
  const { id = "" } = useParams();
  const { data, error, isLoading } = useQuery<PairSnapshot>({
    queryKey: ["pair", id],
    queryFn: () => api(`/pairs/${id}/snapshot`),
  });
  const { data: health } = useQuery<{ pairs: PairHealth[] }>({
    queryKey: ["health"],
    queryFn: () => api("/health"),
  });
  const { data: setup } = useQuery<{ pairs: Pair[] }>({
    queryKey: ["pairs"],
    queryFn: () => api("/pairs"),
  });
  const { act, error: actionError, busy } = useAction();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("actionable");
  const pair = health?.pairs.find((p) => p.id === id);
  const pairName =
    setup?.pairs.find((p) => p.id === id)?.name || pair?.name || id;
  const items = useMemo(
    () => reviewItems(data?.gaps || [], data?.snapshot),
    [data?.gaps, data?.snapshot],
  );
  const next = pair && pairNextStep(pair);
  if (next && data?.snapshot?.aiAssessedAt) {
    const actionable = items.filter(
      (item) => item.decision !== "No port needed",
    );
    if (actionable.length && next.href === `/pairs/${id}`) {
      next.title = `${actionable.length} porting decisions need attention`;
      next.detail =
        "Open a decision to see the impact, evidence, and next action.";
      next.action = "Open first decision";
      next.href = `/pairs/${id}/gaps/${actionable[0].gaps[0].id}?stage=${stageForGapStatus(actionable[0].gaps[0].status)}`;
    }
  }
  const visible = useMemo(
    () =>
      items.filter((item) => {
        const text =
          `${item.title} ${item.impact} ${item.featureArea} ${item.gaps.map((gap) => gap.sourceSubject).join(" ")}`.toLowerCase();
        return (
          text.includes(search.toLowerCase()) &&
          (filter === "all" ||
            (filter === "actionable"
              ? item.decision !== "No port needed"
              : item.decision === filter))
        );
      }),
    [items, search, filter],
  );
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link className="back-link" to="/">
            ← Dashboard
          </Link>
          <span className="eyebrow">SYNC PAIR · {id}</span>
          <h1>{pairName}</h1>
          <p>See which source behaviors need to be adapted for the target.</p>
        </div>
        <details className="scan-menu">
          <summary className="button subtle">Run analysis</summary>
          <div className="popover-actions">
            <button
              disabled={busy || !pair?.bound}
              onClick={() =>
                act(`/pairs/${id}/analyze`, "POST", { offline: false })
              }
            >
              Fetch & analyze
            </button>
            <button
              disabled={busy || !pair?.bound}
              onClick={() =>
                act(`/pairs/${id}/analyze`, "POST", { offline: true })
              }
            >
              Offline scan using cached refs
            </button>
          </div>
        </details>
      </header>
      {isLoading && <Loading />}
      <ErrorMessage message={error ? String(error) : actionError} />
      {next &&
        !(
          data?.snapshot?.aiAssessedAt &&
          !items.some((item) => item.decision !== "No port needed") &&
          !pair?.nextGap
        ) && (
          <section className="next-card">
            <div className="next-symbol">→</div>
            <div>
              <span className="eyebrow">NEXT STEP</span>
              <h2>{next.title}</h2>
              <p>{next.detail}</p>
            </div>
            {next.href === `/pairs/${id}` && !data?.snapshot?.aiAssessedAt ? (
              <button
                className="primary"
                disabled={busy || !pair?.bound}
                onClick={() =>
                  act(`/pairs/${id}/analyze`, "POST", { offline: false })
                }
              >
                Fetch & analyze →
              </button>
            ) : (
              <Link className="button primary" to={next.href}>
                {next.action} →
              </Link>
            )}
          </section>
        )}
      {data?.snapshot && (
        <section className="coverage-strip" aria-label="Analysis coverage">
          <div>
            <strong>
              {
                items.filter((item) => item.decision === "Port to target")
                  .length
              }
            </strong>
            <span>Port candidates</span>
          </div>
          <div>
            <strong>
              {items.filter((item) => item.decision === "Investigate").length}
            </strong>
            <span>Needs investigation</span>
          </div>
          <div>
            <strong>
              {
                items.filter((item) => item.decision === "No port needed")
                  .length
              }
            </strong>
            <span>No port needed</span>
          </div>
          <div>
            <strong>{data.snapshot.offline ? "Offline" : "Fetched"}</strong>
            <span>{new Date(data.snapshot.createdAt).toLocaleString()}</span>
          </div>
        </section>
      )}
      {!isLoading && !data?.snapshot && (
        <EmptyState title="Run an analysis to begin">
          The first scan identifies changes since the baseline. Select “Run
          analysis” above, or set up repository paths if this pair is not
          connected.
        </EmptyState>
      )}
      {data?.snapshot && data.snapshot.events.length === 0 && (
        <EmptyState title="No changes since the baseline">
          This scan found no new source integrations. It does not establish full
          migration parity. Scan again when the source advances.
        </EmptyState>
      )}
      {data?.snapshot &&
        data.snapshot.events.length > 0 &&
        !data.snapshot.aiAssessedAt && (
          <EmptyState title="AI assessment pending">
            The Git scan found {data.snapshot.events.length} integration events.
            Run analysis to compare source and target code and documentation
            before showing porting decisions.
          </EmptyState>
        )}
      {data?.snapshot?.aiAssessedAt && (
        <section className="section-block">
          <div className="section-heading">
            <div>
              <span className="eyebrow">PORTING DECISIONS</span>
              <h2>Changes that matter</h2>
            </div>
            <span className="muted small">
              {visible.length} shown · {data.snapshot.events.length} source
              events analyzed
            </span>
          </div>
          <div className="filter-bar">
            <label className="search-field">
              <span className="sr-only">Search changes</span>
              <input
                placeholder="Search behavior, impact, or feature area"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">Filter by status</span>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="actionable">Needs attention</option>
                <option value="all">All decisions</option>
                {decisions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {visible.length === 0 && (
            <div className="decision-empty">
              <EmptyState
                title={
                  items.length && !search && filter === "actionable"
                    ? "Nothing needs attention"
                    : "No decisions match"
                }
              >
                {items.length && !search && filter === "actionable"
                  ? "The analysis found no behavior that needs porting or investigation."
                  : "Try another search or filter."}
              </EmptyState>
              {items.length > 0 && (
                <button
                  className="button subtle"
                  onClick={() => setFilter("all")}
                >
                  Show all {items.length} decisions
                </button>
              )}
            </div>
          )}
          {decisions.map((name) => {
            const sectionItems = visible.filter(
              (item) => item.decision === name,
            );
            return sectionItems.length ? (
              <div className="gap-group" key={name}>
                <h3>
                  {name} <span>{sectionItems.length}</span>
                </h3>
                <div className="gap-list">
                  {sectionItems.map((item) => (
                    <Link
                      className="gap-item"
                      to={`/pairs/${id}/gaps/${item.gaps[0].id}?focus=${encodeURIComponent(item.key)}&stage=${stageForGapStatus(item.gaps[0].status)}`}
                      key={item.key}
                    >
                      <span
                        className={`group-indicator ${name === "No port needed" ? "complete" : name === "Port to target" ? "progress" : "attention"}`}
                      />
                      <span className="gap-content">
                        <strong>{item.title}</strong>
                        <span className="gap-meta">
                          {item.featureArea} · {item.impact} ·{" "}
                          {item.sourceShas.length} source{" "}
                          {item.sourceShas.length === 1 ? "event" : "events"}
                        </span>
                      </span>
                      {item.gaps[0].status !== "open" && (
                        <span className="status-pill neutral">
                          {statusLabel(item.gaps[0].status)}
                        </span>
                      )}
                      <span className="row-arrow">→</span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null;
          })}
        </section>
      )}
    </div>
  );
}
