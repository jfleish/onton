export const STUDIO_ADAPTER_VERSION = "1.0" as const;

export type TaskStatus = "done" | "running" | "queued" | "blocked";
export type AgentStatus = "working" | "waiting" | "idle" | "blocked";

export interface StudioTask {
  id: string;
  title: string;
  owner: string;
  status: TaskStatus;
  dependsOn: string[];
  progress: number;
  detail: string;
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

export type AdapterMode = "local" | "simulated";
export type RunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface StudioSnapshot {
  version: typeof STUDIO_ADAPTER_VERSION;
  mode: AdapterMode;
  project: { root: string; name: string; branch: string; dirty: boolean; updatedAt: string; gameplanPath: string | null };
  tasks: StudioTask[];
  agents: StudioAgent[];
  events: StudioEvent[];
  transcripts: Record<string, string[]>;
  run: { id: string | null; status: RunStatus; startedAt: string | null; endedAt: string | null };
}

export interface StudioAdapter {
  readonly version: typeof STUDIO_ADAPTER_VERSION;
  getSnapshot(): Promise<StudioSnapshot>;
  runSimulation(): Promise<StudioSnapshot>;
  stopRun(): Promise<StudioSnapshot>;
  onEvent(listener: (event: StudioEvent) => void): () => void;
}

declare global {
  interface Window {
    ontonStudio: StudioAdapter & { adapterVersion: typeof STUDIO_ADAPTER_VERSION };
  }
}

export {};
