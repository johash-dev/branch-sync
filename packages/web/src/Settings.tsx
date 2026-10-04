import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, providerLabel } from "./api.js";
import { ErrorMessage, Loading, useAction } from "./AppShell.js";
import type {
  Binding,
  Command,
  Pair,
  Provider,
  ProviderName,
} from "./types.js";

const lines = (value: string) => value.split("\n");
const clean = (value: string[]) =>
  value.map((item) => item.trim()).filter(Boolean);
const joined = (value: string[]) => value.join("\n");

function CommandEditor({
  title,
  value,
  onChange,
}: {
  title: string;
  value: Command;
  onChange: (value: Command) => void;
}) {
  return (
    <div className="command-editor">
      <strong>{title}</strong>
      <div className="form-grid">
        <label>
          Executable
          <input
            value={value.executable}
            onChange={(e) => onChange({ ...value, executable: e.target.value })}
            placeholder="npm"
          />
        </label>
        <label>
          Arguments <span className="field-hint">One argument per line</span>
          <textarea
            rows={3}
            value={joined(value.args)}
            onChange={(e) =>
              onChange({ ...value, args: lines(e.target.value) })
            }
            placeholder="run&#10;build"
          />
        </label>
      </div>
    </div>
  );
}

export function Settings() {
  const { data, error, isLoading } = useQuery<{
    pairs: Pair[];
    binding: Binding;
  }>({ queryKey: ["pairs"], queryFn: () => api("/pairs") });
  const { data: providers, refetch: refreshProviders } = useQuery<Provider[]>({
    queryKey: ["providers"],
    queryFn: () => api("/providers"),
  });
  const { act, busy, error: actionError } = useAction();
  const [selected, setSelected] = useState("");
  const [pendingPair, setPendingPair] = useState("");
  const [provider, setProvider] = useState<ProviderName>("codex");
  const [sourcePath, setSourcePath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [draft, setDraft] = useState<Pair>();
  const [original, setOriginal] = useState<Pair>();
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [localError, setLocalError] = useState("");
  const [refs, setRefs] = useState<{ source: string[]; target: string[] }>();
  useEffect(() => {
    if (data?.pairs.length && !selected) setSelected(data.pairs[0].id);
    if (data) setProvider(data.binding.defaultProvider);
  }, [data, selected]);
  useEffect(() => {
    const pair = data?.pairs.find((item) => item.id === selected);
    if (!pair || !data) return;
    setDraft(structuredClone(pair));
    setOriginal(structuredClone(pair));
    setJson(JSON.stringify(pair, null, 2));
    setSourcePath(data.binding.pairs[selected]?.sourcePath || "");
    setTargetPath(data.binding.pairs[selected]?.targetPath || "");
    setRefs(undefined);
    setAcknowledge(false);
  }, [data, selected]);
  const update = (change: Partial<Pair>) =>
    draft && setDraft({ ...draft, ...change });
  const selectedProvider = providers?.find(
    (item) => item.provider === provider,
  );
  const providerCommand = {
    codex: "codex --version",
    cursor: "agent --version",
    claude: "claude --version",
  }[provider];
  const changed = advanced
    ? json !== JSON.stringify(original, null, 2)
    : JSON.stringify(draft) !== JSON.stringify(original);
  const saveLocal = () => {
    if (!data) return;
    void act("/bindings", "POST", {
      ...data.binding,
      defaultProvider: provider,
      pairs: { ...data.binding.pairs, [selected]: { sourcePath, targetPath } },
    });
  };
  const saveShared = async () => {
    setLocalError("");
    try {
      const value = advanced
        ? JSON.parse(json)
        : draft && {
            ...draft,
            rules: clean(draft.rules),
            mappings: draft.mappings.filter(
              (item) => item.source.trim() || item.target.trim(),
            ),
            intentionalDifferences: draft.intentionalDifferences.filter(
              (item) => item.behavior.trim(),
            ),
            validation: {
              ...draft.validation,
              install: draft.validation.install && {
                ...draft.validation.install,
                args: clean(draft.validation.install.args),
              },
              build: {
                ...draft.validation.build,
                args: clean(draft.validation.build.args),
              },
              tests: draft.validation.tests.map((item) => ({
                ...item,
                args: clean(item.args),
              })),
              manual: clean(draft.validation.manual),
            },
          };
      if (!value) throw new Error("Select a pair first");
      const saved = await act("/pairs", "POST", value);
      if (saved) setAcknowledge(false);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <Link className="back-link" to="/">
            ← Dashboard
          </Link>
          <span className="eyebrow">CONFIGURATION</span>
          <h1>Set up your workspace</h1>
          <Link to="/setup">Open guided setup</Link>
          <p>
            Choose your AI tool, connect checkouts, and review the shared rules
            for each pair.
          </p>
        </div>
      </header>
      {isLoading && <Loading />}
      <ErrorMessage
        message={error ? String(error) : actionError || localError}
      />
      <div className="setup-progress">
        <a href="#ai-tool">
          1 <b>AI tool</b>
        </a>
        <a href="#checkouts">
          2 <b>Checkouts</b>
        </a>
        <a href="#pair-knowledge">
          3 <b>Pair knowledge</b>
        </a>
      </div>
      <section className="form-panel" id="ai-tool">
        <div className="panel-intro">
          <span className="step-number">01</span>
          <div>
            <h2>Choose your AI tool</h2>
            <p>
              This choice stays on your machine and controls all agent-assisted
              jobs. Each developer can choose their own tool.
            </p>
          </div>
        </div>
        <div
          className="provider-options"
          role="radiogroup"
          aria-label="AI tool"
        >
          {(["codex", "cursor", "claude"] as ProviderName[]).map((name) => {
            const item = providers?.find((p) => p.provider === name);
            return (
              <label
                className={`provider-option ${provider === name ? "selected" : ""}`}
                key={name}
              >
                <input
                  type="radio"
                  name="provider"
                  value={name}
                  checked={provider === name}
                  onChange={() => setProvider(name)}
                />
                <span>
                  <strong>{providerLabel(name)}</strong>
                  <small>
                    {item?.available ? "CLI detected" : "CLI not detected"}
                  </small>
                </span>
                <span
                  className={`availability-dot ${item?.available ? "available" : ""}`}
                />
              </label>
            );
          })}
        </div>
        <div
          className={`setup-note ${selectedProvider?.available ? "success" : "warning"}`}
        >
          {!providers
            ? "Checking installed AI tools…"
            : selectedProvider?.available
              ? provider === "cursor"
                ? selectedProvider.authentication === "authenticated"
                  ? "Cursor is signed in and ready."
                  : selectedProvider.authentication === "unauthenticated"
                    ? "Cursor needs sign-in. Run /setup in Cursor to connect it."
                    : "Cursor sign-in could not be checked. Run /setup in Cursor to retry."
                : `${providerLabel(provider)} is detected. Authentication is checked when a job starts.`
              : `${providerLabel(provider)} is not detected. Install its CLI so ${providerCommand} works, then sign in before starting an agent job.`}
          <button
            className="quiet-button"
            onClick={() => void refreshProviders()}
          >
            Check again
          </button>
        </div>
        <div className="button-row">
          <button
            className="primary"
            disabled={
              busy || !data || provider === data.binding.defaultProvider
            }
            onClick={() =>
              data &&
              void act("/bindings", "POST", {
                ...data.binding,
                defaultProvider: provider,
              })
            }
          >
            Save AI tool
          </button>
          <span className="muted small">
            {provider === data?.binding.defaultProvider
              ? "Saved locally for this developer."
              : "Save this choice before leaving Configuration."}
          </span>
        </div>
      </section>
      <section className="form-panel" id="checkouts">
        <div className="panel-intro">
          <span className="step-number">02</span>
          <div>
            <h2>Connect the checkouts</h2>
            <p>
              Paths stay local. Scans read Git history from these folders;
              implementation creates a separate worktree.
            </p>
          </div>
        </div>
        <label>
          Pair
          <select
            value={selected}
            onChange={(e) =>
              changed
                ? setPendingPair(e.target.value)
                : setSelected(e.target.value)
            }
          >
            {data?.pairs.map((pair) => (
              <option key={pair.id} value={pair.id}>
                {pair.name}
              </option>
            ))}
          </select>
        </label>
        {pendingPair && (
          <div className="change-warning">
            <strong>Unsaved pair edits</strong>
            <p>
              Save your shared configuration before switching, or discard those
              edits.
            </p>
            <div className="button-row">
              <button
                onClick={() => {
                  setSelected(pendingPair);
                  setPendingPair("");
                  setAdvanced(false);
                }}
              >
                Discard edits and switch
              </button>
              <button
                className="quiet-button"
                onClick={() => setPendingPair("")}
              >
                Stay here
              </button>
            </div>
          </div>
        )}
        <div className="form-grid">
          <label>
            Source checkout
            <input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="Absolute path to source repository"
            />
          </label>
          <label>
            Target checkout
            <input
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="Absolute path to target repository"
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary"
            disabled={busy || !selected}
            onClick={saveLocal}
          >
            Save local settings
          </button>
          <button
            disabled={!sourcePath || !targetPath}
            onClick={async () => {
              setLocalError("");
              try {
                setRefs(await api(`/pairs/${selected}/refs`));
              } catch (e) {
                setLocalError(String(e));
              }
            }}
          >
            Discover refs
          </button>
        </div>
        {refs && (
          <div className="refs-panel">
            <strong>Refs found</strong>
            <div>
              <span>Source</span>
              <code>{refs.source.join(", ")}</code>
            </div>
            <div>
              <span>Target</span>
              <code>{refs.target.join(", ")}</code>
            </div>
          </div>
        )}
      </section>
      {draft && (
        <section className="form-panel" id="pair-knowledge">
          <div className="panel-intro">
            <span className="step-number">03</span>
            <div>
              <h2>Review shared pair knowledge</h2>
              <p>
                Refs, architecture rules, mappings, and validation commands are
                stored in Git for everyone using this pair.
              </p>
            </div>
          </div>
          <div className="editor-switch">
            <button
              className={!advanced ? "selected" : ""}
              onClick={() => {
                if (advanced) {
                  try {
                    setDraft(JSON.parse(json));
                    setLocalError("");
                    setAdvanced(false);
                  } catch (e) {
                    setLocalError(
                      `Fix the JSON before switching editors: ${String(e)}`,
                    );
                  }
                }
              }}
            >
              Guided editor
            </button>
            <button
              className={advanced ? "selected" : ""}
              onClick={() => {
                setJson(JSON.stringify(draft, null, 2));
                setAdvanced(true);
              }}
            >
              Advanced JSON
            </button>
          </div>
          {advanced ? (
            <>
              <label>
                Pair JSON
                <textarea
                  className="code-editor"
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <p className="field-hint">
                The server validates the complete configuration before saving.
              </p>
            </>
          ) : (
            <>
              <div className="form-grid">
                <label>
                  Pair name
                  <input
                    value={draft.name}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </label>
                <label>
                  Baseline commit
                  <input
                    className="mono"
                    value={draft.baseline}
                    onChange={(e) => update({ baseline: e.target.value })}
                  />
                </label>
              </div>
              <div className="form-grid">
                <div className="sub-panel">
                  <h3>Source</h3>
                  <label>
                    Remote
                    <input
                      value={draft.source.remote}
                      onChange={(e) =>
                        update({
                          source: { ...draft.source, remote: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Repository identity
                    <input
                      value={draft.source.identity}
                      onChange={(e) =>
                        update({
                          source: { ...draft.source, identity: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Ref
                    <input
                      value={draft.source.ref}
                      onChange={(e) =>
                        update({
                          source: { ...draft.source, ref: e.target.value },
                        })
                      }
                      list="source-refs"
                    />
                  </label>
                </div>
                <div className="sub-panel">
                  <h3>Target</h3>
                  <label>
                    Remote
                    <input
                      value={draft.target.remote}
                      onChange={(e) =>
                        update({
                          target: { ...draft.target, remote: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Repository identity
                    <input
                      value={draft.target.identity}
                      onChange={(e) =>
                        update({
                          target: { ...draft.target, identity: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Ref
                    <input
                      value={draft.target.ref}
                      onChange={(e) =>
                        update({
                          target: { ...draft.target, ref: e.target.value },
                        })
                      }
                      list="target-refs"
                    />
                  </label>
                </div>
              </div>
              <datalist id="source-refs">
                {refs?.source.map((ref) => (
                  <option key={ref} value={ref} />
                ))}
              </datalist>
              <datalist id="target-refs">
                {refs?.target.map((ref) => (
                  <option key={ref} value={ref} />
                ))}
              </datalist>
              <label>
                Architecture rules{" "}
                <span className="field-hint">One rule per line</span>
                <textarea
                  rows={5}
                  value={joined(draft.rules)}
                  onChange={(e) => update({ rules: lines(e.target.value) })}
                />
              </label>
              <div className="subsection-heading">
                <h3>Source → target mappings</h3>
                <button
                  onClick={() =>
                    update({
                      mappings: [
                        ...draft.mappings,
                        { source: "", target: "", note: "" },
                      ],
                    })
                  }
                >
                  Add mapping
                </button>
              </div>
              {draft.mappings.map((mapping, index) => (
                <div className="mapping-row" key={index}>
                  <input
                    aria-label={`Mapping ${index + 1} source`}
                    placeholder="Source path"
                    value={mapping.source}
                    onChange={(e) =>
                      update({
                        mappings: draft.mappings.map((item, i) =>
                          i === index
                            ? { ...item, source: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <span>→</span>
                  <input
                    aria-label={`Mapping ${index + 1} target`}
                    placeholder="Target path"
                    value={mapping.target}
                    onChange={(e) =>
                      update({
                        mappings: draft.mappings.map((item, i) =>
                          i === index
                            ? { ...item, target: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <input
                    aria-label={`Mapping ${index + 1} note`}
                    placeholder="Note"
                    value={mapping.note}
                    onChange={(e) =>
                      update({
                        mappings: draft.mappings.map((item, i) =>
                          i === index
                            ? { ...item, note: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <button
                    className="icon-button"
                    aria-label={`Remove mapping ${index + 1}`}
                    onClick={() =>
                      update({
                        mappings: draft.mappings.filter((_, i) => i !== index),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="subsection-heading">
                <h3>Intentional differences</h3>
                <button
                  onClick={() =>
                    update({
                      intentionalDifferences: [
                        ...draft.intentionalDifferences,
                        { behavior: "", reason: "", decidedBy: "" },
                      ],
                    })
                  }
                >
                  Add difference
                </button>
              </div>
              {draft.intentionalDifferences.length === 0 && (
                <p className="muted small">None recorded for this pair.</p>
              )}
              {draft.intentionalDifferences.map((item, index) => (
                <div className="mapping-row difference-row" key={index}>
                  <input
                    aria-label={`Difference ${index + 1} behavior`}
                    placeholder="Behavior"
                    value={item.behavior}
                    onChange={(e) =>
                      update({
                        intentionalDifferences:
                          draft.intentionalDifferences.map((x, i) =>
                            i === index
                              ? { ...x, behavior: e.target.value }
                              : x,
                          ),
                      })
                    }
                  />
                  <input
                    aria-label={`Difference ${index + 1} reason`}
                    placeholder="Reason"
                    value={item.reason}
                    onChange={(e) =>
                      update({
                        intentionalDifferences:
                          draft.intentionalDifferences.map((x, i) =>
                            i === index ? { ...x, reason: e.target.value } : x,
                          ),
                      })
                    }
                  />
                  <input
                    aria-label={`Difference ${index + 1} decision maker`}
                    placeholder="Decided by"
                    value={item.decidedBy}
                    onChange={(e) =>
                      update({
                        intentionalDifferences:
                          draft.intentionalDifferences.map((x, i) =>
                            i === index
                              ? { ...x, decidedBy: e.target.value }
                              : x,
                          ),
                      })
                    }
                  />
                  <button
                    className="icon-button"
                    aria-label={`Remove difference ${index + 1}`}
                    onClick={() =>
                      update({
                        intentionalDifferences:
                          draft.intentionalDifferences.filter(
                            (_, i) => i !== index,
                          ),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="subsection-heading">
                <h3>Validation</h3>
              </div>
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={!!draft.validation.install}
                  onChange={(e) =>
                    update({
                      validation: {
                        ...draft.validation,
                        install: e.target.checked
                          ? { executable: "npm", args: ["ci"] }
                          : null,
                      },
                    })
                  }
                />
                Run an install command before validation
              </label>
              {draft.validation.install && (
                <CommandEditor
                  title="Install"
                  value={draft.validation.install}
                  onChange={(value) =>
                    update({
                      validation: { ...draft.validation, install: value },
                    })
                  }
                />
              )}
              <CommandEditor
                title="Production build"
                value={draft.validation.build}
                onChange={(value) =>
                  update({ validation: { ...draft.validation, build: value } })
                }
              />
              <div className="subsection-heading">
                <h3>Test commands</h3>
                <button
                  onClick={() =>
                    update({
                      validation: {
                        ...draft.validation,
                        tests: [
                          ...draft.validation.tests,
                          { executable: "npm", args: ["test"] },
                        ],
                      },
                    })
                  }
                >
                  Add command
                </button>
              </div>
              {draft.validation.tests.map((command, index) => (
                <div className="command-wrap" key={index}>
                  <CommandEditor
                    title={`Test ${index + 1}`}
                    value={command}
                    onChange={(value) =>
                      update({
                        validation: {
                          ...draft.validation,
                          tests: draft.validation.tests.map((item, i) =>
                            i === index ? value : item,
                          ),
                        },
                      })
                    }
                  />
                  <button
                    className="quiet-button"
                    onClick={() =>
                      update({
                        validation: {
                          ...draft.validation,
                          tests: draft.validation.tests.filter(
                            (_, i) => i !== index,
                          ),
                        },
                      })
                    }
                  >
                    Remove test
                  </button>
                </div>
              ))}
              <label>
                Manual scenarios{" "}
                <span className="field-hint">One scenario per line</span>
                <textarea
                  rows={4}
                  value={joined(draft.validation.manual)}
                  onChange={(e) =>
                    update({
                      validation: {
                        ...draft.validation,
                        manual: lines(e.target.value),
                      },
                    })
                  }
                />
              </label>
            </>
          )}
          {changed && (
            <div className="change-warning">
              <strong>Shared settings are changing</strong>
              <p>
                Saving changed refs, rules, mappings, or validation settings can
                make pending approvals stale. Review the affected pair before
                continuing.
              </p>
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                />
                I understand that pending approvals may need to be renewed.
              </label>
            </div>
          )}
          <button
            className="primary"
            disabled={busy || (changed && !acknowledge)}
            onClick={() => void saveShared()}
          >
            Save shared configuration
          </button>
        </section>
      )}
    </div>
  );
}
