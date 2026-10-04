// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JobTray } from "../packages/web/src/JobCenter.js";
import type { Job } from "../packages/web/src/types.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const current = this.listeners.get(type) || [];
    current.push(listener as (event: MessageEvent) => void);
    this.listeners.set(type, current);
  }
  emit(type: string, value: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(value) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeEventSource.instances = [];
});

describe("job activity tray", () => {
  it("updates from SSE without periodic job GETs and closes at completion", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <JobTray ids={["job-1"]} onDismiss={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe("/api/jobs/job-1/events");
    const job: Job = {
      id: "job-1",
      kind: "analyze",
      pairId: "pair",
      status: "running",
      events: [],
      interactions: [],
    };
    act(() => stream.emit("snapshot", job));
    expect(screen.getByText("running")).toBeTruthy();
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(5000));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() =>
      stream.emit("update", {
        seq: 1,
        event: {
          at: new Date().toISOString(),
          type: "done",
          data: { complete: true },
        },
        state: {
          ...job,
          status: "done",
          result: { complete: true },
          events: undefined,
        },
      }),
    );
    expect(stream.closed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("traps focus in the activity dialog and returns it on Escape", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <JobTray ids={["job-1"]} onDismiss={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const toggle = screen.getByRole("button", { name: /Activity/ });
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog", { name: "Activity" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("shows job-specific activity and hides protocol names from the timeline", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn());
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <JobTray ids={["job-1"]} onDismiss={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const job: Job = {
      id: "job-1",
      kind: "implement",
      pairId: "pair",
      gapId: "gap",
      status: "running",
      events: [
        {
          at: "2026-10-04T12:00:00.000Z",
          type: "queued",
          data: {
            activity: "queued",
            summary: "Implementation queued",
            objective: "Implement the approved plan in a worktree",
          },
        },
        {
          at: "2026-10-04T12:00:01.000Z",
          type: "activity",
          data: { activity: "operation", summary: "Editing src/app.ts" },
        },
        {
          at: "2026-10-04T12:00:02.000Z",
          type: "activity",
          data: { activity: "operation", summary: "Editing src/app.ts" },
        },
        {
          at: "2026-10-04T12:00:03.000Z",
          type: "technical",
          data: { activity: "technical", rawType: "session/update" },
        },
      ],
      interactions: [
        {
          id: "ask",
          type: "cursor/create_plan",
          params: { plan: "Add the flag", overview: "Agent plan" },
        },
      ],
    };
    act(() => FakeEventSource.instances[0].emit("snapshot", job));
    const toggle = screen.getByRole("button", { name: /Activity/ });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    const timeline = document.querySelector(".activity-list");
    expect(timeline?.textContent).toContain("Editing src/app.ts");
    expect(timeline?.textContent).toContain("×2");
    expect(timeline?.textContent).not.toContain("session/update");
    expect(timeline?.textContent).not.toContain("session · update");
    expect(screen.getAllByText("Implement the approved plan in a worktree").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Editing src/app.ts ×2").length).toBeGreaterThan(0);
    expect(screen.getByText(/not workbench approval/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Allow agent to execute" }),
    ).toBeTruthy();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(document.querySelector(".technical-list")?.textContent).toContain(
      "session/update",
    );
  });

  it("distinguishes validation progress, quiet checks, reconnects, and failure", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <JobTray ids={["job-1"]} onDismiss={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const stream = FakeEventSource.instances[0];
    const job: Job = {
      id: "job-1",
      kind: "validate",
      pairId: "pair",
      status: "running",
      events: [
        {
          at: "2026-10-04T12:00:00.000Z",
          type: "validation-progress",
          data: {
            activity: "progress",
            summary: "Check 2 of 5: production build",
            progress: {
              index: 1,
              total: 5,
              name: "production build",
              phase: "running",
              completed: 1,
              blocking: true,
            },
          },
        },
      ],
      interactions: [],
    };
    act(() => stream.emit("snapshot", job));
    fireEvent.click(screen.getByRole("button", { name: /Activity/ }));
    expect(screen.getAllByText("Check 2 of 5: production build").length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "1",
    );
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(21000);
    });
    expect(screen.getByText(/still running/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/crash|stall/i);
    act(() => {
      stream.onerror?.();
    });
    expect(screen.getAllByText(/Reconnecting/).length).toBeGreaterThan(0);
    act(() =>
      stream.emit("update", {
        seq: 2,
        event: {
          at: "2026-10-04T12:00:30.000Z",
          type: "failed",
          data: {
            activity: "outcome",
            summary: "Validation finished with 2 failed checks",
            error: "production build failed",
            recovery: "Fix the failed checks and run validation again.",
          },
        },
        state: {
          ...job,
          status: "failed",
          error: "production build failed",
        },
      }),
    );
    expect(
      screen.getAllByRole("alert").some((item) =>
        /production build failed/.test(item.textContent || ""),
      ),
    ).toBe(true);
    expect(
      screen.getAllByText("Validation finished with 2 failed checks").length,
    ).toBeGreaterThan(0);
  });
});
