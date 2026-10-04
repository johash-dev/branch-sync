export type ProviderName = "codex" | "cursor" | "claude";
export type Command = { executable: string; args: string[] };
export type Pair = {
  version: 1;
  id: string;
  name: string;
  source: { remote: string; identity: string; ref: string };
  target: { remote: string; identity: string; ref: string };
  baseline: string;
  rules: string[];
  mappings: { source: string; target: string; note: string }[];
  intentionalDifferences: {
    behavior: string;
    reason: string;
    decidedBy: string;
  }[];
  validation: {
    install: Command | null;
    build: Command;
    tests: Command[];
    manual: string[];
  };
};
export type Binding = {
  version: 1;
  defaultProvider: ProviderName;
  pairs: Record<string, { sourcePath: string; targetPath: string }>;
};
export type Provider = {
  authentication?: "authenticated" | "unauthenticated" | "unknown";
  provider: ProviderName;
  available: boolean;
  version?: string;
  error?: string;
};
export type Requirement = {
  id: string;
  behavior: string;
  classification: string;
  rationale: string;
  sourceEvidence: string[];
  targetEvidence: string[];
  dependencies: string[];
  featureArea: string;
  groupKey?: string;
  impact?: string;
};
export type Gap = {
  id: string;
  pairId: string;
  sourceSubject: string;
  integrationSha: string;
  status: string;
  updatedAt: string;
  requirements: Requirement[];
  intentionalDecision?: { reason: string; decidedBy: string; at: string };
  noActionResolution?: {
    decidedBy: string;
    reason: string;
    at: string;
  };
};
export type Plan = {
  id?: string;
  sourceBehavior: string;
  targetBehavior: string;
  targetFiles: string[];
  approach: string;
  conventions: string[];
  dependencies: string[];
  regressionTests: string[];
  commands: Command[];
  manualScenarios: string[];
  questions: PlanQuestion[];
};
export type PlanQuestion = string | { question: string; answer: string };
export type Run = {
  stage: string;
  status: string;
  provider?: ProviderName;
  worktree: string;
  branch: string;
  checks: {
    name: string;
    status: string;
    output: string;
    blocking?: boolean;
  }[];
  manualResults: { scenario: string; status: string; notes: string }[];
  review?: { verdict: string; findings: string[]; at: string };
};
export type JobEvent = { at: string; type: string; data: any };
export type Job = {
  id: string;
  kind: string;
  pairId: string;
  gapId?: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  error?: string;
  result?: any;
  events: JobEvent[];
  interactions: { id: string; type: string; params: any }[];
};
export type PairHealth = {
  id: string;
  name: string;
  bound: boolean;
  snapshot?: {
    createdAt: string;
    sourceSha: string;
    targetSha: string;
    fetchedAt: string | null;
    offline: boolean;
    aiAssessedAt?: string;
    events: { sha?: string }[];
    coverage: { total: number; assessed: number; unprocessed: string[] };
  };
  gaps: number;
  portCandidates?: number;
  investigations?: number;
  awaitingIntegration: number;
  nextGap?: {
    id: string;
    title: string;
    status: string;
    needsInvestigation: boolean;
  } | null;
};
