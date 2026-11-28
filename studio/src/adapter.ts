export const STUDIO_ADAPTER_VERSION = "1.0" as const;

export type TaskStatus = "done" | "running" | "queued" | "blocked" | "failed" | "cancelled";
export type AgentStatus = "working" | "waiting" | "idle" | "blocked" | "failed" | "cancelled";

export interface StudioTask {
  id: string;
  title: string;
  owner: string;
  status: TaskStatus;
  dependsOn: string[];
  progress: number | null;
  detail: string;
  agentId: string | null;
  commit: string | null;
}

export interface StudioAgent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  taskId: string | null;
  accent: string;
  lastEvent: string;
}

export interface StudioEvent {
  id: string;
  time: string;
  kind: "system" | "agent" | "approval" | "milestone";
  title: string;
  detail: string;
  agentId?: string;
}

export type AdapterMode = "local" | "simulated" | "real";
export type RunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
export type StudioBackend = "claude" | "codex" | "opencode" | "pi" | "gemini";
export type StudioForge = "auto" | "github" | "sourcehut" | "local";

export interface StudioGameplan { name: string; path: string; selected: boolean; }
export interface StudioRecentProject { root: string; lastUsed: string; }
export interface StudioConfig { backend: StudioBackend; forge: StudioForge; mainBranch: string; maxConcurrency: number; }
export interface StudioDependencies { git: boolean; codex: boolean; codexAuthenticated: boolean; }
export interface StudioSnapshot {
  version: typeof STUDIO_ADAPTER_VERSION;
  mode: AdapterMode;
  realEnabled: boolean;
  project: { root: string; name: string; branch: string; dirty: boolean; updatedAt: string; gameplanPath: string | null; backend: StudioBackend };
  gameplan: Record<string, unknown> | null;
  gameplans: StudioGameplan[];
  recents: StudioRecentProject[];
  config: StudioConfig;
  dependencies: StudioDependencies;
  error: string | null;
  tasks: StudioTask[];
  agents: StudioAgent[];
  events: StudioEvent[];
  transcripts: Record<string, string[]>;
  artifacts: Record<string, string[]>;
  commits: string[];
  run: { id: string | null; status: RunStatus; startedAt: string | null; endedAt: string | null; pid?: number; controlPath?: string; dataDir?: string; fenceReason?: string };
}

export interface StudioAdapter {
  readonly version: typeof STUDIO_ADAPTER_VERSION;
  getSnapshot(): Promise<StudioSnapshot>;
  chooseProject(): Promise<StudioSnapshot>;
  chooseGameplan(): Promise<StudioSnapshot>;
  chooseBackend(): Promise<StudioSnapshot>;
  openRecent(projectRoot: string): Promise<StudioSnapshot>;
  saveConfig(patch: Partial<StudioConfig>): Promise<StudioSnapshot>;
  saveGameplan(document: Record<string, unknown>): Promise<StudioSnapshot>;
  validateGameplan(file: string): Promise<StudioSnapshot>;
  runReal(): Promise<StudioSnapshot>;
  stopRun(): Promise<StudioSnapshot>;
  onEvent(listener: (snapshot: StudioSnapshot) => void): () => void;
}

declare global {
  interface Window {
    ontonStudio: StudioAdapter & { adapterVersion: typeof STUDIO_ADAPTER_VERSION };
  }
}

export {};
