import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAnswers } from "../src/contract.mjs";
import { validateEndpoint } from "../src/connect.mjs";
import { isFinalActionLabel, isSafeContinuationLabel } from "../src/fill.mjs";
import factory from "../tools/jevfiller.mjs";

function schemaNode() {
  const node = {};
  for (const method of ["optional", "url", "min", "int"]) node[method] = () => node;
  return node;
}

const fakePi = {
  zod: {
    string: schemaNode,
    number: schemaNode,
    boolean: schemaNode,
    unknown: schemaNode,
    object: () => schemaNode(),
    union: () => schemaNode(),
    record: () => schemaNode(),
  },
};

test("exports one Jevfiller tool", () => {
  assert.deepEqual(factory(fakePi).map((tool) => tool.name), ["jevfiller"]);
});

test("normalizes semantic keys to live field ids and protects sensitive fields", () => {
  const fields = [
    { id: "jev0", type: "text", label: "First name", required: true },
    { id: "jev1", type: "select", label: "Work authorization", required: true, options: ["Yes", "No"] },
  ];
  const result = normalizeAnswers(fields, { "First name": "Example Applicant", "Work authorization": "Yes" });
  assert.deepEqual(result.answers, { jev0: "Example Applicant" });
  assert.equal(result.issues[0].code, "needs-review");
});

test("rejects unknown endpoints and recognizes native endpoint forms", () => {
  assert.equal(validateEndpoint("ws://127.0.0.1:3000/playwright"), "ws://127.0.0.1:3000/playwright");
  assert.equal(validateEndpoint("http://127.0.0.1:9222/"), "http://127.0.0.1:9222/");
  assert.throws(() => validateEndpoint("career-ops"), /wsEndpoint or a Chrome CDP URL/);
  assert.throws(() => validateEndpoint("https://user:secret@example.test"), /not contain embedded credentials/);
});

test("allows only non-final continuation controls", () => {
  assert.equal(isSafeContinuationLabel("Next"), true);
  assert.equal(isSafeContinuationLabel("Save and continue"), true);
  assert.equal(isFinalActionLabel("Submit application"), true);
  assert.equal(isSafeContinuationLabel("Submit application"), false);
  assert.equal(isSafeContinuationLabel("Apply now"), false);
});
