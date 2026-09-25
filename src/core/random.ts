// Seeded, dependency-free randomness and hashing.
//
// Every request draws from its own generator seeded by (scenario seed, request index). That
// makes generation order-free: chunk 3 can be generated before chunk 1, or twice, and the
// bytes are identical. The chunk driver relies on this.

/** 32-bit integer mixer (the finalizer from MurmurHash3). */
export function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A small, fast generator. Not cryptographic, and does not need to be. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Index into `weights`, chosen with probability proportional to each weight. */
  weighted(weights: readonly number[], total: number): number {
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] ?? 0;
      if (r < w) return i;
      r -= w;
    }
    return weights.length - 1;
  }
}

/** Generator for one request, independent of every other request. */
export function rngForRequest(seed: number, index: number): Rng {
  return new Rng(mix32(mix32(seed) ^ Math.imul(index + 1, 0x9e3779b9)));
}

/**
 * FNV-1a over bytes, run twice with different offsets to get 64 bits of output.
 * Used for traffic digests: identity and change detection, not security.
 */
export function digestBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x01000193) ^ (b >>> 15);
  }
  return hex32(mix32(a)) + hex32(mix32(b));
}

export function digestString(s: string): string {
  return digestBytes(new TextEncoder().encode(s));
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}
