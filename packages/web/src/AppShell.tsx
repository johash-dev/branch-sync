import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";
import { JobTray } from "./JobCenter.js";
import { Icon } from "./Icon.js";
import type { PairHealth, Job } from "./types.js";

type Workspace = {
  addJob: (id: string) => void;
  notify: (message: string, tone?: "success" | "error") => void;
  openActivity: (jobId?: string) => void;
  jobs: Job[];
};
const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context unavailable");
  return value;
}
export function useAction() {
  const { addJob, notify } = useWorkspace();
  const query = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (url: string, method = "POST", body?: unknown) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<any>(url, method, body);
      if (result.jobId) {
        addJob(result.jobId);
        notify("Job started. Follow it in Activity.");
      } else {
        await query.invalidateQueries();
        notify("Saved successfully.");
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      notify(message, "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { act, error, busy, setError };
}
export function recoveryFor(message: string) {
  if (/then |open /i.test(message)) return "";
  if (/setup/i.test(message))
    return "Open Setup, save the source and target repositories, then try again.";
  if (/name/i.test(message)) return "Enter your name, then try again.";
  if (/already/i.test(message))
    return "Open Activity, follow that job or cancel it, then start again.";
  if (/approv/i.test(message))
    return "Open Approve and record approval of the saved plan.";
  return "Fix the cause described above, then try the action again.";
}
export function ErrorMessage({ message }: { message?: string }) {
  if (!message) return null;
  const recovery = recoveryFor(message);
  return (
    <div className="message error-message" role="alert">
      <strong>Action needed</strong>
      <span>{message}</span>
      {recovery && <span>{recovery}</span>}
    </div>
  );
}
export function Loading({ label = "Loading workspace…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Icon name="inbox" size={26} />
      </div>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function Layout() {
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [focusJobId, setFocusJobId] = useState<string>();
  const [notice, setNotice] = useState<{
    message: string;
    tone: "success" | "error";
    leaving?: boolean;
  }>();
  const addJob = useCallback(
    (id: string) => setJobIds((ids) => (ids.includes(id) ? ids : [id, ...ids])),
    [],
  );
  const registerJob = useCallback((job: Job) => {
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
  }, []);
  const openActivity = useCallback((jobId?: string) => {
    setFocusJobId(jobId);
    setActivityOpen(true);
  }, []);
  const notify = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setNotice({ message, tone });
    },
    [],
  );
  const { data } = useQuery<{
    pairs: PairHealth[];
    jobs: Pick<Job, "id" | "status">[];
  }>({
    queryKey: ["health"],
    queryFn: () => api("/health"),
  });
  useEffect(() => {
    data?.jobs
      .filter((job) => ["queued", "running"].includes(job.status))
      .forEach((job) => addJob(job.id));
  }, [data, addJob]);
  useEffect(() => {
    if (!notice || notice.leaving) return;
    const timer = setTimeout(
      () => setNotice((current) => (current ? { ...current, leaving: true } : current)),
      5000,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!notice?.leaving) return;
    const timer = setTimeout(() => setNotice(undefined), 120);
    return () => clearTimeout(timer);
  }, [notice]);
  const dismissJob = useCallback(
    (id: string) => setJobIds((ids) => ids.filter((x) => x !== id)),
    [],
  );
  return (
    <WorkspaceContext.Provider value={{ addJob, notify, openActivity, jobs }}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" to="/">
            <span className="brand-symbol">
              <Icon name="branch" size={24} />
            </span>
            <span>
              Branch Sync<small>Workbench</small>
            </span>
          </Link>
          <div className="nav-group">
            <span className="nav-label">WORKSPACE</span>
            <nav aria-label="Main navigation">
              <NavLink
                to="/"
                end
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Icon name="dashboard" size={18} /> <span>Dashboard</span>
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Icon name="settings" size={18} /> <span>Configuration</span>
              </NavLink>
            </nav>
          </div>
          <div className="sidebar-help">
            <strong>Working locally</strong>
            <p>
              Review evidence, approve a plan, and hand off a validated branch.
            </p>
            <Link to="/settings">Check setup →</Link>
          </div>
          <div className="side-foot">Local workspace · v0.1</div>
        </aside>
        <main id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <JobTray
        ids={jobIds}
        onDismiss={dismissJob}
        open={activityOpen}
        onOpenChange={setActivityOpen}
        onJob={registerJob}
        focusJobId={focusJobId}
      />
      {notice && (
        <div
          className={`toast ${notice.tone} ${notice.leaving ? "leaving" : ""}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
          <button
            aria-label="Dismiss message"
            onClick={() => setNotice((current) => current && { ...current, leaving: true })}
          >
            ×
          </button>
        </div>
      )}
    </WorkspaceContext.Provider>
  );
}
