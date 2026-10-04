import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./AppShell.js";
import { Dashboard } from "./Dashboard.js";
import { Settings } from "./Settings.js";
import { PairPage } from "./PairPage.js";
import { GapPage } from "./GapPage.js";
import { FirstRun, Setup } from "./Setup.js";
import "./style.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route
            path="/"
            element={
              <FirstRun>
                <Dashboard />
              </FirstRun>
            }
          />
          <Route path="/setup" element={<Setup />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/pairs/:id" element={<PairPage />} />
          <Route path="/pairs/:id/gaps/:gapId" element={<GapPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
