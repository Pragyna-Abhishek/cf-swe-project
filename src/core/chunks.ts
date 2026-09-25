// Chunk planning. Any work that could exceed one 10 ms CPU slice is split into chunks of at
// most CHUNK_SIZE requests, and each chunk is one separate incoming call into the Agent.
// CLAUDE.md invariant 7. The size is set from the Phase 0 measurement in docs/spikes.md.

export const CHUNK_SIZE = 500;

export type ChunkPlan = { index: number; start: number; count: number };

export function planChunks(total: number, size: number = CHUNK_SIZE): ChunkPlan[] {
  if (!Number.isInteger(total) || total < 0) throw new RangeError(`invalid total ${total}`);
  if (!Number.isInteger(size) || size <= 0) throw new RangeError(`invalid chunk size ${size}`);
  const out: ChunkPlan[] = [];
  for (let start = 0, index = 0; start < total; start += size, index++) {
    out.push({ index, start, count: Math.min(size, total - start) });
  }
  return out;
}
