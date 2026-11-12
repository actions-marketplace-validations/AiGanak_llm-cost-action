// LLM Cost Check: finds OpenAI, Anthropic and Google model IDs in a repository and reports
// list prices, announced price rises, legacy or preview status and cheaper models in the same tier.
// No dependencies. Price data: github.com/AiGanak/llm-prices (CC BY 4.0), bundled copy as fallback.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DATA_URL = "https://cdn.jsdelivr.net/gh/AiGanak/llm-prices@main/data/prices.json";
const RETIRE_URL = "https://cdn.jsdelivr.net/gh/AiGanak/llm-prices@main/data/retirements.json";
const SITE = "https://aiganak.com";
const MARK = "<!-- llm-cost-check -->";
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|kts|swift|cs|php|scala|ex|exs|dart|lua|r|jl|sh|bash|zsh|ps1|ya?ml|json|jsonc|toml|ini|cfg|conf|env|properties|md|mdx|txt|ipynb|tf|hcl|sql|vue|svelte|astro|html)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.git|\.venv|venv|__pycache__)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|uv\.lock)$/;
// Model-like strings that are not in the price list. Claude names need a digit to avoid "claude-code" and similar.
const UNKNOWN_RE = /\b(gpt-\d[a-z0-9.\-]*|o\d(?:-(?:mini|pro|preview))?|claude-(?:[a-z]+-)*\d[a-z0-9.\-]*|gemini-\d[a-z0-9.\-]*)\b/gi;

const input = (name, def = "") => {
  const v = process.env["INPUT_" + name.replace(/ /g, "_").toUpperCase()];
  return v === undefined || v === "" ? def : v.trim();
};
const esc = (s) => String(s).replace(/[\\`*_|<>]/g, (c) => "\\" + c);
const usd = (n) => "$" + (Number.isInteger(n) ? n.toString() : Math.abs(n * 100 - Math.round(n * 100)) > 1e-9 ? n.toFixed(3) : n.toFixed(2));
const pct = (a, b) => Math.round(((b - a) / a) * 100);
const blended = (p) => (3 * p.input + p.output) / 4; // 3:1 input:output, a common chat mix
const money = (n) => "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));

async function loadRetirements() {
  try {
    const r = await fetch(RETIRE_URL, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.models)) return j.models; }
  } catch (e) { /* fall back */ }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "retirements.json"), "utf8")).models; } catch (e) { return []; }
}

async function loadPrices() {
  try {
    const r = await fetch(DATA_URL, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.models)) return { data: j, live: true }; }
  } catch (e) { /* fall back */ }
  return { data: JSON.parse(fs.readFileSync(path.join(__dirname, "data", "prices.json"), "utf8")), live: false };
}

function listFiles(root) {
  let files;
  try { files = execFileSync("git", ["ls-files", "-z", "--", root], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean); }
  catch (e) {
    files = [];
    const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) { if (!SKIP.test(p + "/")) walk(p); } else files.push(p); } };
    walk(root);
  }
  return files.filter((f) => TEXT_EXT.test(f) && !SKIP.test(f));
}

function buildMatchers(models) {
  // Longest IDs first so "gemini-3.1-flash-lite" wins over a shorter overlapping ID.
  const ids = models.map((m) => m.id).sort((a, b) => b.length - a.length);
  const re = new RegExp("(?<![a-z0-9.\\-])(" + ids.map((i) => i.replace(/[.]/g, "\\.")).join("|") + ")(?:-\\d{8}|-latest)?(?![a-z0-9.]|-[a-z])", "gi");
  return re;
}

function scanText(text, re, known) {
  const hits = []; const unknown = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.length > 2000) return;
    re.lastIndex = 0; let m; const seen = new Set();
    while ((m = re.exec(line))) { seen.add(m[1].toLowerCase()); hits.push({ id: m[1].toLowerCase(), line: i + 1 }); }
    UNKNOWN_RE.lastIndex = 0;
    while ((m = UNKNOWN_RE.exec(line))) {
      const raw = m[1].toLowerCase().replace(/-(\d{8}|latest)$/, "").replace(/[.\-]+$/, "");
      if (known.has(raw) || [...seen].some((s) => s.startsWith(raw) || raw.startsWith(s))) continue;
      if (/^o\d$/.test(raw) && !/["'`]o\d/.test(line)) continue; // bare "o1" only when quoted
      unknown.push({ id: raw, line: i + 1 });
    }
  });
  return { hits, unknown };
}

function notesFor(m, models) {
  const out = [];
  const std = m.pricing.standard;
  for (const c of m.scheduled_changes || []) {
    const n = c.standard;
    out.push({ kind: "price-increase", text: `Price ${n.input >= std.input ? "rises" : "changes"} on ${c.effective}: input ${usd(std.input)} → ${usd(n.input)}, output ${usd(std.output)} → ${usd(n.output)} per 1M tokens (${pct(std.input, n.input) >= 0 ? "+" : ""}${pct(std.input, n.input)}% input).` });
  }
  if (m.status === "legacy") out.push({ kind: "legacy", text: "Legacy model: the provider has a newer model in this tier." });
  if (m.status === "preview") out.push({ kind: "legacy", text: "Preview model: pricing and availability can change at short notice." });
  const cheaper = models.filter((x) => x.tier === m.tier && x.status === "active" && x.id !== m.id && !(x.scheduled_changes || []).length && blended(x.pricing.standard) < blended(std))
    .sort((a, b) => blended(a.pricing.standard) - blended(b.pricing.standard) || (b.provider === m.provider) - (a.provider === m.provider))[0];
  if (cheaper) out.push({ kind: "info", text: `Cheaper in the same tier: ${cheaper.provider} ${cheaper.name} at ${usd(cheaper.pricing.standard.input)} / ${usd(cheaper.pricing.standard.output)} per 1M tokens. Test quality on your task first.` });
  return out;
}

async function gh(token, method, url, body) {
  const r = await fetch("https://api.github.com" + url, { method, headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "user-agent": "llm-cost-check", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
}

async function prChanges(token, repo, num, re) {
  const added = new Set(), removed = new Set();
  for (let page = 1; page <= 10; page++) {
    const files = await gh(token, "GET", `/repos/${repo}/pulls/${num}/files?per_page=100&page=${page}`);
    for (const f of files) {
      if (!f.patch || SKIP.test(f.filename)) continue;
      for (const l of f.patch.split("\n")) {
        if (!/^[+-]/.test(l) || /^(\+\+\+|---)/.test(l)) continue;
        re.lastIndex = 0; let m;
        while ((m = re.exec(l))) (l[0] === "+" ? added : removed).add(m[1].toLowerCase());
      }
    }
    if (files.length < 100) break;
  }
  return { added: [...added].filter((x) => !removed.has(x)), removed: [...removed].filter((x) => !added.has(x)) };
}

function render({ found, unknown, byId, models, data, live, change, vol, retired = {} }) {
  const L = [MARK, "## LLM Cost Check", ""];
  if (!found.size && !unknown.size) { L.push("No OpenAI, Anthropic or Google model IDs found."); }
  if (change && (change.added.length || change.removed.length)) {
    L.push("### Changed in this pull request", "");
    const fmt = (id) => { const m = byId[id]; return `**${esc(m.name)}** (${usd(m.pricing.standard.input)} / ${usd(m.pricing.standard.output)})`; };
    if (change.removed.length && change.added.length) {
      for (const r of change.removed) for (const a of change.added) {
        const A = byId[r].pricing.standard, B = byId[a].pricing.standard;
        let line = `- ${fmt(r)} → ${fmt(a)}: input ${pct(A.input, B.input) >= 0 ? "+" : ""}${pct(A.input, B.input)}%, output ${pct(A.output, B.output) >= 0 ? "+" : ""}${pct(A.output, B.output)}%`;
        if (vol) { const ca = (vol.i * A.input + vol.o * A.output) / 1e6, cb = (vol.i * B.input + vol.o * B.output) / 1e6; line += `, about ${money(ca)} → ${money(cb)} a month at your stated volume`; }
        L.push(line);
      }
    } else {
      for (const a of change.added) L.push(`- Added ${fmt(a)}`);
      for (const r of change.removed) L.push(`- Removed ${fmt(r)}`);
    }
    L.push("");
  }
  if (found.size) {
    L.push("### Models in this code", "", "| Model | Input / output per 1M tokens | Where | Notes |", "|---|---|---|---|");
    for (const [id, locs] of [...found.entries()].sort()) {
      const m = byId[id], p = m.pricing.standard;
      const where = locs.slice(0, 3).map((x) => `\`${esc(x)}\``).join("<br>") + (locs.length > 3 ? `<br>+${locs.length - 3} more` : "");
      const notes = notesFor(m, models).map((n) => (n.kind === "info" ? "" : "⚠️ ") + esc(n.text)).join("<br>") || "–";
      let price = `${usd(p.input)} / ${usd(p.output)}`;
      if (vol) price += `<br>≈ ${money((vol.i * p.input + vol.o * p.output) / 1e6)}/month`;
      L.push(`| [${esc(m.name)}](${m.reference_url || SITE + "/llm-api-pricing/"}) | ${price} | ${where} | ${notes} |`);
    }
    L.push("");
  }
  const ret = [...unknown.entries()].filter(([id]) => retired[id]).sort();
  if (ret.length) {
    L.push("### Retired or being switched over", "");
    for (const [id, locs] of ret) {
      const r = retired[id], to = byId[r.replacement];
      L.push(`- ⚠️ \`${esc(id)}\` (${locs.slice(0, 2).map((x) => `\`${esc(x)}\``).join(", ")}${locs.length > 2 ? ` +${locs.length - 2} more` : ""}): from **${r.effective}**, ${esc(r.summary.charAt(0).toLowerCase() + r.summary.slice(1))}${to ? ` That is ${usd(to.pricing.standard.input)} / ${usd(to.pricing.standard.output)} per 1M tokens today.` : ""} A different model answers, so test it on your own examples. [Source](${r.source})`);
    }
    L.push("");
    for (const [id] of ret) unknown.delete(id);
  }
  if (unknown.size) {
    L.push("### Not in the current price list", "", "Older generations, aliases or IDs we do not track yet. Check that they are still offered and priced as you expect.", "");
    for (const [id, locs] of [...unknown.entries()].sort()) L.push(`- \`${esc(id)}\`: ${locs.slice(0, 2).map((x) => `\`${esc(x)}\``).join(", ")}${locs.length > 2 ? ` +${locs.length - 2} more` : ""}`);
    L.push("");
  }
  L.push(`<sub>Standard list prices in USD, checked ${data.checked}${live ? "" : " (bundled copy)"}, from the open [AiGanak LLM price data](https://github.com/AiGanak/llm-prices) (CC BY 4.0). Language costs differ too: see the [language token tax](${SITE}/language-token-tax/). Want the whole bill cut? [LLM Cost Report](${SITE}/llm-cost-report/).</sub>`);
  return L.join("\n");
}

// ---------- Budgets: prompt size, prompt growth and model price caps ----------
// Tokens are estimated at 4 characters per token (close for English; non-English text usually takes more tokens).
const estTokens = (t) => Math.ceil(t.length / 4);
function promptFiles(globs) {
  if (!globs.length) return [];
  try { return execFileSync("git", ["ls-files", "-z", "--", ...globs.map((g) => ":(glob)" + g)], { encoding: "utf8" }).split("\0").filter(Boolean); }
  catch (e) { return []; }
}
function baseText(sha, file) {
  if (!sha) return null;
  try { return execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 }); } catch (e) { return null; }
}
function checkBudgets({ globs, maxTokens, maxGrowth, maxPrice, baseSha, found, byId }) {
  const rows = [], fails = [];
  for (const f of promptFiles(globs)) {
    let t; try { t = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    const now = estTokens(t), b = baseText(baseSha, f), before = b === null ? null : estTokens(b);
    const growth = before ? Math.round(((now - before) / before) * 100) : null;
    const over = maxTokens > 0 && now > maxTokens, grew = maxGrowth > 0 && growth !== null && growth > maxGrowth;
    if (over) fails.push(`${f} is about ${now.toLocaleString("en-US")} tokens (limit ${maxTokens.toLocaleString("en-US")})`);
    if (grew) fails.push(`${f} grew ${growth}% in this pull request (limit ${maxGrowth}%)`);
    rows.push({ f, before, now, growth, ok: !over && !grew });
  }
  const priced = [];
  if (maxPrice > 0) for (const id of found.keys()) { const p = byId[id].pricing.standard.input; if (p > maxPrice) { priced.push(id); fails.push(`${byId[id].name} costs ${usd(p)} per 1M input tokens (cap ${usd(maxPrice)})`); } }
  return { rows, fails, priced };
}
function renderBudgets(b, limits) {
  if (!b.rows.length && !limits.maxPrice) return "";
  const L = ["### Budgets", ""];
  if (b.rows.length) {
    L.push("| Prompt file | Before | Now | Change | |", "|---|---|---|---|---|");
    for (const r of b.rows) L.push(`| \`${esc(r.f)}\` | ${r.before === null ? "new" : "≈" + r.before.toLocaleString("en-US")} | ≈${r.now.toLocaleString("en-US")} | ${r.growth === null ? "–" : (r.growth > 0 ? "+" : "") + r.growth + "%"} | ${r.ok ? "✅" : "❌"} |`);
    L.push("", `<sub>Token counts are estimates at 4 characters per token; ${[limits.maxTokens ? `limit ${limits.maxTokens.toLocaleString("en-US")} tokens per file` : "", limits.maxGrowth ? `growth limit ${limits.maxGrowth}% per pull request` : ""].filter(Boolean).join(", ") || "no limits set"}. Non-English prompts usually take more tokens: see the [language token tax](${SITE}/language-token-tax/).</sub>`, "");
  }
  if (limits.maxPrice) L.push(b.priced.length ? `❌ Over the price cap of ${usd(limits.maxPrice)} per 1M input tokens: ${b.priced.map((x) => "`" + esc(x) + "`").join(", ")}` : `✅ No model over the price cap of ${usd(limits.maxPrice)} per 1M input tokens.`, "");
  return L.join("\n");
}

async function main() {
  const root = input("path", ".");
  const failOn = input("fail-on", "none").toLowerCase().split(/[,\s]+/).filter(Boolean);
  const vi = parseFloat(input("monthly-input-tokens")), vo = parseFloat(input("monthly-output-tokens"));
  const vol = vi > 0 || vo > 0 ? { i: vi > 0 ? vi : 0, o: vo > 0 ? vo : 0 } : null;
  const { data, live } = await loadPrices();
  const retired = Object.fromEntries((await loadRetirements()).map((r) => [r.id, r]));
  const models = data.models; const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  const known = new Set(models.map((m) => m.id));
  const re = buildMatchers(models);
  const found = new Map(), unknown = new Map();
  for (const f of listFiles(root)) {
    let t; try { const st = fs.statSync(f); if (st.size > 1 << 20) continue; t = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    if (t.includes("\0")) continue;
    const r = scanText(t, re, known);
    for (const h of r.hits) { if (!found.has(h.id)) found.set(h.id, []); found.get(h.id).push(`${f}:${h.line}`); }
    for (const h of r.unknown) { if (!unknown.has(h.id)) unknown.set(h.id, []); unknown.get(h.id).push(`${f}:${h.line}`); }
  }
  let change = null;
  const token = input("github-token"), ev = process.env.GITHUB_EVENT_PATH, repo = process.env.GITHUB_REPOSITORY;
  let pr = null;
  try { const e = ev ? JSON.parse(fs.readFileSync(ev, "utf8")) : {}; pr = e.pull_request ? e.pull_request.number : null; } catch (e) {}
  if (pr && token && repo) { try { change = await prChanges(token, repo, pr, re); } catch (e) { console.log("::warning::Could not read the pull request diff: " + e.message); } }

  let baseSha = null;
  try { const e = ev ? JSON.parse(fs.readFileSync(ev, "utf8")) : {}; baseSha = e.pull_request ? e.pull_request.base.sha : null; } catch (e) {}
  if (baseSha) { try { execFileSync("git", ["fetch", "--depth=1", "origin", baseSha], { stdio: "ignore" }); } catch (e) { /* growth check skipped */ } }
  const limits = { maxTokens: parseInt(input("max-prompt-tokens"), 10) || 0, maxGrowth: parseFloat(input("max-prompt-growth")) || 0, maxPrice: parseFloat(input("max-input-price")) || 0 };
  const globs = input("prompt-files").split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
  const budgets = checkBudgets({ globs, ...limits, baseSha, found, byId });

  const nRetired = [...unknown.keys()].filter((id) => retired[id]).length;
  let md = render({ found, unknown, byId, models, data, live, change, vol, retired });
  const bmd = renderBudgets(budgets, limits);
  if (bmd) { const at = md.lastIndexOf("<sub>Standard list prices"); md = md.slice(0, at) + bmd + "\n" + md.slice(at); }
  const kinds = []; for (const id of found.keys()) for (const n of notesFor(byId[id], models)) if (n.kind !== "info") kinds.push(n.kind);
  for (let i = 0; i < nRetired; i++) kinds.push("legacy");
  if (unknown.size) kinds.push("unknown");
  const warnings = kinds.length;
  console.log(md.replace(MARK + "\n", ""));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.replace(MARK + "\n", "") + "\n");
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `models=${[...found.keys()].sort().join(",")}\nwarnings=${warnings}\n`);

  if (pr && token && repo && input("comment", "true") === "true" && (found.size || unknown.size || bmd || (change && (change.added.length || change.removed.length)))) {
    try {
      const cs = await gh(token, "GET", `/repos/${repo}/issues/${pr}/comments?per_page=100`);
      const mine = cs.find((c) => c.body && c.body.startsWith(MARK));
      if (mine) await gh(token, "PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body: md });
      else await gh(token, "POST", `/repos/${repo}/issues/${pr}/comments`, { body: md });
    } catch (e) { console.log("::warning::Could not post the comment (give the job 'pull-requests: write'): " + e.message); }
  }
  const hit = failOn.includes("any") ? warnings > 0 : failOn.some((k) => kinds.includes(k));
  if (hit) { console.log(`::error::LLM Cost Check found: ${[...new Set(kinds)].join(", ")}`); process.exitCode = 1; }
  // Budgets are explicit limits the team set, so breaking one always fails the check.
  for (const f of budgets.fails) console.log("::error::Budget: " + f);
  if (budgets.fails.length) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.log("::error::" + e.message); process.exitCode = 1; });
module.exports = { scanText, buildMatchers, notesFor, render, estTokens, renderBudgets };
