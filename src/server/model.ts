// Chooses the ModelClient from configuration. The only place MODEL_MODE is read.

import type { ModelClient } from "../model/client";
import { cannedModel } from "../model/fake";
import { WorkersAiModelClient } from "../model/workers-ai";

export function modelFor(env: Env): ModelClient {
  if (String(env.MODEL_MODE) === "fake") return cannedModel();
  return new WorkersAiModelClient(
    // The binding's run() is typed per model name; the client takes the model ID as data.
    { run: (model, inputs) => env.AI.run(model as keyof AiModels, inputs as never) },
    env.MODEL_ID,
  );
}
