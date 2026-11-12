// Run: node test.js
"use strict";
const assert = require("assert");
const { scanText, buildMatchers, notesFor } = require("./index.js");
const data = require("./data/prices.json");
const known = new Set(data.models.map((m) => m.id));
const re = buildMatchers(data.models);
const text = [
  'model="claude-haiku-4-5-20251001"',
  'a = "gemini-3.1-flash-lite"; b = "gemini-3.1-pro-preview"',
  'old = "gpt-4o"; r = "o3"',
  "run claude-code here",
  'x = "gpt-6.1-sol"',
].join("\n");
const r = scanText(text, re, known);
const ids = r.hits.map((h) => h.id);
assert.deepStrictEqual(ids, ["claude-haiku-4-5", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gpt-6.1-sol"]);
assert.deepStrictEqual(r.unknown.map((h) => h.id), ["gpt-4o", "o3"]);
const byId = Object.fromEntries(data.models.map((m) => [m.id, m]));
for (const m of data.models) for (const n of notesFor(m, data.models)) assert.ok(n.text.length > 10);
assert.ok(notesFor(byId["claude-haiku-4-5"], data.models).some((n) => n.kind === "legacy"));
const { estTokens, renderBudgets } = require("./index.js");
assert.strictEqual(estTokens("abcdefgh"), 2);
assert.ok(renderBudgets({ rows: [{ f: "p.md", before: 100, now: 150, growth: 50, ok: false }], fails: ["x"], priced: [] }, { maxTokens: 0, maxGrowth: 20, maxPrice: 0 }).includes("❌"));
console.log("ok", ids.length, "known,", r.unknown.length, "unknown");
