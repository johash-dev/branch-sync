// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  classification: "missing",
  rationale: "Target has no flag",
  sourceEvidence: ["source:pipeline"],
  targetEvidence: ["target:pipeline"],
  dependencies: [],
  featureArea: "pipeline",
  impact: "Dev deploys need a flag",
};
let revision = 1;
let plan: {
  id: string;
  sourceBehavior: string;
  targetBehavior: string;
  targetFiles: string[];
  approach: string;
  conventions: string[];
  dependencies: string[];
  regressionTests: string[];
  commands: [];
  manualScenarios: string[];
  questions: (string | { question: string; answer: string })[];
};

function savedPlan() {
  return {
    gap: {
      id: "gap-1",
      pairId: "sep",
      integrationSha: "a".repeat(40),
      sourceSubject: "Add deploy flag",
      status: "planned",
      updatedAt: "now",
      requirements: [requirement],
    },
    plan,
    relatedGaps: [],
    sourceRepository: "",
    sourceEvents: [],
  };
}

beforeEach(() => {
  revision = 1;
  plan = {
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
    questions: [
      "Should the default be true?",
      "Is the existing branch filter enough?",
    ],
  };
  vi.mocked(api).mockImplementation(async (url, method = "GET", body) => {
    if (url === "/health") return { pairs: [], jobs: [] };
    if (url === "/pairs")
      return {
        pairs: [{ id: "sep", name: "SEP" }],
        binding: { defaultProvider: "cursor", pairs: {} },
      };
    if (url === "/providers")
      return [{ provider: "cursor", available: true }];
    if (url === "/pairs/sep/gaps/gap-1" && method === "GET") return savedPlan();
    if (url === "/pairs/sep/gaps/gap-1/plan" && method === "POST") {
      const posted = body as { questions: { question: string; answer: string }[] };
      revision += 1;
      plan = { ...plan, ...posted, id: `plan-${revision}` };
      return plan;
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={query}>
      <MemoryRouter initialEntries={["/pairs/sep/gaps/gap-1"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/pairs/:id/gaps/:gapId" element={<GapPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const approve = () =>
  screen.getByRole("button", { name: "Approve saved plan" }) as HTMLButtonElement;

const rail = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`Step \\d+\\. ${label}\\.`) });

describe("plan question answers", () => {
  it("enables approval only after every saved question has an answer", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit plan →" }));
    expect(screen.getByRole("heading", { name: "Behavior" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Scope" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Verification" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Questions" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Leave empty before approval")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve saved plan" })).toBeNull();
    expect(screen.getAllByText("Needs answer")).toHaveLength(2);
    expect(
      screen.getByText(
        "Answer each question, then save the revision. A blank answer blocks approval.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Answer every open question, then save, before approval."),
    ).toBeTruthy();

    fireEvent.click(rail("Approve"));
    expect(approve().disabled).toBe(true);
    expect(screen.getByText(/Enter your name/)).toBeTruthy();
    fireEvent.click(rail("Plan"));

    fireEvent.change(screen.getByRole("textbox", { name: "Answer 1" }), {
      target: { value: "Yes, default to true" },
    });
    expect(screen.getByText("Save your edits before approval.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Answer 2" }), {
      target: { value: "The existing filter is enough" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save plan revision" }));
    await waitFor(() => {
      expect(screen.getByText("Saved successfully.")).toBeTruthy();
    });
    expect(screen.getAllByText("Answered")).toHaveLength(2);
    expect(api).toHaveBeenCalledWith(
      "/pairs/sep/gaps/gap-1/plan",
      "POST",
      expect.objectContaining({
        questions: [
          {
            question: "Should the default be true?",
            answer: "Yes, default to true",
          },
          {
            question: "Is the existing branch filter enough?",
            answer: "The existing filter is enough",
          },
        ],
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review plan →" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Ada" },
    });
    await waitFor(() => expect(approve().disabled).toBe(false));

    fireEvent.click(rail("Plan"));
    fireEvent.change(screen.getByRole("textbox", { name: "Answer 2" }), {
      target: { value: "   " },
    });
    expect(screen.getByText("Save your edits before approval.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save plan revision" }));
    await waitFor(() => {
      expect(screen.getByText("Answer every open question, then save, before approval.")).toBeTruthy();
    });
    expect(screen.getByText("Needs answer")).toBeTruthy();
    fireEvent.click(rail("Approve"));
    expect(approve().disabled).toBe(true);
  });
});
