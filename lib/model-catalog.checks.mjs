import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCandidates,
  eligibleModels,
  failureReason,
  POLICY,
  PRICE_REFERENCE,
  SelectionError,
  solPriceCeiling,
} from "./model-catalog.mjs";

function catalogModel(id = "vendor/new-model", overrides = {}) {
  return {
    id,
    created: 100,
    description: "Code reasoning model",
    context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["temperature", "max_tokens"],
    pricing: { prompt: "0.0000005", completion: "0.000002" },
    ...overrides,
  };
}

test("discovers previously unknown models from the live catalog within five cents", () => {
  const [model] = buildCandidates([catalogModel("new-provider/future-version")]);
  assert.equal(model.id, "new-provider/future-version");
  assert.equal(model.estimated_call_usd, 32000 * 0.0000005 + 8192 * 0.000002);
  assert.ok(model.estimated_call_usd < POLICY.maxCallUsd);
});
test("fresh Sol price caps comparable candidates and fails closed without the reference", () => {
  const profile = { inputTokens: 32000, outputTokens: 8192 };
  const sol = catalogModel(PRICE_REFERENCE, {
    pricing: { prompt: "0.000002", completion: "0.00001" },
  });
  const cheap = catalogModel("deepseek/new-flash", {
    pricing: { prompt: "0.00000003", completion: "0.0000005" },
  });
  const expensive = catalogModel("qwen/expensive", {
    pricing: { prompt: "0.000003", completion: "0.000015" },
  });
  const ceiling = solPriceCeiling([sol, cheap, expensive], profile);
  assert.equal(ceiling, 0.14592);
  assert.deepEqual(
    eligibleModels([sol, cheap, expensive], ceiling, profile).map((m) => m.id),
    [PRICE_REFERENCE, cheap.id],
  );
  assert.throws(() => solPriceCeiling([cheap], profile), /reference unavailable/);
  assert.equal(
    solPriceCeiling([{ ...sol, pricing: { prompt: "0.000001", completion: "0.000005" } }], profile),
    ceiling / 2,
  );
});

for (const [name, overrides] of Object.entries({
  expensive: { pricing: { prompt: "0.000003", completion: "0.000015" } },
  missingPrice: { pricing: {} },
  negativePrice: { pricing: { prompt: "-1", completion: "0" } },
  maliciousId: { id: "vendor/model\nINJECT=value" },
  shortContext: { context_length: 16000 },
  shortOutput: { top_provider: { max_completion_tokens: 1024 } },
  imageOnly: { architecture: { input_modalities: ["image"], output_modalities: ["image"] } },
  incompatible: { supported_parameters: ["temperature"] },
})) {
  test(`excludes ${name}`, () =>
    assert.deepEqual(buildCandidates([catalogModel(undefined, overrides)]), []));
}

test("accounts for request charges and rejects invalid budget", () => {
  assert.deepEqual(
    buildCandidates([
      catalogModel(undefined, { pricing: { prompt: "0", completion: "0", request: "0.06" } }),
    ]),
    [],
  );
  assert.throws(() => buildCandidates([], NaN));
  assert.throws(() => buildCandidates([], 0));
});

test("bounds the shortlist, retaining inexpensive older models alongside new ones", () => {
  const models = Array.from({ length: 80 }, (_, i) =>
    catalogModel(`vendor/model-${i}`, { created: i + 1 }),
  );
  models[0].pricing = { prompt: "0", completion: "0" };
  const shortlist = buildCandidates(models);
  assert.ok(shortlist.length <= 32);
  assert.ok(shortlist.some(({ id }) => id === "vendor/model-79"));
  assert.ok(shortlist.some(({ id }) => id === "vendor/model-0"));
});

test("diagnostics never disclose provider messages or input", () => {
  const secret = new Error("secret and private PR input");
  secret.status = 401;
  assert.equal(failureReason(secret).includes("secret"), false);
  assert.ok(failureReason(secret).includes("HTTP 401"));
  assert.equal(
    failureReason(new SelectionError("No sufficiently suitable reviewer.")),
    "No sufficiently suitable reviewer.",
  );
});

test("reasoning models without temperature remain eligible and retain compatibility metadata", () => {
  const [model] = buildCandidates([
    catalogModel("vendor/reasoning", {
      supported_parameters: ["max_completion_tokens", "reasoning"],
    }),
  ]);
  assert.equal(model.temperature_supported, false);
  assert.equal(model.reasoning_supported, true);
});

test("ambiguous versions and missing metadata fail closed", () => {
  const m = catalogModel();
  assert.deepEqual(eligibleModels([m, { ...m, created: 101 }]), []);
  assert.deepEqual(eligibleModels([{ ...m, created: undefined }]), []);
  assert.deepEqual(eligibleModels([{ ...m, supported_parameters: "max_tokens" }]), []);
  assert.deepEqual(eligibleModels([{ ...m, context_length: 32000 }]), []);
});

test("active context-price tiers cannot bypass the per-call ceiling", () => {
  const m = catalogModel();
  const expensive = {
    ...m,
    pricing: {
      ...m.pricing,
      overrides: [{ min_prompt_tokens: 32000, prompt: "0.000003", completion: "0.000015" }],
    },
  };
  assert.deepEqual(eligibleModels([expensive]), []);
  const futureTier = {
    ...m,
    pricing: {
      ...m.pricing,
      overrides: [{ min_prompt_tokens: 272000, prompt: "0.000003", completion: "0.000015" }],
    },
  };
  assert.equal(
    eligibleModels([futureTier])[0].estimated_call_usd,
    eligibleModels([m])[0].estimated_call_usd,
  );
  assert.deepEqual(
    eligibleModels([
      { ...m, pricing: { ...m.pricing, overrides: [{ min_prompt_tokens: "unknown" }] } },
    ]),
    [],
  );
});
