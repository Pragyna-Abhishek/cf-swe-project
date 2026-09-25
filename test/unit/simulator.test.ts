import { describe, expect, it } from "vitest";
import { planChunks } from "../../src/core/chunks";
import { chunkDigest, decodeTraffic, encodeTraffic, encodedSize, trafficDigest } from "../../src/core/codec";
import { decodeRequests } from "../../src/core/decode";
import { concatTraffic, generateAll, generateRange } from "../../src/core/simulator";
import { smallScenario, trapScenario } from "./helpers";

function digestOf(seed: number, chunkSize: number): string {
  const def = trapScenario();
  const digests = planChunks(def.scenario.requestCount, chunkSize).map((c) =>
    chunkDigest(encodeTraffic(generateRange(def, seed, c.start, c.count))),
  );
  return trafficDigest(digests);
}

describe("simulator", () => {
  it("is deterministic: the same seed gives an identical digest", () => {
    expect(digestOf(7, 1000)).toBe(digestOf(7, 1000));
  });

  it("different seeds give different traffic", () => {
    expect(digestOf(7, 1000)).not.toBe(digestOf(8, 1000));
  });

  it("chunks generated separately, in any order, equal one whole generation", () => {
    const def = smallScenario(2500);
    const whole = generateAll(def, 42);
    const plans = planChunks(2500, 700);
    const reversed = [...plans].reverse().map((p) => generateRange(def, 42, p.start, p.count));
    const joined = concatTraffic(reversed.reverse());
    expect(encodeTraffic(joined)).toEqual(encodeTraffic(whole));
  });

  it("produces requests in the scenario window, from the declared vocabulary", () => {
    const def = smallScenario(3000);
    const t = generateAll(def, 1);
    for (const r of decodeRequests(t)) {
      expect(r.offsetMs).toBeGreaterThanOrEqual(0);
      expect(r.offsetMs).toBeLessThan(def.scenario.durationMs);
      expect(["GET", "POST"]).toContain(r.method);
      expect(r.path.startsWith("/")).toBe(true);
    }
  });

  it("attack traffic only appears inside its active window", () => {
    const def = smallScenario(4000);
    const attack = def.populations.find((p) => p.label === "attack");
    if (!attack) throw new Error("no attack population");
    const from = attack.activeFrom * def.scenario.durationMs;
    for (const r of decodeRequests(generateAll(def, 3))) {
      if (r.label === "attack") expect(r.offsetMs).toBeGreaterThanOrEqual(from);
    }
  });

  it("clamps a range that runs past the end of the scenario", () => {
    const def = smallScenario(100);
    expect(generateRange(def, 1, 90, 50).count).toBe(10);
    expect(generateRange(def, 1, 100, 50).count).toBe(0);
  });

  it("rejects a negative or fractional range", () => {
    const def = smallScenario(100);
    expect(() => generateRange(def, 1, -1, 5)).toThrow(RangeError);
    expect(() => generateRange(def, 1, 0, 1.5)).toThrow(RangeError);
  });

  it("the trap is real: the carrier ASN carries both attack and legitimate traffic", () => {
    const rows = decodeRequests(generateAll(smallScenario(4000), 11));
    const carrier = rows.filter((r) => r.asn === 64500);
    expect(carrier.some((r) => r.label === "attack")).toBe(true);
    expect(carrier.some((r) => r.label === "legitimate")).toBe(true);
  });
});

describe("codec", () => {
  it("round-trips a chunk exactly", () => {
    const def = smallScenario(1234);
    const t = generateRange(def, 5, 0, 1234);
    const bytes = encodeTraffic(t);
    expect(bytes.byteLength).toBe(encodedSize(1234));
    const back = decodeTraffic(bytes, t.scenarioId, t.dictionary);
    if ("kind" in back) throw new Error(back.message);
    expect(decodeRequests(back)).toEqual(decodeRequests(t));
    expect(back.start).toBe(0);
    expect(back.seed).toBe(5);
  });

  it("round-trips a chunk that does not start at zero", () => {
    const def = smallScenario(3000);
    const t = generateRange(def, 5, 2000, 500);
    const back = decodeTraffic(encodeTraffic(t), t.scenarioId, t.dictionary);
    if ("kind" in back) throw new Error(back.message);
    expect(back.start).toBe(2000);
    expect(decodeRequests(back)[0]?.index).toBe(2000);
  });

  it("decodes from a Uint8Array at an unaligned offset", () => {
    const t = generateRange(smallScenario(100), 5, 0, 100);
    const bytes = encodeTraffic(t);
    const padded = new Uint8Array(bytes.byteLength + 1);
    padded.set(bytes, 1);
    const back = decodeTraffic(padded.subarray(1), t.scenarioId, t.dictionary);
    if ("kind" in back) throw new Error(back.message);
    expect(decodeRequests(back)).toEqual(decodeRequests(t));
  });

  it("rejects corrupt blobs with a structured error, not an exception", () => {
    const t = generateRange(smallScenario(10), 5, 0, 10);
    const bytes = encodeTraffic(t);
    expect(decodeTraffic(new Uint8Array(3), "x", t.dictionary)).toMatchObject({ kind: "decode-error" });
    const badMagic = bytes.slice();
    badMagic[0] = 0;
    expect(decodeTraffic(badMagic, "x", t.dictionary)).toMatchObject({ kind: "decode-error" });
    expect(decodeTraffic(bytes.slice(0, bytes.length - 1), "x", t.dictionary)).toMatchObject({
      kind: "decode-error",
    });
  });
});

describe("chunk planner", () => {
  it("covers the range exactly once", () => {
    expect(planChunks(2500, 1000)).toEqual([
      { index: 0, start: 0, count: 1000 },
      { index: 1, start: 1000, count: 1000 },
      { index: 2, start: 2000, count: 500 },
    ]);
    expect(planChunks(0, 1000)).toEqual([]);
  });

  it("rejects nonsense sizes", () => {
    expect(() => planChunks(10, 0)).toThrow(RangeError);
    expect(() => planChunks(-1, 10)).toThrow(RangeError);
  });
});
