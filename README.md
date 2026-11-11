# LLM Cost Check

A GitHub Action that finds the OpenAI, Anthropic and Google model IDs in your code and tells you, on every pull request:

- what each model costs per million input and output tokens
- which models have an **announced price rise**, and when
- which models are **legacy or preview**
- a **cheaper model in the same tier**, if there is one
- what changed when a pull request **switches models**, with the price difference and, if you give your volume, the monthly cost before and after
- models a provider is **retiring or switching over**, with the date and what replaces them (for example Gemini 2.5 Pro and 2.5 Flash on 1 December 2026)
- model-like IDs that are **not in the current price list** (older generations, typos, aliases)

No API keys and no dependencies. Prices come from the open [AiGanak LLM price data](https://github.com/AiGanak/llm-prices), checked weekly against the providers' pricing pages.

## Use it

```yaml
# .github/workflows/llm-cost-check.yml
name: LLM Cost Check
on:
  pull_request:
  schedule:
    - cron: "0 6 * * 1"   # weekly, catches newly announced price changes
permissions:
  contents: read
  pull-requests: write    # only needed for the pull request comment
jobs:
  llm-cost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: AiGanak/llm-cost-action@v1.0.0
        with:
          fail-on: none                    # or: price-increase, legacy, unknown, any
          # monthly-input-tokens: 50000000  # optional, adds dollar figures
          # monthly-output-tokens: 10000000
```

The results appear as one pull request comment, updated on each push, and in the job summary.

## Example

An excerpt of the comment for a test repository with nine model IDs:

> ### Models in this code
>
> | Model | Input / output per 1M tokens | Where | Notes |
> |---|---|---|---|
> | Claude Haiku 4.5 | $1 / $5 | `src/app.py:1` | ⚠️ Legacy model: the provider has a newer model in this tier.<br>Cheaper in the same tier: Anthropic Claude Haiku 5.5 at $0.10 / $0.50 per 1M tokens. Test quality on your task first. |
> | Gemini 4 Argon | $2 / $10 | `src/app.py:2` | ⚠️ Price rises on 2026-12-01: input $2 → $4, output $10 → $20 per 1M tokens (+100% input). |
> | GPT-6 Astra | $10 / $50 | `src/cfg.ts:1` | Cheaper in the same tier: Anthropic Claude Opus 5.5 at $4 / $20 per 1M tokens. Test quality on your task first. |
>
> ### Not in the current price list
>
> - `gpt-4o`: `src/app.py:3`
> - `o3`: `src/app.py:4`

And when a pull request moves from GPT-6.1 Sol to GPT-6.1 Terra with `monthly-input-tokens: 50000000` and `monthly-output-tokens: 10000000`:

> - **GPT-6.1 Sol** ($2 / $10) → **GPT-6.1 Terra** ($1 / $5): input -50%, output -50%, about $200 → $100 a month at your stated volume

## Inputs

| Input | Default | What it does |
|---|---|---|
| `path` | `.` | Folder to scan. Files ignored by git, lock files, `node_modules`, `dist` and similar are skipped. |
| `comment` | `true` | Post or update one comment on pull requests. |
| `fail-on` | `none` | Fail the check on `price-increase`, `legacy` (legacy or preview models), `unknown`, or `any`. Comma-separated. |
| `monthly-input-tokens` | | Optional monthly input tokens per model, to show dollar figures. |
| `monthly-output-tokens` | | Optional monthly output tokens per model. |
| `github-token` | `github.token` | Used to read the pull request and post the comment. |

Outputs: `models` (comma-separated IDs found) and `warnings` (count).

## What it does not do

It reads model IDs, not your traffic, so it cannot know how many tokens you send. The "cheaper in the same tier" hint compares list prices only: test quality on your own task before switching. Token counts also differ by language and model family; see the [language token tax](https://aiganak.com/language-token-tax/).

Want the whole bill analysed? Try the free [LLM Bill Analyzer](https://aiganak.com/llm-bill-analyzer/) or order an [LLM Cost Report](https://aiganak.com/llm-cost-report/).

## Also available

- MCP server for Claude, Cursor and other assistants: [`@aiganak/llm-cost-mcp`](https://www.npmjs.com/package/@aiganak/llm-cost-mcp)
- The data as JSON and CSV: [AiGanak/llm-prices](https://github.com/AiGanak/llm-prices)

## Licence

Code: MIT. Price data: CC BY 4.0, © AiGanak Technologies OPC Pvt Ltd. Prices are list prices for information; check your provider's pricing page before making decisions.
