import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, providerLabel, statusLabel } from "./api.js";
import { pairNextStep } from "./guidance.js";
import { EmptyState, ErrorMessage, Loading, useAction } from "./AppShell.js";
import type { Binding, Pair, PairHealth, Provider } from "./types.js";
import { Icon } from "./Icon.js";

function priority(pair: PairHealth) {
  if (!pair.bound) return 0;
  if (!pair.snapshot) return 1;
  if (pair.snapshot.coverage.unprocessed.length) return 2;
  if (pair.nextGap?.status === "changes_requested") return 3;
  if (pair.nextGap?.status === "review_required") return 4;
  if (pair.nextGap?.status === "verified_local") return 5;
  if (pair.nextGap) return 6;
  return 7;
}

export function Dashboard() {
  const { data, error, isLoading } = useQuery<{
    pairs: PairHealth[];
    jobs: { id: string; status: string }[];
  }>({ queryKey: ["health"], queryFn: () => api("/health") });
  const { data: setup } = useQuery<{ pairs: Pair[]; binding: Binding }>({
    queryKey: ["pairs"],
    queryFn: () => api("/pairs"),
  });
  const { data: providers, refetch: refreshProviders } = useQuery<Provider[]>({
    queryKey: ["providers"],
    queryFn: () => api("/providers"),
  });
  const { act, error: actionError, busy } = useAction();
  const pairs = [...(data?.pairs || [])].sort(
    (a, b) => priority(a) - priority(b),
  );
  const selected = setup?.binding.defaultProvider || "codex";
  const provider = providers?.find((item) => item.provider === selected);
  return (
    <div className="page dashboard-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">WORKSPACE OVERVIEW</span>
          <h1>Pick up where you left off</h1>
          <p>
            Follow source changes through assessment, implementation, review,
            and integration.
          </p>
        </div>
        <Link className="button subtle" to="/settings">
          Configure workspace
        </Link>
      </header>
      {isLoading && <Loading />}
      <ErrorMessage message={error ? String(error) : actionError} />
      {!isLoading && pairs.length === 0 && (
        <EmptyState title="No pairs configured">
          Add a pair configuration to begin tracking source and target branches.
        </EmptyState>
      )}
      {pairs.length > 0 && (
        <section className="section-block" aria-labelledby="continue-title">
          <div className="section-heading">
            <div>
              <span className="eyebrow">YOUR QUEUE</span>
              <h2 id="continue-title">Continue work</h2>
            </div>
            <span className="muted small">Highest priority first</span>
          </div>
          <div className="continue-list">
            {pairs.slice(0, 3).map((pair) => {
              const next = pairNextStep(pair);
              return (
                <article className="continue-item" key={pair.id}>
                  <div className="continue-marker">
                    {!pair.bound
                      ? "1"
                      : !pair.snapshot
                        ? "2"
                        : pair.snapshot.coverage.unprocessed.length
                          ? "3"
                          : "✓"}
                  </div>
                  <div className="continue-copy">
                    <span className="item-context">{pair.name}</span>
                    <strong>{next.title}</strong>
                    {pair.nextGap && (
                      <span className="status-pill neutral">
                        {statusLabel(pair.nextGap.status)}
                      </span>
                    )}
                    <p>{next.detail}</p>
                    <Link
                      className="pair-overview-link"
                      to={`/pairs/${pair.id}`}
                    >
                      View pair overview →
                    </Link>
                  </div>
                  <Link className="button primary" to={next.href}>
                    {next.action} <span aria-hidden="true">→</span>
                  </Link>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <section className="section-block" aria-labelledby="pairs-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">TRACKED BRANCHES</span>
            <h2 id="pairs-title">Sync pairs</h2>
          </div>
          <span className="muted small">{pairs.length} configured</span>
        </div>
        <div className="pair-grid">
          {pairs.map((pair) => {
            const next = pairNextStep(pair);
            return (
              <article className="pair-card" key={pair.id}>
                <div className="card-heading">
                  <div>
                    <h3>{pair.name}</h3>
                    <code>{pair.id}</code>
                  </div>
                  <span
                    className={`status-pill ${pair.bound ? "ready" : "warning"}`}
                  >
                    {pair.bound ? "Connected" : "Needs setup"}
                  </span>
                </div>
                <div className="pair-metrics">
                  <div>
                    <strong>{pair.snapshot?.events.length ?? "—"}</strong>
                    <span>Source changes</span>
                  </div>
                  <div>
                    <strong>
                      {pair.snapshot?.aiAssessedAt ? pair.portCandidates : "—"}
                    </strong>
                    <span>Port candidates</span>
                  </div>
                  <div>
                    <strong>
                      {pair.snapshot?.aiAssessedAt ? pair.investigations : "—"}
                    </strong>
                    <span>Investigate</span>
                  </div>
                </div>
                <p className="pair-state">
                  {pair.nextGap ? statusLabel(pair.nextGap.status) : next.title}
                </p>
                <div className="card-footer">
                  <Link className="button primary" to={next.href}>
                    {next.action} →
                  </Link>
                  <Link className="button subtle" to={`/pairs/${pair.id}`}>
                    View pair
                  </Link>
                  <details className="more-actions">
                    <summary>Scan options</summary>
                    <div className="popover-actions">
                      <button
                        disabled={busy || !pair.bound}
                        onClick={() =>
                          act(`/pairs/${pair.id}/analyze`, "POST", {
                            offline: false,
                          })
                        }
                      >
                        Fetch & analyze
                      </button>
                      <button
                        disabled={busy || !pair.bound}
                        onClick={() =>
                          act(`/pairs/${pair.id}/analyze`, "POST", {
                            offline: true,
                          })
                        }
                      >
                        Offline scan
                      </button>
                    </div>
                  </details>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <section className="readiness-card" aria-labelledby="runtime-title">
        <div className="readiness-icon">
          <Icon name="terminal" size={24} />
        </div>
        <div>
          <span className="eyebrow">LOCAL AI TOOL</span>
          <h2 id="runtime-title">{providerLabel(selected)}</h2>
          <p>
            {!providers
              ? "Checking the selected AI tool…"
              : provider?.available
                ? "CLI detected. You can start agent-assisted work."
                : "CLI not detected here. Install and sign in to the selected tool before starting an agent job."}
          </p>
        </div>
        <div className="readiness-actions">
          <span
            className={`status-pill ${provider?.available ? "ready" : "warning"}`}
          >
            {!providers
              ? "Checking"
              : provider?.available
                ? "Detected"
                : "Setup needed"}
          </span>
          <Link to="/settings">Change tool →</Link>
          <button
            className="quiet-button"
            onClick={() => void refreshProviders()}
          >
            Check again
          </button>
        </div>
      </section>
    </div>
  );
}
