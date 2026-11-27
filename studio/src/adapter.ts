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

export interface StudioSnapshot {
  project: { name: string; branch: string; updatedAt: string };
  tasks: StudioTask[];
  agents: StudioAgent[];
  events: StudioEvent[];
  transcripts: Record<string, string[]>;
}

export interface StudioAdapter {
  readonly version: typeof STUDIO_ADAPTER_VERSION;
  getSnapshot(): Promise<StudioSnapshot>;
}

declare global {
  interface Window {
    ontonStudio: {
      adapterVersion: string;
      getSnapshot(): Promise<StudioSnapshot>;
    };
  }
}

export {};
