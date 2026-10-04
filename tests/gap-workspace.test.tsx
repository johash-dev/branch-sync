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

function payload(status = "open", classification = "present") {
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
    plan:
      status === "planned"
        ? {
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
          }
        : undefined,
    relatedGaps: [],
    sourceRepository: "",
    sourceEvents: [],
  };
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
});
