import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PROVIDER_LABELS, isModelProvider, modelsForProvider } from "../src/modelProviders.js";

test("model picker includes the requested provider families without Mistral", () => {
  assert.equal(MODEL_PROVIDER_LABELS["meta-muse"], "Meta Muse");
  for (const provider of ["qwen", "z-ai", "moonshotai", "x-ai"]) assert.equal(isModelProvider(provider), true);
  assert.equal(isModelProvider("mistralai"), false);
});

test("Meta category limits results to the Muse family", () => {
  const models = [
    { id: "meta/muse-spark-1.3", name: "Muse Spark 1.3" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Legacy Meta" },
    { id: "qwen/qwen3.8-max", name: "Qwen" },
  ];
  assert.deepEqual(modelsForProvider(models, "meta-muse").map((model) => model.id), [
    "meta/muse-spark-1.2-contributor", "meta/muse-spark-1.3",
  ]);
  assert.deepEqual(modelsForProvider(models, "qwen").map((model) => model.id), ["qwen/qwen3.8-max"]);
});
