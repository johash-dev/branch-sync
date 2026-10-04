import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, isTerminal, statusLabel } from "./api.js";
import {
  connectionCopy,
  formatElapsed,
  jobObjectiveText,
  quietAfterMs,
  quietCopy,
  timelineEntries,
  validationSnapshot,
  type CheckProgress,
} from "./activity.js";
import type { Job, JobEvent } from "./types.js";

function InteractionForm({
  interaction,
  jobId,
}: {
  interaction: Job["interactions"][number];
  jobId: string;
}) {
  const [answer, setAnswer] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const params = interaction.params || {};
  const permission =
    interaction.type.includes("requestApproval") ||
    interaction.type === "session/request_permission" ||
    interaction.type === "claude/permission";
  const cursorQuestion = interaction.type === "cursor/ask_question";
  const cursorPlan = interaction.type === "cursor/create_plan";
  const options: { optionId: string; name?: string; kind?: string }[] =
    Array.isArray(params.options) ? params.options : [];
  const questions: { id: string; header?: string; question?: string }[] =
    cursorQuestion || !Array.isArray(params.questions) ? [] : params.questions;
  const cursorQuestions: {
    id: string;
    prompt?: string;
    allowMultiple?: boolean;
    options?: { id: string; label: string }[];
  }[] = cursorQuestion && Array.isArray(params.questions) ? params.questions : [];
  const submit = async (value: unknown) => {
    setBusy(true);
    setError("");
    try {
      await api(`/jobs/${jobId}/interactions/${interaction.id}`, "POST", {
        value,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="interaction-card">
      <div className="interaction-icon">!</div>
      <div>
        <strong>
          {permission
            ? "Permission needed"
            : cursorPlan
              ? "Agent execution consent"
              : "Agent needs an answer"}
        </strong>
        <p>
          {cursorPlan
            ? "Allowing this lets the agent continue its own plan. It is not workbench approval of the saved adaptation plan."
            : String(
                params.reason ||
                  params.description ||
                  params.overview ||
                  params.title ||
                  params.name ||
                  params.command ||
                  params.tool_name ||
                  "Review this request to continue the job.",
              )}
        </p>
        {cursorPlan && (
          <div className="interaction-questions">
            <pre>{String(params.plan || "")}</pre>
            <div className="button-row">
              <button
                className="primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => submit("accepted")}
              >
                Allow agent to execute
              </button>
              <button disabled={busy} onClick={() => submit("rejected")}>
                Reject agent plan
              </button>
            </div>
          </div>
        )}
        {cursorQuestions.length > 0 && (
          <div className="interaction-questions">
            {cursorQuestions.map((question) => (
              <div key={question.id}>
                <p>{question.prompt || question.id}</p>
                <div className="button-row">
                  {(question.options || []).map((option) => {
                    const chosen = (selected[question.id] || []).includes(
                      option.id,
                    );
                    return (
                      <button
                        key={option.id}
                        className={chosen ? "primary" : undefined}
                        disabled={busy}
                        onClick={() =>
                          setSelected((current) => {
                            const existing = current[question.id] || [];
                            const next = question.allowMultiple
                              ? existing.includes(option.id)
                                ? existing.filter((id) => id !== option.id)
                                : [...existing, option.id]
                              : [option.id];
                            return { ...current, [question.id]: next };
                          })
                        }
                      >
                        {option.label || option.id}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="button-row">
              <button
                className="primary"
                disabled={
                  busy ||
                  cursorQuestions.some(
                    (question) => !(selected[question.id] || []).length,
                  )
                }
                onClick={() =>
                  submit({
                    answers: cursorQuestions.map((question) => ({
                      questionId: question.id,
                      selectedOptionIds: selected[question.id] || [],
                    })),
                  })
                }
              >
                Send answers
              </button>
              <button disabled={busy} onClick={() => submit({ skipped: true })}>
                Skip
              </button>
            </div>
          </div>
        )}
        {questions.length > 0 && (
          <div className="interaction-questions">
            {questions.map((question) => (
              <label key={question.id}>
                {question.question || question.header || question.id}
                <input
                  value={answers[question.id] || ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [question.id]: e.target.value })
                  }
                />
              </label>
            ))}
            <button
              disabled={busy || questions.some((q) => !answers[q.id]?.trim())}
              onClick={() => submit({ answers })}
            >
              Send answers
            </button>
          </div>
        )}
        {questions.length === 0 && options.length > 0 && (
          <div className="button-row">
            {options.map((option) => (
              <button
                key={option.optionId}
                disabled={busy}
                onClick={() => submit({ optionId: option.optionId })}
              >
                {option.name || option.kind || option.optionId}
              </button>
            ))}
          </div>
        )}
        {questions.length === 0 && options.length === 0 && permission && (
          <div className="button-row">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                submit(
                  interaction.type === "claude/permission" ? "allow" : "accept",
                )
              }
            >
              Allow
            </button>
            <button
              disabled={busy}
              onClick={() =>
                submit(
                  interaction.type === "claude/permission" ? "deny" : "decline",
                )
              }
            >
              Deny
            </button>
          </div>
        )}
        {questions.length === 0 &&
          options.length === 0 &&
          !permission &&
          !cursorPlan &&
          cursorQuestions.length === 0 && (
            <div className="button-row">
              <input
                aria-label="Response"
                placeholder="Type a response"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <button
                className="primary"
                disabled={busy || !answer.trim()}
                onClick={() => {
                  let value: unknown = answer;
                  try {
                    value = JSON.parse(answer);
                  } catch {}
                  void submit(value);
                }}
              >
                Respond
              </button>
            </div>
          )}
        <details className="technical-details">
          <summary>Request details</summary>
          <pre>{JSON.stringify(params, null, 2)}</pre>
        </details>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function ValidationProgressPanel({
  progress,
  runningSince,
  lastOutputAt,
  connection,
  status,
  error,
}: {
  progress?: CheckProgress;
  runningSince?: string;
  lastOutputAt?: string;
  connection: string;
  status?: string;
  error?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const running = progress?.phase === "running" && !isTerminal(status || "");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!progress) return null;
  const ratio = progress.total > 0 ? progress.completed / progress.total : 0;
  const elapsed = runningSince
    ? Math.floor((now - Date.parse(runningSince)) / 1000)
    : 0;
  const quiet = quietCopy(!!running, lastOutputAt, now);
  const outputAge =
    lastOutputAt && Number.isFinite(Date.parse(lastOutputAt))
      ? formatElapsed(Math.floor((now - Date.parse(lastOutputAt)) / 1000))
      : "";
  return (
    <div className="validation-progress" aria-live="off">
      <p className="progress-title">
        {progress.total > 0
          ? `Check ${progress.index + 1} of ${progress.total}: ${progress.name}`
          : "This step does not have a measurable completion count."}
      </p>
      {progress.total > 0 ? (
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
          aria-valuetext={`${progress.completed} of ${progress.total} checks finished`}
        >
          <span
            className="progress-fill"
            style={{ ["--progress" as string]: String(ratio) }}
          />
        </div>
      ) : (
        <p className="muted small">Progress for this step is indeterminate.</p>
      )}
      <p className="muted small tabular">
        {running && runningSince ? `Elapsed ${formatElapsed(elapsed)}. ` : ""}
        {lastOutputAt
          ? `Last output ${outputAge} ago.`
          : running
            ? "No output yet."
            : ""}
      </p>
      <p className="muted small">{connectionCopy(connection, { status, error })}</p>
      {quiet && now - (runningSince ? Date.parse(runningSince) : now) >= quietAfterMs && (
        <p className="quiet-note">{quiet}</p>
      )}
    </div>
  );
}

function JobCard({
  id,
  onDismiss,
  onAttention,
  onJob,
  onAnnounce,
}: {
  id: string;
  onDismiss: (id: string) => void;
  onAttention: () => void;
  onJob?: (job: Job) => void;
  onAnnounce: (message: string, alert?: boolean) => void;
}) {
  const [job, setJob] = useState<Job>();
  const jobRef = useRef<Job | undefined>(undefined);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState("");
  const terminalHandled = useRef(false);
  const announced = useRef("");
  const query = useQueryClient();
  useEffect(() => {
    const events = new EventSource(`/api/jobs/${id}/events`);
    const finish = (next: Job) => {
      if (!isTerminal(next.status)) return;
      events.close();
      if (terminalHandled.current) return;
      terminalHandled.current = true;
      void query.invalidateQueries({ queryKey: ["health"] });
      void query.invalidateQueries({ queryKey: ["pair", next.pairId] });
      if (next.gapId) {
        void query.invalidateQueries({
          queryKey: ["gap", next.pairId, next.gapId],
        });
        void query.invalidateQueries({
          queryKey: ["diff", next.pairId, next.gapId],
        });
      }
    };
    const apply = (next: Job) => {
      jobRef.current = next;
      setJob(next);
      onJob?.(next);
      if (next.interactions.length) onAttention();
      finish(next);
    };
    events.addEventListener("snapshot", (message) => {
      const next = JSON.parse((message as MessageEvent).data) as Job;
      apply(next);
      setConnection("connected");
    });
    events.addEventListener("update", (message) => {
      const update = JSON.parse((message as MessageEvent).data) as {
        seq: number;
        event: JobEvent;
        state: Omit<Job, "events">;
      };
      const previous = jobRef.current;
      const next: Job = {
        ...update.state,
        events:
          previous && previous.events.length >= update.seq
            ? previous.events
            : [...(previous?.events || []), update.event],
      };
      apply(next);
      setConnection("connected");
    });
    events.onerror = () => setConnection("reconnecting");
    return () => events.close();
  }, [id, query, onAttention, onJob]);
  const entries = timelineEntries(job?.events || []);
  const latest = entries[entries.length - 1];
  const snapshot = validationSnapshot(job?.events || []);
  useEffect(() => {
    if (!latest || latest.summary === announced.current) return;
    announced.current = latest.summary;
    onAnnounce(latest.summary, job?.status === "failed");
  }, [latest, job?.status, onAnnounce]);
  const link = job?.gapId
    ? `/pairs/${job.pairId}/gaps/${job.gapId}`
    : job?.pairId
      ? `/pairs/${job.pairId}`
      : "/";
  const technical = (job?.events || []).filter((event) => {
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as { activity?: string; rawType?: string })
        : undefined;
    return event.type === "technical" || data?.activity === "technical";
  });
  return (
    <article
      className={`job-card ${job?.interactions.length ? "needs-input" : ""}`}
      id={job ? `job-${job.id}` : undefined}
    >
      <div className="job-head">
        <div>
          <strong>{job ? statusLabel(job.kind) : "Loading job"}</strong>
          <span className={`status-pill ${job?.status || "queued"}`}>
            {job?.interactions.length
              ? "Needs input"
              : job?.status || connection}
          </span>
        </div>
        {job && isTerminal(job.status) && (
          <button
            className="icon-button"
            aria-label="Dismiss job"
            onClick={() => onDismiss(id)}
          >
            ×
          </button>
        )}
      </div>
      <p className="job-objective">
        {jobObjectiveText(job?.kind || "")}
      </p>
      <p className="latest-update">
        <span className="eyebrow">Latest</span>
        {latest?.summary || "Waiting for the first update"}
      </p>
      {(snapshot.progress || job?.kind === "validate") && (
        <ValidationProgressPanel
          progress={snapshot.progress}
          runningSince={snapshot.runningSince}
          lastOutputAt={snapshot.lastOutputAt}
          connection={connection}
          status={job?.status}
          error={job?.error}
        />
      )}
      <p className="muted small">{connectionCopy(connection, job)}</p>
      {job?.error && (
        <p className="inline-error" role="alert">
          {job.error} {latest?.recovery || "Read the error, fix the cause, and run the action again."}
        </p>
      )}
      {job?.interactions.map((interaction) => (
        <InteractionForm
          key={interaction.id}
          interaction={interaction}
          jobId={id}
        />
      ))}
      <div className="job-actions">
        <Link to={link}>Open related work →</Link>
        {job && !isTerminal(job.status) && (
          <button
            className="quiet-button"
            onClick={async () => {
              setError("");
              try {
                await api(`/jobs/${id}/cancel`, "POST");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!!entries.length && (
        <ol className="activity-list">
          {entries.slice(-12).map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <time dateTime={entry.at}>
                {new Date(entry.at).toLocaleTimeString()}
              </time>
              <span>
                {entry.summary}
                {entry.count > 1 ? ` ×${entry.count}` : ""}
                {entry.recovery ? ` ${entry.recovery}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!!technical.length && (
        <details className="technical-details">
          <summary>Technical details</summary>
          <ol className="technical-list">
            {technical.slice(-12).map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleTimeString()}
                </time>
                {String(
                  (event.data as { rawType?: string } | undefined)?.rawType ||
                    event.type,
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

const focusableSelector =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function JobTray({
  ids,
  onDismiss,
  open: openProp,
  onOpenChange,
  onJob,
  focusJobId,
}: {
  ids: string[];
  onDismiss: (id: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onJob?: (job: Job) => void;
  focusJobId?: string;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = openProp ?? uncontrolled;
  const setOpen = useCallback(
    (value: boolean) => {
      setUncontrolled(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );
  const show = useCallback(() => setOpen(true), [setOpen]);
  const dialogRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [live, setLive] = useState("");
  const [alert, setAlert] = useState("");
  const announce = useCallback((message: string, isAlert = false) => {
    if (isAlert) setAlert(message);
    else setLive(message);
  }, []);
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const root = dialogRef.current;
    const shell = document.querySelector(".shell");
    shell?.setAttribute("inert", "");
    const focusTarget = focusJobId
      ? root?.querySelector<HTMLElement>(`#job-${focusJobId} button, #job-${focusJobId} a`)
      : undefined;
    (focusTarget || root?.querySelector<HTMLElement>("button"))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter(
        (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      shell?.removeAttribute("inert");
      (previousFocus.current || toggleRef.current)?.focus();
    };
  }, [open, setOpen, focusJobId]);
  return (
    <>
      <button
        ref={toggleRef}
        className="activity-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="job-tray"
      >
        <span className="activity-dot" /> Activity{" "}
        {ids.length > 0 && <span className="count-badge">{ids.length}</span>}
      </button>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </div>
      <div className="sr-only" role="alert">
        {alert}
      </div>
      <section
        ref={dialogRef}
        className={`job-tray ${open ? "open" : ""}`}
        id="job-tray"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-title"
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <div className="tray-title">
          <div>
            <span className="eyebrow">WORK IN PROGRESS</span>
            <h2 id="activity-title">Activity</h2>
          </div>
          <button
            className="icon-button"
            onClick={() => setOpen(false)}
            aria-label="Close activity"
          >
            ×
          </button>
        </div>
        {ids.length === 0 ? (
          <div className="empty-state">
            <strong>No active jobs</strong>
            <p>
              Jobs you start will appear here with the objective, the current
              action, and the outcome.
            </p>
          </div>
        ) : (
          ids.map((id) => (
            <JobCard
              key={id}
              id={id}
              onDismiss={onDismiss}
              onAttention={show}
              onJob={onJob}
              onAnnounce={announce}
            />
          ))
        )}
      </section>
      <button
        className={`tray-backdrop ${open ? "open" : ""}`}
        aria-label="Close activity"
        tabIndex={open ? 0 : -1}
        onClick={() => setOpen(false)}
      />
    </>
  );
}
