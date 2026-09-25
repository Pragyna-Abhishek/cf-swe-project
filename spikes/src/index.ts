// Phase 0 spikes that can only be answered on the target account.
//
// 0.1  GET  /model/probe             one tiny JSON-mode call; the driver script repeats it to find the 429 point
// 0.2  GET  /cpu?transport=rpc|fetch&iters=N&times=K
//                                    the Worker calls the Durable Object K times in sequence; each call burns N
//                                    loop iterations. If K calls succeed where one call of K*N fails, that
//                                    transport refreshes the CPU budget per call.
//      GET  /cpu/ws (WebSocket)      each message "N" burns N iterations and replies "ok"
// 0.4  POST /model/run               body {system, user, schema}; returns the raw model response and wall time.
//                                    The driver builds prompts and verifies outputs locally with the real core.

import { DurableObject } from "cloudflare:workers";
import { classifyError, toResponse } from "../../src/model/workers-ai";

type Env = { BURNER: DurableObjectNamespace<Burner>; AI: Ai; MODEL_ID: string };

/** A loop the optimizer cannot delete. Returns a value so the work is observable. */
function burn(iters: number): number {
  let x = 0x12345678;
  for (let i = 0; i < iters; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
  }
  return x >>> 0;
}

export class Burner extends DurableObject<Env> {
  burnRpc(iters: number): number {
    return burn(iters);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const iters = Number(new URL(request.url).searchParams.get("iters") ?? "0");
    return new Response(String(burn(iters)));
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const iters = Number(typeof message === "string" ? message : "0");
    ws.send(`ok ${burn(iters)}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.BURNER.get(env.BURNER.idFromName("spike"));

    if (url.pathname === "/cpu/ws") return stub.fetch(request);

    if (url.pathname === "/cpu") {
      const transport = url.searchParams.get("transport") ?? "rpc";
      const iters = Number(url.searchParams.get("iters") ?? "0");
      const times = Number(url.searchParams.get("times") ?? "1");
      const results: string[] = [];
      try {
        for (let i = 0; i < times; i++) {
          if (transport === "fetch") {
            const r = await stub.fetch(`https://burner/?iters=${iters}`);
            results.push(await r.text());
          } else {
            results.push(String(await stub.burnRpc(iters)));
          }
        }
        return Response.json({ ok: true, transport, iters, times, completed: results.length });
      } catch (e) {
        return Response.json({
          ok: false,
          transport,
          iters,
          times,
          completed: results.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (url.pathname === "/model/probe") {
      const t0 = Date.now();
      try {
        const result = await env.AI.run(env.MODEL_ID as keyof AiModels, {
          messages: [{ role: "user", content: 'Reply with {"ok": true}' }],
          response_format: { type: "json_schema", json_schema: { type: "object", properties: { ok: { type: "boolean" } } } },
          max_tokens: 16,
        } as never);
        return Response.json({ response: toResponse(result), ms: Date.now() - t0 });
      } catch (e) {
        return Response.json({ response: classifyError(e), ms: Date.now() - t0 });
      }
    }

    if (url.pathname === "/model/run" && request.method === "POST") {
      const body = (await request.json()) as { system: string; user: string; schema: object };
      const t0 = Date.now();
      try {
        const result = await env.AI.run(env.MODEL_ID as keyof AiModels, {
          messages: [
            { role: "system", content: body.system },
            { role: "user", content: body.user },
          ],
          response_format: { type: "json_schema", json_schema: body.schema },
          max_tokens: 1024,
          temperature: 0,
        } as never);
        return Response.json({ response: toResponse(result), ms: Date.now() - t0 });
      } catch (e) {
        return Response.json({ response: classifyError(e), ms: Date.now() - t0 });
      }
    }

    return new Response("portcullis spikes: see docs/spikes.md", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
