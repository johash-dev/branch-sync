// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "../packages/web/src/AppShell.js";
import { GapPage } from "../packages/web/src/GapPage.js";
import { api } from "../packages/web/src/api.js";

vi.mock("../packages/web/src/api.js", async (original) => ({
  ...(await original<typeof import("../packages/web/src/api.js")>()),
  api: vi.fn(),
}));

const requirement = {
  id: "r1",
  behavior: "Gate develop deploys",
  classification: "present",
  rationale: "Target already has the flag",
  sourceEvidence: ["source:pipeline"],
  targetEvidence: ["target:pipeline"],
  dependencies: [],
  featureArea: "pipeline",
  impact: "No target change",
};

const savedPlan = {
  id: "plan-1",
  sourceBehavior: "Source gates deploys",
  targetBehavior: "Target should gate deploys",
  targetFiles: ["azure-release-pipelines.yml"],
  approach: "Add the variable",
  conventions: [],
  dependencies: [],
  regressionTests: ["Review the YAML"],
  commands: [],
  manualScenarios: [],
  questions: [],
};

function payload(
  status = "open",
  classification = "present",
  run?: {
    stage: string;
    status: string;
    worktree: string;
    branch: string;
    checks: [];
    manualResults: [];
  },
) {
  return {
    gap: {
      id: "gap-1",
      pairId: "sep",
      integrationSha: "a".repeat(40),
      sourceSubject: "Add deploy flag",
      status,
      updatedAt: "now",
      requirements: [{ ...requirement, classification }],
    },
    plan: status === "open" ? undefined : savedPlan,
    run,
    relatedGaps: [],
    sourceRepository: "",
    sourceEvents: [],
  };
}

const worktreeRun = {
  stage: "implementing",
  status: "Worktree ready",
  worktree: "C:\\wt\\sep-gap",
  branch: "codex/sync-sep",
  checks: [] as [],
  manualResults: [] as [],
};

function workspaceApi(
  body: ReturnType<typeof payload>,
  onOpen?: (request: unknown) => Promise<unknown>,
) {
  vi.mocked(api).mockImplementation(async (url, method, request) => {
    if (url === "/health") return { pairs: [], jobs: [] };
    if (url === "/pairs")
      return {
        pairs: [{ id: "sep", name: "SEP" }],
        binding: { defaultProvider: "cursor", pairs: {} },
      };
    if (url === "/providers") return [{ provider: "cursor", available: true }];
    if (method === "POST" && url === "/pairs/sep/gaps/gap-1/open-worktree")
      return onOpen?.(request);
    if (String(url).endsWith("/diff")) return { diff: "" };
    if (String(url).startsWith("/pairs/sep/gaps/gap-1")) return body;
    throw new Error(`Unexpected ${url}`);
  });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api).mockImplementation(async (url) => {
    if (url === "/health") return { pairs: [], jobs: [] };
    if (url === "/pairs")
      return {
        pairs: [{ id: "sep", name: "SEP" }],
        binding: { defaultProvider: "cursor", pairs: {} },
      };
    if (url === "/providers") return [{ provider: "cursor", available: true }];
    if (String(url).startsWith("/pairs/sep/gaps/gap-1")) return payload();
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount(entry = "/pairs/sep/gaps/gap-1") {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={query}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/pairs/:id/gaps/:gapId" element={<GapPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("gap workspace", () => {
  it("deep-links to approval of the saved revision and keeps drafts off that stage", async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/health") return { pairs: [], jobs: [] };
      if (url === "/pairs")
        return {
          pairs: [{ id: "sep", name: "SEP" }],
          binding: { defaultProvider: "cursor", pairs: {} },
        };
      if (url === "/providers") return [{ provider: "cursor", available: true }];
      if (String(url).startsWith("/pairs/sep/gaps/gap-1"))
        return payload("planned");
      throw new Error(`Unexpected ${url}`);
    });
    mount("/pairs/sep/gaps/gap-1?stage=approve&focus=r1");
    expect(await screen.findByRole("heading", { name: "Approve the saved revision" })).toBeTruthy();
    expect(screen.getByText("azure-release-pipelines.yml")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Answer 1" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Approve saved plan" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Enter your name/)).toBeTruthy();
  });

  it("offers the no-work action and protects unsaved evidence navigation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount("/pairs/sep/gaps/gap-1?stage=evidence");
    expect(
      await screen.findByRole("button", { name: "Resolve gap →" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /Why this classification/ }), {
      target: { value: "Edited rationale" },
    });
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Plan/ }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByDisplayValue("Edited rationale")).toBeTruthy();
    confirm.mockRestore();
  });

  it("shows progress labels and keeps the current step distinct from the open stage", async () => {
    workspaceApi(payload("approved"));
    mount("/pairs/sep/gaps/gap-1");
    expect(
      await screen.findByRole("button", {
        name: "Selected stage. Step 4. Implement. Current",
      }),
    ).toBeTruthy();
    for (const name of [
      "Step 1. Evidence. Done",
      "Step 2. Plan. Done",
      "Step 3. Approve. Done",
      "Step 5. Validate. Locked",
      "Step 6. Review. Locked",
    ])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Selected stage. Step 4. Implement. Current" })
        .getAttribute("aria-current"),
    ).toBe("step");

    fireEvent.click(screen.getByRole("button", { name: "Step 1. Evidence. Done" }));
    expect(
      screen.getByRole("button", {
        name: "Selected stage. Step 1. Evidence. Done",
      }),
    ).toBeTruthy();
    const current = screen.getByRole("button", {
      name: "Step 4. Implement. Current",
    });
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(current.className).not.toContain("active");

    fireEvent.click(screen.getByRole("button", { name: "Step 5. Validate. Locked" }));
    expect(
      screen.getByText("Finish implementation before validation."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", {
          name: "Selected stage. Step 5. Validate. Locked",
        })
        .getAttribute("aria-describedby"),
    ).toBe("stage-blocker-validate");
  });

  it("opens the stored worktree in Cursor or VS Code from one click", async () => {
    let request: unknown;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    workspaceApi(payload("implementing", "missing", worktreeRun), async (body) => {
      request = body;
      await gate;
      return { opened: true };
    });
    mount("/pairs/sep/gaps/gap-1?stage=implement");
    expect(await screen.findByText("C:\\wt\\sep-gap")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in Cursor" }));
    expect(
      (await screen.findByRole("button", { name: "Opening Cursor…" })).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", { name: "Open in VS Code" }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    release({});
    expect(await screen.findByText("Opened the worktree in Cursor.")).toBeTruthy();
    expect(request).toEqual({ editor: "cursor" });
    expect(screen.getByText("C:\\wt\\sep-gap")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    expect(await screen.findByText("Opened the worktree in VS Code.")).toBeTruthy();
    expect(request).toEqual({ editor: "code" });
  });

  it("keeps the worktree path visible when an editor cannot open", async () => {
    workspaceApi(payload("verified_local", "missing", worktreeRun), async () => {
      throw new Error(
        "Could not find VS Code on this machine. Install Visual Studio Code, then try Open in VS Code again.",
      );
    });
    mount("/pairs/sep/gaps/gap-1?stage=review");
    expect(
      await screen.findByRole("heading", { name: "Commit, push, and merge" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    expect(
      (await screen.findAllByText(/Could not find VS Code/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("C:\\wt\\sep-gap")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Cursor" })).toBeTruthy();
  });

  it("hides editor launch until a worktree exists", async () => {
    mount("/pairs/sep/gaps/gap-1?stage=implement");
    expect(
      await screen.findByRole("heading", { name: "Implementation & diff" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Cursor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in VS Code" })).toBeNull();
  });
});
