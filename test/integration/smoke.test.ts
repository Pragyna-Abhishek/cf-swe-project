import { describe, expect, it } from "vitest";
import { agentNamed } from "./helpers";

describe("smoke", () => {
  it("generates traffic chunk by chunk through the callable", async () => {
    const agent = await agentNamed("smoke");
    let state = await agent.generateTrafficChunk();
    expect(state.chunksDone).toBe(1);
    while (state.status !== "ready") state = await agent.generateTrafficChunk();
    expect(state.chunksDone).toBe(state.chunksTotal);
    expect(state.digest).toMatch(/^[0-9a-f]{16}$/);
  });
});
