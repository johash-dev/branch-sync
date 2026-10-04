import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, providerLabel } from "./api.js";
import { ErrorMessage, Loading, useWorkspace } from "./AppShell.js";
import type { Binding, Pair, Provider } from "./types.js";

type SetupData = { pairs: Pair[]; binding: Binding };
type Refs = { source: string[]; target: string[]; pairHash: string };

export function FirstRun({ children }: { children: React.ReactNode }) {
  const { data, error } = useQuery<SetupData>({
    queryKey: ["pairs"],
    queryFn: () => api("/pairs"),
  });
  if (error) return <ErrorMessage message={String(error)} />;
  if (!data) return <Loading />;
  return data.pairs.some(
    (p) =>
      data.binding.pairs[p.id]?.sourcePath.trim() &&
      data.binding.pairs[p.id]?.targetPath.trim(),
  ) ? (
    children
  ) : (
    <Navigate to="/setup" replace />
  );
}

export function Setup() {
  const { data, error } = useQuery<SetupData>({
    queryKey: ["pairs"],
    queryFn: () => api("/pairs"),
  });
  const { data: providers, refetch } = useQuery<Provider[]>({
    queryKey: ["providers"],
    queryFn: () => api("/providers"),
  });
  const query = useQueryClient();
  const navigate = useNavigate();
  const { addJob, notify } = useWorkspace();
  const [step, setStep] = useState(1);
  const [pairId, setPairId] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [same, setSame] = useState(false);
  const [refs, setRefs] = useState<Refs>();
  const [sourceRef, setSourceRef] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const selectedId = pairId || data?.pairs[0]?.id || "";
  const pair = data?.pairs.find((p) => p.id === selectedId);
  const provider = providers?.find(
    (p) => p.provider === data?.binding.defaultProvider,
  );
  const providerReady =
    !!provider?.available &&
    (provider.provider !== "cursor" ||
      provider.authentication === "authenticated");
  const changed =
    pair && (sourceRef !== pair.source.ref || targetRef !== pair.target.ref);
  const selection = {
    pairId: selectedId,
    sourcePath: sourcePath.trim(),
    targetPath: (same ? sourcePath : targetPath).trim(),
    sourceRef,
    targetRef,
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure("");
    try {
      await action();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function connect() {
    const binding = data?.binding.pairs[selectedId];
    setSourcePath(binding?.sourcePath || "");
    setTargetPath(binding?.targetPath || "");
    setSame(!!binding?.sourcePath && binding.sourcePath === binding.targetPath);
    setFailure("");
    setStep(2);
  }
  async function browse(side: "source" | "target") {
    await run(async () => {
      const result = await api<{ path: string | null }>(
        "/setup/folder",
        "POST",
      );
      if (result.path)
        (side === "source" ? setSourcePath : setTargetPath)(result.path);
    });
  }
  async function discover() {
    await run(async () => {
      const result = await api<Refs>("/setup/inspect", "POST", {
        pairId: selectedId,
        sourcePath: selection.sourcePath,
        targetPath: selection.targetPath,
      });
      setRefs(result);
      setSourceRef(pair!.source.ref);
      setTargetRef(pair!.target.ref);
      setAcknowledge(false);
      setStep(3);
    });
  }
  async function finish() {
    await run(async () => {
      const saved = await api<{ pairHash: string }>("/setup/complete", "POST", {
        ...selection,
        pairHash: refs!.pairHash,
        acknowledge,
      });
      setRefs({ ...refs!, pairHash: saved.pairHash });
      await Promise.all([
        query.invalidateQueries({ queryKey: ["pairs"] }),
        query.invalidateQueries({ queryKey: ["health"] }),
        query.invalidateQueries({ queryKey: ["pair", selectedId] }),
      ]);
      const { jobId } = await api<{ jobId: string }>(
        `/pairs/${selectedId}/analyze`,
        "POST",
        { offline: false },
      );
      addJob(jobId);
      notify("Analysis started. Follow it in Activity.");
      navigate(`/pairs/${selectedId}`);
    });
  }
  if (error) return <ErrorMessage message={String(error)} />;
  if (!data) return <Loading />;
  return (
    <div className="page setup-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">WELCOME</span>
          <h1>Connect your repositories</h1>
          <p>
            Choose the repositories you want to sync. Your folder paths stay on
            this computer.
          </p>
        </div>
      </header>
      <nav className="setup-progress" aria-label="Setup progress">
        {["Choose a pair", "Connect repositories", "Check branches"].map(
          (title, index) => (
            <span
              key={title}
              aria-current={step === index + 1 ? "step" : undefined}
            >
              {index + 1} <b>{title}</b>
            </span>
          ),
        )}
      </nav>
      <ErrorMessage message={failure} />
      <section className="form-panel">
        {step === 1 && (
          <>
            <h2>Choose a pair</h2>
            <label>
              Sync pair
              <select
                value={selectedId}
                onChange={(e) => setPairId(e.target.value)}
              >
                {data.pairs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <p>
              The preset includes the starting commit, architecture rules, and
              checks.
            </p>
            <button className="primary" disabled={!pair} onClick={connect}>
              Continue
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h2>Connect repositories</h2>
            <p>{pair?.name}</p>
            <div>
              <label htmlFor="setup-source">Source repository</label>
              <div className="setup-path">
                <input
                  id="setup-source"
                  disabled={busy}
                  value={sourcePath}
                  placeholder="Absolute repository path"
                  onChange={(e) => setSourcePath(e.target.value)}
                />
                <button disabled={busy} onClick={() => void browse("source")}>
                  Browse source
                </button>
              </div>
            </div>
            <label className="checkbox-line">
              <input
                type="checkbox"
                disabled={busy}
                checked={same}
                onChange={(e) => setSame(e.target.checked)}
              />
              Use the same repository for the target
            </label>
            {!same && (
              <div>
                <label htmlFor="setup-target">Target repository</label>
                <div className="setup-path">
                  <input
                    id="setup-target"
                    disabled={busy}
                    value={targetPath}
                    placeholder="Absolute repository path"
                    onChange={(e) => setTargetPath(e.target.value)}
                  />
                  <button disabled={busy} onClick={() => void browse("target")}>
                    Browse target
                  </button>
                </div>
              </div>
            )}
            <div className="button-row">
              <button disabled={busy} onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="primary"
                disabled={
                  busy || !selection.sourcePath || !selection.targetPath
                }
                onClick={() => void discover()}
              >
                {busy ? "Checking…" : "Continue"}
              </button>
            </div>
          </>
        )}
        {step === 3 && refs && (
          <>
            <h2>Check branches</h2>
            <p>{pair?.name}</p>
            {(["source", "target"] as const).map((side) => {
              const value = side === "source" ? sourceRef : targetRef;
              return (
                <label key={side}>
                  {side === "source" ? "Source branch" : "Target branch"}
                  <select
                    disabled={busy}
                    value={value}
                    onChange={(e) => {
                      (side === "source" ? setSourceRef : setTargetRef)(
                        e.target.value,
                      );
                      setAcknowledge(false);
                    }}
                  >
                    {!refs[side].includes(value) && (
                      <option value={value}>{value} (not found locally)</option>
                    )}
                    {refs[side].map((ref) => (
                      <option key={ref} value={ref}>
                        {ref}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            <p className="field-hint">
              Missing a branch? Fetch it in your repository, then go back and
              continue to refresh the list. Baseline or mapping changes belong
              in <Link to="/settings">Configuration</Link>.
            </p>
            {changed && (
              <div className="change-warning">
                <strong>Shared settings are changing</strong>
                <p>
                  These branches are shared with your team. Pending approvals
                  may need to be renewed.
                </p>
                <label className="checkbox-line">
                  <input
                    disabled={busy}
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(e) => setAcknowledge(e.target.checked)}
                  />
                  I understand that pending approvals may need to be renewed.
                </label>
              </div>
            )}
            <div
              className={`setup-note ${providerReady ? "success" : "warning"}`}
            >
              <span>
                {providerReady
                  ? `${providerLabel(provider!.provider)} is ready.`
                  : "Your AI tool is not ready. Run /setup in Cursor, or check your provider in Configuration."}
              </span>
              <button disabled={busy} onClick={() => void refetch()}>
                Check again
              </button>
            </div>
            <div className="button-row">
              <button
                disabled={busy}
                onClick={() => {
                  setFailure("");
                  setStep(2);
                }}
              >
                Back
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  !providerReady ||
                  !refs.source.includes(sourceRef) ||
                  !refs.target.includes(targetRef) ||
                  (!!changed && !acknowledge)
                }
                onClick={() => void finish()}
              >
                {busy ? "Checking and saving…" : "Save and analyze"}
              </button>
            </div>
          </>
        )}
      </section>
      <p>
        <Link to="/settings">Advanced configuration</Link>
      </p>
    </div>
  );
}
