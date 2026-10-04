// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Setup, FirstRun } from "../packages/web/src/Setup.js";
import { api } from "../packages/web/src/api.js";

const { addJob, notify } = vi.hoisted(() => ({
  addJob: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../packages/web/src/api.js", async (original) => ({
  ...(await original<typeof import("../packages/web/src/api.js")>()),
  api: vi.fn(),
}));
vi.mock("../packages/web/src/AppShell.js", async (original) => ({
  ...(await original<typeof import("../packages/web/src/AppShell.js")>()),
  useWorkspace: () => ({ addJob, notify }),
}));
const pair = {
  id: "fixture",
  name: "Fixture",
  source: { ref: "main" },
  target: { ref: "target" },
};
let bound: boolean;
let ready: boolean;
let failSave: boolean;

beforeEach(() => {
  bound = false;
  ready = true;
  failSave = false;
  vi.mocked(api).mockImplementation(async (url) => {
    if (url === "/pairs")
      return {
        pairs: [pair],
        binding: {
          defaultProvider: "cursor",
          pairs: bound
            ? { fixture: { sourcePath: "C:\\repo", targetPath: "C:\\repo" } }
            : {},
        },
      };
    if (url === "/providers")
      return [
        {
          provider: "cursor",
          available: true,
          authentication: ready ? "authenticated" : "unknown",
        },
      ];
    if (url === "/setup/folder") return { path: null };
    if (url === "/setup/inspect")
      return {
        source: ["main", "target"],
        target: ["main", "target"],
        pairHash: "hash",
      };
    if (url === "/setup/complete") {
      if (failSave)
        throw new Error("Baseline is not an ancestor of the source ref");
      return { saved: true, pairHash: "hash" };
    }
    if (url.endsWith("/analyze")) return { jobId: "job" };
    throw new Error(`Unexpected request ${url}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(firstRun = false) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={query}>
      <MemoryRouter initialEntries={[firstRun ? "/" : "/setup"]}>
        <Routes>
          <Route
            path="/"
            element={
              <FirstRun>
                <h1>Dashboard</h1>
              </FirstRun>
            }
          />
          <Route path="/setup" element={<Setup />} />
          <Route path="/pairs/:id" element={<h1>Pair decisions</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function connect() {
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Source repository"), {
    target: { value: "C:\\repo" },
  });
  fireEvent.click(
    screen.getByLabelText("Use the same repository for the target"),
  );
}
async function branches() {
  await connect();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Source branch");
}

describe("guided first run", () => {
  it("redirects new installations but leaves configured installations on the dashboard", async () => {
    mount(true);
    expect(
      await screen.findByRole("heading", { name: "Connect your repositories" }),
    ).toBeTruthy();
    cleanup();
    bound = true;
    mount(true);
    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeTruthy();
  });
  it("preserves paths when Browse is cancelled and starts analysis only after Save and analyze", async () => {
    mount();
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "Browse source" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByLabelText("Source repository") as HTMLInputElement).value,
    ).toBe("C:\\repo");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const save = await screen.findByRole("button", {
      name: "Save and analyze",
    });
    expect(
      vi.mocked(api).mock.calls.some(([url]) => url.endsWith("/analyze")),
    ).toBe(false);
    fireEvent.click(save);
    await screen.findByRole("heading", { name: "Pair decisions" });
    expect(api).toHaveBeenCalledWith(
      "/setup/complete",
      "POST",
      expect.objectContaining({
        sourcePath: "C:\\repo",
        targetPath: "C:\\repo",
      }),
    );
    expect(addJob).toHaveBeenCalledWith("job");
  });
  it("requires acknowledgement for shared branch edits and retains validation errors in the guide", async () => {
    mount();
    await branches();
    fireEvent.change(screen.getByLabelText("Target branch"), {
      target: { value: "main" },
    });
    const save = screen.getByRole("button", {
      name: "Save and analyze",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText(
        "I understand that pending approvals may need to be renewed.",
      ),
    );
    expect(save.disabled).toBe(false);
    failSave = true;
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText("Baseline is not an ancestor of the source ref"),
    ).toBeTruthy();
    expect(addJob).not.toHaveBeenCalled();
  });
  it("does not enable analysis when Cursor authentication is unknown", async () => {
    ready = false;
    mount();
    await branches();
    expect(
      (
        screen.getByRole("button", {
          name: "Save and analyze",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    ready = true;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Save and analyze",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
});
