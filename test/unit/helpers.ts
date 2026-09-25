import { findScenario, type ScenarioDefinition } from "../../src/core/scenarios";

export function trapScenario(): ScenarioDefinition {
  const def = findScenario("cs-trap-carrier");
  if (!def) throw new Error("trap scenario missing from registry");
  return def;
}

/** Same definition, smaller, so property tests stay fast. */
export function smallScenario(requestCount: number): ScenarioDefinition {
  const def = trapScenario();
  return { ...def, scenario: { ...def.scenario, requestCount } };
}
