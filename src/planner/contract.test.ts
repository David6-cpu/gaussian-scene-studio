import { describe, expect, it } from "vitest";
import { defaultRecipe } from "../recipe";
import { buildScene } from "../build";
import {
  parseProposal,
  preflightRecipe,
  preflight,
  proposalFromRecipe,
  toRecipe,
} from "./contract";

describe("strict planning boundary", () => {
  const valid = () => proposalFromRecipe(defaultRecipe);
  it("maps only the bounded planner fields, preserving visual defaults", () => {
    expect(toRecipe(parseProposal(valid()))).toEqual(defaultRecipe);
    expect(Object.keys(valid())).toHaveLength(8);
  });
  it.each([
    { path: "/tmp/a" },
    { recipeSource: "ollama" },
    { validation: "passed" },
    { spacing: 0.15 },
    { amplitude: NaN },
    { width: 100 },
    { seed: -1 },
    { octaves: 1.5 },
    { requested: { rock: 20, reed: 1 } },
    { requested: { rock: 0, reed: 0, bird: 1 } },
    { waterLevel: Infinity },
  ])("rejects illegal authority or budget: %j", (change) => {
    expect(() => parseProposal({ ...valid(), ...change })).toThrow();
  });
  it("rejects missing fields and nonobjects", () => {
    const { seed, ...missing } = valid();
    for (const value of [missing, null, [], "{}"])
      expect(() => parseProposal(value)).toThrow();
  });
  it("preflights the same scene and exposes impossible placement, without claiming ecology", () => {
    const proposal = { ...valid(), amplitude: 0, waterLevel: 0.5 };
    const flight = preflight(proposal),
      actual = buildScene(toRecipe(proposal));
    expect(flight.summary.ruleVersion).toBe("engineering-placement-v1");
    expect(flight.summary.accepted).toEqual(actual.report.accepted);
    expect(flight.summary.shortfall).toEqual({ rock: 10, reed: 10 });
    expect(flight.summary.rejections.water).toBeGreaterThan(0);
    expect(flight.warnings.join(" ")).toContain("20");
    expect(JSON.stringify(flight)).not.toContain("heights");
  });
  it("reports deterministic counts without time-dependent build evidence", () => {
    expect(preflight(valid())).toEqual(preflight(valid()));
  });
});

it("preflights the exact historical recipe including candidate sampling", () => {
  const recipe = { ...defaultRecipe, algorithmVersion: "f0-shore-v2" as const };
  expect(preflightRecipe(recipe).summary.activeSplats).toBe(
    buildScene(recipe).report.activeSplats,
  );
});
