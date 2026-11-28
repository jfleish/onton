import assert from "node:assert/strict";
import test from "node:test";
import { layoutTasks } from "../dist/graph.js";

const task = (id, dependsOn = []) => ({ id, title: id, owner: id, status: "queued", dependsOn, progress: null, detail: "", agentId: null, commit: null });

test("layout handles empty and singleton plans", () => {
  assert.equal(layoutTasks([]).size, 0);
  assert.deepEqual(layoutTasks([task("task-a")]).get("task-a"), { x: 40, y: 45 });
});

test("layout preserves independent branches and fan-in layers", () => {
  const points = layoutTasks([task("task-a"), task("task-b"), task("task-c", ["task-a", "task-b"]), task("task-d", ["task-c"]) ]);
  assert.equal(points.get("task-a").x, points.get("task-b").x);
  assert.ok(points.get("task-c").x > points.get("task-a").x);
  assert.ok(points.get("task-d").x > points.get("task-c").x);
});

test("layout remains total for missing and cyclic dependencies", () => {
  const points = layoutTasks([task("task-a", ["task-missing"]), task("task-b", ["task-c"]), task("task-c", ["task-b"]) ]);
  assert.equal(points.size, 3);
  for (const point of points.values()) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});
