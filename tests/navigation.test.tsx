// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "../packages/web/src/AppShell.js";
import { Dashboard } from "../packages/web/src/Dashboard.js";
import { PairPage } from "../packages/web/src/PairPage.js";
import { api } from "../packages/web/src/api.js";

vi.mock("../packages/web/src/api.js", async (original) => ({
  ...(await original<typeof import("../packages/web/src/api.js")>()),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("workspace navigation cues", () => {
  it("links an unbound pair to setup and shows the next gap status", async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/health")
        return {
          pairs: [
            {
              id: "sep",
              name: "SEP",
              bound: false,
              gaps: 0,
              awaitingIntegration: 0,
            },
            {
              id: "ready",
              name: "Ready",
              bound: true,
              gaps: 1,
              awaitingIntegration: 0,
              snapshot: {
                createdAt: "now",
                sourceSha: "a",
                targetSha: "b",
                fetchedAt: "now",
                offline: false,
                aiAssessedAt: "now",
                events: [{}],
                coverage: { total: 1, assessed: 1, unprocessed: [] },
              },
              nextGap: {
                id: "gap-1",
                title: "Gate deploys",
                status: "approved",
                needsInvestigation: false,
              },
            },
          ],
          jobs: [],
        };
      if (url === "/pairs")
        return {
          pairs: [],
          binding: { defaultProvider: "cursor", pairs: {} },
        };
      if (url === "/providers") return [{ provider: "cursor", available: true }];
      throw new Error(`Unexpected ${url}`);
    });
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const setup = await screen.findAllByRole("link", { name: /Set up pair/ });
    expect(setup.some((link) => link.getAttribute("href") === "/setup")).toBe(
      true,
    );
    expect(screen.getAllByText("Ready to implement").length).toBeGreaterThan(0);
    const continueGap = screen.getAllByRole("link", { name: /Continue gap/ });
    expect(
      continueGap.every((link) =>
        link.getAttribute("href")?.includes("stage=implement"),
      ),
    ).toBe(true);
  });

  it("links a pair decision to the stage for its status", async () => {
    const sha = "a".repeat(40);
    vi.mocked(api).mockImplementation(async (url) => {
      if (url === "/health")
        return {
          pairs: [
            {
              id: "ready",
              name: "Ready",
              bound: true,
              gaps: 1,
              awaitingIntegration: 0,
              snapshot: {
                createdAt: "2026-10-04T12:00:00.000Z",
                sourceSha: sha,
                targetSha: sha,
                fetchedAt: "2026-10-04T12:00:00.000Z",
                offline: false,
                aiAssessedAt: "2026-10-04T12:00:00.000Z",
                events: [{ sha }],
                coverage: { total: 1, assessed: 1, unprocessed: [] },
              },
              nextGap: {
                id: "gap-1",
                title: "Gate deploys",
                status: "approved",
                needsInvestigation: false,
              },
            },
          ],
          jobs: [],
        };
      if (url === "/pairs")
        return {
          pairs: [
            {
              id: "ready",
              name: "Ready",
              source: { remote: "origin", identity: "", ref: "main" },
              target: { remote: "origin", identity: "", ref: "main" },
            },
          ],
          binding: { defaultProvider: "cursor", pairs: {} },
        };
      if (url === "/providers") return [{ provider: "cursor", available: true }];
      if (url === "/pairs/ready/snapshot")
        return {
          snapshot: {
            createdAt: "2026-10-04T12:00:00.000Z",
            sourceSha: sha,
            targetSha: sha,
            fetchedAt: "2026-10-04T12:00:00.000Z",
            offline: false,
            aiAssessedAt: "2026-10-04T12:00:00.000Z",
            events: [{ sha }],
            coverage: { total: 1, assessed: 1, unprocessed: [] },
          },
          gaps: [
            {
              id: "gap-1",
              pairId: "ready",
              integrationSha: sha,
              sourceSubject: "Gate deploys",
              status: "approved",
              updatedAt: "2026-10-04T12:00:00.000Z",
              requirements: [
                {
                  id: "r1",
                  behavior: "Gate deploys",
                  classification: "missing",
                  rationale: "The target has no flag",
                  sourceEvidence: ["source:pipeline"],
                  targetEvidence: ["target:pipeline"],
                  dependencies: [],
                  featureArea: "pipeline",
                  impact: "Develop deploys",
                },
              ],
            },
          ],
        };
      throw new Error(`Unexpected ${url}`);
    });
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MemoryRouter initialEntries={["/pairs/ready"]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/pairs/:id" element={<PairPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const decision = await screen.findByRole("link", { name: /Gate deploys/ });
    expect(decision.getAttribute("href")).toContain("stage=implement");
    expect(screen.getByText("Ready to implement")).toBeTruthy();
  });
});
