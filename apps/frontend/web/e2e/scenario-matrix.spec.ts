import test from "node:test";
import assert from "node:assert/strict";
import { e2eScenarios } from "./scenarios.ts";

test("scenario matrix contains 20 adversarial cases", () => {
  assert.equal(e2eScenarios.length, 20);
});

test("seed subset matches the highest-signal acceptance gate", () => {
  const seedIds = e2eScenarios.filter((scenario) => scenario.seed).map((scenario) => scenario.id);
  assert.deepEqual(seedIds, [1, 3, 5, 7, 9, 11, 12, 15, 17, 20]);
});

test("every scenario has concrete setup and expected behavior", () => {
  for (const scenario of e2eScenarios) {
    assert.ok(scenario.setup.length > 10);
    assert.ok(scenario.expectedBehavior.length > 10);
    assert.ok(scenario.prompt.length > 5);
  }
});
