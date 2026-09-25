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
    symptomStatus: 401,
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

// ---------------------------------------------------------------------------
// Additional scenarios (Phase 4: 8 to 12 scenarios across the three families,
// at least 3 traps with different trapAttribute values). Built from shared
// building blocks rather than hand-duplicating the full population shape
// above, since the differences between scenarios are in a handful of fields
// (which attribute the attack shares with legitimate traffic, which ASNs and
// user agents it uses), not in the storefront browsing behavior itself.
// ---------------------------------------------------------------------------

const STOREFRONT_ROUTES: readonly Route[] = [
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
];

/** Ordinary browsing traffic. The shared baseline every scenario's "attack" population sits against. */
function legitimatePopulation(overrides: Partial<Population> = {}): Population {
  return {
    name: "customers",
    label: "legitimate",
    share: 0.75,
    activeFrom: 0,
    activeTo: 1,
    routes: STOREFRONT_ROUTES,
    asns: [
      [64530, 0.2],
      [64531, 0.16],
      [64532, 0.14],
      [64533, 0.12],
      [64534, 0.1],
      [64535, 0.08],
      [64536, 0.06],
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
    ...overrides,
  };
}

const ASN_NAMES: Readonly<Record<number, string>> = {
  64530: "Metro Fiber",
  64531: "Cable One Home",
  64532: "EuroNet Broadband",
  64533: "Northern DSL",
  64534: "IndiaNet",
  64535: "Maple Telecom",
  64536: "Lakeside Cable",
  64550: "CheapHost VPS",
  64551: "BulletCloud",
  64552: "ProxyFarm Ltd",
  64553: "NightOwl Hosting",
};

function scenario(
  overrides: Partial<Scenario> & Pick<Scenario, "id" | "title" | "symptom" | "family" | "isTrap" | "trapAttribute">,
): Scenario {
  return {
    seed: 20260925,
    requestCount: DEFAULT_REQUEST_COUNT,
    durationMs: 10 * 60 * 1000,
    // Credential-stuffing's symptom is failed logins (401). l7-flood and scraper scenarios
    // override this: their symptom is a different status code entirely (DESIGN.md's
    // TrafficSummary.symptomSlice is keyed by this, not hardcoded to 401).
    symptomStatus: 401,
    thresholds: { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.03 },
    ...overrides,
  };
}

// A trap needs its attack population's dominant value on the trapped dimension to be a value
// legitimate traffic also uses significantly, and concentrated enough that blocking it still
// catches most of the attack (otherwise the scenario just measures under-blocking, not
// collateral damage). An "easy" (non-trap) scenario needs the opposite: a dominant attack value
// disjoint from every legitimate value, so a naive single-attribute block is clean.

const credentialStuffingCountryTrap: ScenarioDefinition = {
  scenario: scenario({
    id: "cs-trap-country",
    title: "Credential stuffing concentrated in one country",
    symptom: "we're seeing a wave of failed logins and support tickets about locked accounts",
    family: "credential-stuffing",
    isTrap: true,
    trapAttribute: "country",
    seed: 20260926,
  }),
  populations: [
    legitimatePopulation({
      countries: [
        ["US", 0.6],
        ["GB", 0.1],
        ["DE", 0.08],
        ["CA", 0.08],
        ["IN", 0.07],
        ["FR", 0.04],
        ["BR", 0.03],
      ],
    }),
    {
      name: "credential stuffers",
      label: "attack",
      share: 0.26,
      activeFrom: 0.25,
      activeTo: 1,
      routes: [{ method: "POST", path: "/login", weight: 1, statuses: [[401, 0.95], [200, 0.03], [429, 0.02]] }],
      asns: [
        [64550, 0.4],
        [64551, 0.3],
        [64552, 0.2],
        [64553, 0.1],
      ],
      // Almost every attack request comes from the US, same as the majority of real customers:
      // blocking by country hits them too.
      countries: [["US", 0.97], ["CA", 0.03]],
      userAgents: [
        [UA.okhttpLower, 0.4],
        [UA.okhttpMixed, 0.2],
        [UA.headless, 0.4],
      ],
    },
  ],
  asnNames: ASN_NAMES,
};

const credentialStuffingUserAgentTrap: ScenarioDefinition = {
  scenario: scenario({
    id: "cs-trap-shopapp",
    title: "Credential stuffing through the mobile shopping app's own client",
    symptom: "app users can't log in and our fraud team is seeing a spike in failed logins",
    family: "credential-stuffing",
    isTrap: true,
    trapAttribute: "userAgent",
    seed: 20260927,
  }),
  populations: [
    legitimatePopulation({
      // The shopping app client is a meaningful share of real traffic here, not a rare edge case.
      userAgents: [
        [UA.shopApp, 0.35],
        [UA.chromeWin, 0.2],
        [UA.safariIos, 0.18],
        [UA.chromeAndroid, 0.15],
        [UA.safariMac, 0.07],
        [UA.firefox, 0.05],
      ],
    }),
    {
      name: "credential stuffers",
      label: "attack",
      share: 0.24,
      activeFrom: 0.3,
      activeTo: 1,
      routes: [{ method: "POST", path: "/login", weight: 1, statuses: [[401, 0.96], [200, 0.02], [429, 0.02]] }],
      asns: [
        [64550, 0.5],
        [64551, 0.3],
        [64552, 0.2],
      ],
      countries: [["US", 0.4], ["VN", 0.25], ["ID", 0.2], ["XX", 0.15]],
      // The attacker replays the shopping app's own client string to blend in, exclusively.
      userAgents: [[UA.shopApp, 1]],
    },
  ],
  asnNames: ASN_NAMES,
};

const credentialStuffingHostingEasy: ScenarioDefinition = {
  scenario: scenario({
    id: "cs-hosting-easy",
    title: "Credential stuffing from one datacenter ASN",
    symptom: "our login endpoint is getting hammered and people can't sign in",
    family: "credential-stuffing",
    isTrap: false,
    trapAttribute: null,
    seed: 20260928,
    thresholds: { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.1 },
  }),
  populations: [
    legitimatePopulation(),
    {
      name: "credential stuffers",
      label: "attack",
      share: 0.3,
      activeFrom: 0.2,
      activeTo: 1,
      routes: [{ method: "POST", path: "/login", weight: 1, statuses: [[401, 0.95], [200, 0.03], [429, 0.02]] }],
      // No legitimate customer traffic comes from these ASNs at all, and one dominates: easily
      // separable, and blocking just the top one catches nearly all of it.
      asns: [
        [64550, 0.92],
        [64551, 0.05],
        [64552, 0.03],
      ],
      countries: [["NL", 0.4], ["SG", 0.3], ["RU", 0.2], ["XX", 0.1]],
      userAgents: [
        [UA.okhttpLower, 0.5],
        [UA.okhttpUpper, 0.2],
        [UA.headless, 0.3],
      ],
    },
  ],
  asnNames: ASN_NAMES,
};

const SCRAPER_ROUTES: readonly Route[] = [
  { method: "GET", path: "/", weight: 10, statuses: [[200, 1]] },
  { method: "GET", path: "/products", weight: 15, statuses: [[200, 1]] },
  { method: "GET", path: "/products/1042", weight: 8, statuses: [[200, 1]] },
  { method: "GET", path: "/products/2210", weight: 8, statuses: [[200, 1]] },
  { method: "GET", path: "/products/3307", weight: 8, statuses: [[200, 0.9], [404, 0.1]] },
  { method: "GET", path: "/products/4415", weight: 8, statuses: [[200, 1]] },
  { method: "GET", path: "/static/app.js", weight: 12, statuses: [[200, 0.6], [304, 0.4]] },
  { method: "GET", path: "/static/app.css", weight: 8, statuses: [[200, 0.6], [304, 0.4]] },
  { method: "POST", path: "/login", weight: 3, statuses: [[200, 0.9], [401, 0.1]] },
  { method: "GET", path: "/account", weight: 3, statuses: [[200, 1]] },
];

/** Scraper's symptom: enumerating product IDs, most of which do not exist, returns HTTP 404. */
const SCRAPER_SYMPTOM_STATUS = 404;

const scraperAsnTrap: ScenarioDefinition = {
  scenario: scenario({
    id: "scr-trap-residential",
    title: "Scraper routed through the same residential ASNs as real shoppers",
    symptom: "our product pages are throwing a lot of not-found errors and origin load is way up",
    family: "scraper",
    isTrap: true,
    trapAttribute: "asn",
    seed: 20260929,
    symptomStatus: SCRAPER_SYMPTOM_STATUS,
    thresholds: { minAttackBlockedRate: 0.85, maxLegitimateBlockedRate: 0.04 },
  }),
  populations: [
    legitimatePopulation({ routes: SCRAPER_ROUTES }),
    {
      name: "scraper",
      label: "attack",
      share: 0.35,
      activeFrom: 0.1,
      activeTo: 1,
      // Enumerates sequential product IDs; almost all of them do not exist.
      routes: [
        { method: "GET", path: "/products/9001", weight: 1, statuses: [[404, 1]] },
        { method: "GET", path: "/products/9002", weight: 1, statuses: [[404, 1]] },
        { method: "GET", path: "/products/9003", weight: 1, statuses: [[404, 1]] },
        { method: "GET", path: "/products/1042", weight: 1, statuses: [[200, 1]] },
      ],
      // Routed through a residential proxy network on the same ASN real shoppers use.
      asns: [[64530, 0.93], [64550, 0.07]],
      countries: [["US", 0.5], ["SG", 0.3], ["XX", 0.2]],
      userAgents: [
        [UA.headless, 0.6],
        [UA.okhttpLower, 0.4],
      ],
    },
  ],
  asnNames: ASN_NAMES,
};

const scraperHostingEasy: ScenarioDefinition = {
  scenario: scenario({
    id: "scr-hosting-easy",
    title: "Scraper enumerating the catalog from one hosting range",
    symptom: "something is crawling our whole catalog nonstop and it's not one of our known bots",
    family: "scraper",
    isTrap: false,
    trapAttribute: null,
    seed: 20260930,
    symptomStatus: SCRAPER_SYMPTOM_STATUS,
    thresholds: { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.08 },
  }),
  populations: [
    legitimatePopulation({ routes: SCRAPER_ROUTES }),
    {
      name: "scraper",
      label: "attack",
      share: 0.3,
      activeFrom: 0,
      activeTo: 1,
      // No real customer touches these IDs, almost none of which exist.
      routes: [
        { method: "GET", path: "/products/9101", weight: 1, statuses: [[404, 1]] },
        { method: "GET", path: "/products/9102", weight: 1, statuses: [[404, 1]] },
        { method: "GET", path: "/products/9103", weight: 1, statuses: [[404, 1]] },
      ],
      asns: [[64550, 0.93], [64551, 0.07]],
      countries: [["SG", 0.5], ["NL", 0.3], ["XX", 0.2]],
      userAgents: [[UA.headless, 1]],
    },
  ],
  asnNames: ASN_NAMES,
};

const FLOOD_ROUTES: readonly Route[] = [
  { method: "GET", path: "/", weight: 1, statuses: [[200, 0.2], [503, 0.8]] },
];

/** l7-flood's symptom: the origin falls over under load and returns HTTP 503. */
const FLOOD_SYMPTOM_STATUS = 503;

const l7FloodCarrierTrap: ScenarioDefinition = {
  scenario: scenario({
    id: "l7-trap-carrier",
    title: "Layer 7 flood against the homepage, sharing a carrier ASN with real users",
    symptom: "the site is timing out for a lot of visitors and origin CPU is maxed out",
    family: "l7-flood",
    isTrap: true,
    trapAttribute: "asn",
    seed: 20260931,
    symptomStatus: FLOOD_SYMPTOM_STATUS,
    thresholds: { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.03 },
  }),
  populations: [
    legitimatePopulation({
      routes: STOREFRONT_ROUTES,
      asns: [
        [CARRIER_ASN, 0.4],
        [64530, 0.18],
        [64531, 0.14],
        [64532, 0.12],
        [64533, 0.09],
        [64534, 0.07],
      ],
    }),
    {
      name: "flooders",
      label: "attack",
      share: 0.4,
      activeFrom: 0.15,
      activeTo: 1,
      routes: FLOOD_ROUTES,
      // Botnet is almost entirely compromised phones on the same mobile carrier as real customers.
      asns: [[CARRIER_ASN, 0.95], [64550, 0.05]],
      countries: [["US", 0.4], ["BR", 0.2], ["VN", 0.2], ["XX", 0.2]],
      userAgents: [
        [UA.chromeAndroid, 0.3],
        [UA.okhttpLower, 0.4],
        [UA.headless, 0.3],
      ],
    },
  ],
  asnNames: { ...ASN_NAMES, [CARRIER_ASN]: "MobileCo Wireless" },
};

const l7FloodHostingEasy: ScenarioDefinition = {
  scenario: scenario({
    id: "l7-hosting-easy",
    title: "Layer 7 flood from open proxies",
    symptom: "we're getting flooded with homepage requests and the site is falling over",
    family: "l7-flood",
    isTrap: false,
    trapAttribute: null,
    seed: 20260932,
    symptomStatus: FLOOD_SYMPTOM_STATUS,
    thresholds: { minAttackBlockedRate: 0.9, maxLegitimateBlockedRate: 0.08 },
  }),
  populations: [
    legitimatePopulation({ routes: STOREFRONT_ROUTES }),
    {
      name: "flooders",
      label: "attack",
      share: 0.45,
      activeFrom: 0.1,
      activeTo: 1,
      routes: FLOOD_ROUTES,
      asns: [[64550, 0.92], [64551, 0.08]],
      countries: [["XX", 0.6], ["VN", 0.2], ["BR", 0.2]],
      userAgents: [[UA.headless, 1]],
    },
  ],
  asnNames: ASN_NAMES,
};

export const SCENARIOS: readonly ScenarioDefinition[] = [
  credentialStuffingTrap,
  credentialStuffingCountryTrap,
  credentialStuffingUserAgentTrap,
  credentialStuffingHostingEasy,
  scraperAsnTrap,
  scraperHostingEasy,
  l7FloodCarrierTrap,
  l7FloodHostingEasy,
];

export function findScenario(id: string): ScenarioDefinition | null {
  return SCENARIOS.find((d) => d.scenario.id === id) ?? null;
}

/** Scenario with a caller-chosen seed, validated. Seeds outside the range are rejected. */
export const MAX_SEED = 2 ** 31 - 1;

export function isValidSeed(seed: unknown): seed is number {
  return typeof seed === "number" && Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED;
}
