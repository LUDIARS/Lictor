import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingTask } from "../src/concordia-types.js";
import { refreshPendingTasksSkill } from "../src/pending-tasks.js";
import { PendingStatInstructions } from "../src/pending-stat-instructions.js";

test("pending skill guides only truncated periodic status requests to their full instructions", async () => {
  const long = "状況を報告してください。".repeat(30);
  const atLimit = "x".repeat(200 - JSON.stringify({ trigger: "interval", instructions: "" }).length);
  const tasks: PendingTask[] = [
    { id: "1", kind: "stat-collect", payload: { trigger: "interval", instructions: long } },
    { id: "2", kind: "stat-collect", payload: { trigger: "idle", instructions: long } },
    { id: "3", kind: "stat-collect", payload: { trigger: "interval", instructions: atLimit } },
    { id: "4", kind: "stat-collect", payload: { trigger: "manual", instructions: long } },
    { id: "5", kind: "chat-reply", payload: { trigger: "interval", instructions: long } },
    { id: "6", kind: "stat-collect", payload: { trigger: "idle", instructions: "a".repeat(32769) } },
    { id: "7", kind: "stat-collect" },
  ];
  const instructions = new PendingStatInstructions();
  let skill = "";
  let pending = tasks;
  const client = { async pendingTasks(id: string) {
    assert.equal(id, "own-session");
    return { tasks: pending };
  } };
  const injector = { writeSkill(name: string, content: string) {
    assert.equal(name, "lictor-pending-tasks");
    skill = content;
  } };

  assert.equal(await refreshPendingTasksSkill(client, "own-session", injector, instructions), tasks.length);
  const previews = skill.split("\n").filter(line => line.startsWith("   payload: "));
  assert.deepEqual(previews, tasks.slice(0, -1).map(task => {
    const json = JSON.stringify(task.payload);
    return "   payload: " + (json.length > 200 ? json.slice(0, 199) + "…" : json);
  }));
  assert.deepEqual(
    [...skill.matchAll(/LICTOR_PORT.*GET \/v1\/pending-tasks\/stat-collect\/(\d+)/g)].map(match => match[1]),
    ["1", "2"],
  );
  assert.doesNotMatch(skill, new RegExp(long));
  assert.equal(instructions.get("1"), long);
  assert.equal(instructions.get("2"), long);
  for (const id of ["3", "4", "5", "6", "7"]) assert.equal(instructions.get(id), undefined);

  pending = [];
  await refreshPendingTasksSkill(client, "own-session", injector, instructions);
  assert.match(skill, /No pending tasks/);
  assert.equal(instructions.get("1"), long);
  assert.equal(new PendingStatInstructions().get("1"), undefined);
});

test("periodic instruction storage retains only the latest 20 task IDs", () => {
  const instructions = new PendingStatInstructions();
  for (let number = 1; number <= 21; number++) {
    const id = String(number);
    instructions.remember({ id, kind: "stat-collect", payload: { trigger: "idle", instructions: id } });
  }
  assert.equal(instructions.get("1"), undefined);
  assert.equal(instructions.get("2"), "2");
  assert.equal(instructions.get("21"), "21");
});
