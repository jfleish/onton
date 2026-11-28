import type { StudioTask } from "./adapter.js";

export interface GraphPoint { x: number; y: number; }

/** Deterministic layered layout; missing/cyclic dependencies stay on the first layer. */
export function layoutTasks(tasks: readonly StudioTask[]): Map<string, GraphPoint> {
  const ranks = new Map<string, number>();
  const visit = (id: string, trail = new Set<string>()): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    if (trail.has(id)) return 0;
    const item = tasks.find((task) => task.id === id);
    const next = new Set(trail).add(id);
    const rank = item?.dependsOn.length ? Math.max(...item.dependsOn.map((dep) => visit(dep, next))) + 1 : 0;
    ranks.set(id, rank);
    return rank;
  };
  tasks.forEach((task) => visit(task.id));
  const columns = new Map<number, StudioTask[]>();
  tasks.forEach((task) => { const rank = ranks.get(task.id) ?? 0; const column = columns.get(rank) ?? []; column.push(task); columns.set(rank, column); });
  const points = new Map<string, GraphPoint>();
  [...columns.entries()].sort(([a], [b]) => a - b).forEach(([rank, items]) => items.forEach((task, index) => points.set(task.id, { x: 40 + rank * 265, y: 45 + index * 132 })));
  return points;
}
