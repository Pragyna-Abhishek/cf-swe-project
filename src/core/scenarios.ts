// Scenario registry. Clients select a scenario by ID from this fixed list; they never supply a
// scenario definition. See DESIGN.md section 11, "Input and rate limits".

import type { HttpMethod, Scenario } from "./types";

type Weighted<T> = ReadonlyArray<readonly [T, number]>;

export type Route = {
  method: HttpMethod;
  path: string;
  weight: number;
  statuses: Weighted<number>;
};

/** One group of clients with a shared behavior. A scenario mixes several. */
export type Population = {
  name: string;
  label: "attack" | "legitimate";
  /** Share of all requests in the scenario that come from this population. */
  share: number;
  /** Active window as fractions of the scenario duration. */
  activeFrom: number;
  activeTo: number;
  routes: readonly Route[];
  asns: Weighted<number>;
  countries: Weighted<string>;
  userAgents: Weighted<string>;
};

export type ScenarioDefinition = {
  scenario: Scenario;
  populations: readonly Population[];
  /** Human-readable ASN names for display. Never used in evaluation. */
  asnNames: Readonly<Record<number, string>>;
};

// The request count and chunk size are set from the Phase 0 measurement in docs/spikes.md.
export const DEFAULT_REQUEST_COUNT = 6000;

const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  safariIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  shopApp: "MobileCoShop/3.2.1 (Android 14)",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  okhttpLower: "okhttp/4.9.3",
  okhttpMixed: "OkHttp/4.9.3",
  okhttpUpper: "OKHTTP/4.9.3",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/99.0.4844.51 Safari/537.36",
} as const;

/** The carrier ASN that attack and legitimate traffic share. This is the trap. */
export const CARRIER_ASN = 64500;

const credentialStuffingTrap: ScenarioDefinition = {
  scenario: {
    id: "cs-trap-carrier",
    title: "Credential stuffing through a mobile carrier",
    symptom: "login latency spiked and users are getting locked out",
    family: "credential-stuffing",
    isTrap: true,
    trapAttribute: "asn",
    seed: 20260925,
    requestCount: DEFAULT_REQUEST_COUNT,
    durationMs: 10 * 60 * 1000,
    thresholds: { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.03 },
  },
  populations: [
    {
      name: "customers",
      label: "legitimate",
      share: 0.72,
      activeFrom: 0,
      activeTo: 1,
      routes: [
        { method: "GET", path: "/", weight: 15, statuses: [[200, 1]] },
        { method: "GET", path: "/products", weight: 20, statuses: [[200, 1]] },
        { method: "GET", path: "/products/1042", weight: 5, statuses: [[200, 1]] },
        { method: "GET", path: "/products/2210", weight: 5, statuses: [[200, 1]] },
        { method: "GET", path: "/products/3307", weight: 5, statuses: [[200, 0.9], [404, 0.1]] },
        { method: "GET", path: "/products/4415", weight: 5, statuses: [[200, 1]] },
        { method: "GET", path: "/cart", weight: 8, statuses: [[200, 1]] },
        { method: "POST", path: "/cart", weight: 4, statuses: [[200, 0.97], [500, 0.03]] },
        { method: "GET", path: "/static/app.js", weight: 15, statuses: [[200, 0.6], [304, 0.4]] },
        { method: "GET", path: "/static/app.css", weight: 10, statuses: [[200, 0.6], [304, 0.4]] },
        { method: "POST", path: "/login", weight: 5, statuses: [[200, 0.88], [401, 0.12]] },
        { method: "GET", path: "/account", weight: 3, statuses: [[200, 1]] },
      ],
      asns: [
        [CARRIER_ASN, 0.45],
        [64501, 0.15],
        [64502, 0.12],
        [64503, 0.1],
        [64504, 0.08],
        [64505, 0.06],
        [64506, 0.04],
      ],
      countries: [
        ["US", 0.5],
        ["GB", 0.12],
        ["DE", 0.1],
        ["IN", 0.1],
        ["CA", 0.08],
        ["FR", 0.06],
        ["BR", 0.04],
      ],
      userAgents: [
        [UA.chromeWin, 0.25],
        [UA.safariIos, 0.22],
        [UA.chromeAndroid, 0.2],
        [UA.safariMac, 0.1],
        [UA.shopApp, 0.1],
        [UA.firefox, 0.08],
        [UA.edge, 0.05],
      ],
    },
    {
      name: "credential stuffers",
      label: "attack",
      share: 0.28,
      activeFrom: 0.3,
      activeTo: 1,
      routes: [
        {
          method: "POST",
          path: "/login",
          weight: 1,
          statuses: [
            [401, 0.95],
            [200, 0.03],
            [429, 0.02],
          ],
        },
      ],
      asns: [
        [CARRIER_ASN, 0.62],
        [64520, 0.2],
        [64521, 0.12],
        [64522, 0.06],
      ],
      countries: [
        ["US", 0.55],
        ["NL", 0.15],
        ["SG", 0.12],
        ["DE", 0.1],
        ["XX", 0.08],
      ],
      userAgents: [
        [UA.okhttpLower, 0.38],
        [UA.okhttpMixed, 0.22],
        [UA.okhttpUpper, 0.1],
        [UA.headless, 0.3],
      ],
    },
  ],
  asnNames: {
    [CARRIER_ASN]: "MobileCo Wireless",
    64501: "Metro Fiber",
    64502: "Cable One Home",
    64503: "EuroNet Broadband",
    64504: "Northern DSL",
    64505: "IndiaNet",
    64506: "Maple Telecom",
    64520: "CheapHost VPS",
    64521: "BulletCloud",
    64522: "ProxyFarm Ltd",
  },
};

export const SCENARIOS: readonly ScenarioDefinition[] = [credentialStuffingTrap];

export function findScenario(id: string): ScenarioDefinition | null {
  return SCENARIOS.find((d) => d.scenario.id === id) ?? null;
}

/** Scenario with a caller-chosen seed, validated. Seeds outside the range are rejected. */
export const MAX_SEED = 2 ** 31 - 1;

export function isValidSeed(seed: unknown): seed is number {
  return typeof seed === "number" && Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED;
}
