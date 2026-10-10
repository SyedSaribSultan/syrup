# Answer quality

Status: **agreed 2026-10-08 (decisions in §7); Q0, Q1, Q2, Q3 and Q5 done (Q1b, the judge, open); Round 2a done; Q4 next.** This is the plan for making syrup's answers right, not only fast. It comes from one real chat that went wrong and five research reports on why. [ROADMAP.md](ROADMAP.md) gets a "Q" track once §7 is answered.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (router, engine), [RENDERING.md](RENDERING.md) (rounds 2–8, which share files with this plan), [TESTING.md](TESTING.md) (the gate).

---

## 1. The incident

A 7-question research chat in the cloud on 2026-10-08 (climbing K2: top peaks, an A–Z guide, a gear list, the cost, the cost for a Pakistani, then "in PKR"). Gemini 3.5 Flash-Lite answered every turn but the last; the last failed over to Nemotron 3 Ultra 550B on OpenRouter's free endpoint. Checked by hand:

| # | What went wrong | Proof |
|---|---|---|
| 1 | The PKR budget is 10× too high on every row | $15k–25k at 277 PKR/USD is 41.5–69.3 lakh (0.42–0.69 crore); the answer said "4.1–6.9 crore". No tool computed it. (Its own parts add up to $21.5k–41k, so the right total was 59.6 lakh – 1.14 crore.) |
| 2 | Totals don't equal their parts | Turn 14: parts $40k–74k, stated $30k–65k. Turn 20: parts $21.5k–41k, stated $15k–25k |
| 3 | A price range was relabelled | "$8,500–15,000" came from one operator's group-size table and another's "from" price; the answer called it "local operator rates" and then "Full-Board", while every source put full board at $28k–30k |
| 4 | A claim with no source | "Permits are NOT discounted for Pakistanis": no page said so either way |
| 5 | Conflicting sources merged silently | $5,000 per person vs $9,500 per team + $3,000 per extra member |
| 6 | Context flooded | Each search returned 36–52 KB; about 91% of the chat was raw search output; the last turn sent ~65k tokens to convert five numbers |
| 7 | A slow giant model as the backup | First token at 4.5 s, then ~55 s of slow thinking and writing for a short table |
| 8 | The chat is titled "Greeting" | Named once, from "hi" |

---

## 2. Root causes (what the research found)

Reports, with a source for each claim: `scratchpad/quality-research/{numbers,grounding,context,routing,evals}.md` (session ee2fcd71). The parts that decide the plan:

- **Numbers (1, 2).** Large-number arithmetic and non-Western digit grouping are textbook failure modes. Prompting barely helps: in PAL, the same code prompt *without execution* scored 23.2 against 72.0 *with* it. "Double-check your math" makes it worse (GPT-4, GSM8K: 95.5 → 89.0). Weak models also often skip tools. So numbers must be computed by code, and a check in code must catch what slips through.
- **Grounding (3, 4, 5).** syrup's prompt has no research rules. Telling a model that "sources may conflict" moved Mistral-7B from 2.1% to 20.8% correct on conflicting passages (WikiContradict). Citing while writing beats writing then citing (ALCE: ~47% lower citation recall the other way). A model checking its own draft repeats its errors, so the check runs in code. Separately, OpenCode's `webfetch` flattens HTML tables (Turndown without the GFM plugin; reproduced), which separates numbers from their labels. That bug wasn't in play in this chat (it only searched; the search highlights kept their tables), but it would be in the next one.
- **Context (6).** The free Exa endpoint ignores OpenCode's `contextMaxCharacters`, `type` and `livecrawl`, so every search is full size. OpenCode's prune never touches the last two user turns, keeps another 40K tokens of tool output, and only fires if it frees more than 20K; auto-compaction waits for 224K. A 7-question chat reaches neither. Masking old tool results matched or beat LLM summaries at about half the cost (JetBrains), and long distractor context hurts small models most. Big prompts also quietly remove the fast low-TPM backends (`staticFit`).
- **Routing (7).** The registry gives Nemotron Ultra its *paid* decode speed (195 tok/s); the free endpoint runs at ~10–18. The router predicted 5.4 s and got ~57 s. One slow answer only moves the estimate halfway, it decays back in ~10 minutes, and new sandboxes never learn it. "Estimate the cost" and "convert" count as routine turns, so the chat never left Flash-Lite, which thinks minimally by default. Learned routers barely beat simple rules (RouterBench, LLMRouterBench), so correct numbers plus simple rules is the right level.
- **Measurement.** Nothing in syrup measures answer quality. Every fix below needs a test that fails on this chat today and passes after.

---

## 3. Decisions taken from the evidence

| Topic | Decision | Why | Rejected |
|---|---|---|---|
| Numbers | A `calc` tool on syrup's MCP server + a short "Numbers" prompt rule + a code check on every finished answer | Execution is what works; the check catches skipped tools | Bash/python for math (quoting breaks differently across cmd, PowerShell, Git Bash); Gemini code execution (not on the OpenAI-compatible endpoint, Gemini-only); sampling several answers (TTFT) |
| "Think harder" on numeric turns | **Not by default.** The eval decides: an A/B of Flash-Lite at minimal vs low vs medium on the numeric set. Ship only if it lifts the pass rate and keeps first text within +4 s | Thinking doesn't execute arithmetic, and it costs first-token time. The routing report proposed it; the numbers report's evidence says execution, not thinking, fixes this | Turning it on blind |
| Moving numeric turns to a stronger model | Only when it is nearly as fast (q ≥ 70, first token ≤ current + 3 s, total ≤ current + 8 s, free only) | Accuracy without breaking the first-token priority | Escalating every money question |
| Grounding | Prompt rules with fixed phrases ("Sources differ:", "Not confirmed:"), inline links, and a code checker after each answer that matches numbers and links against what the agent actually read | Cheap, no TTFT cost; the fixed phrases let the UI style them | An LLM verification pass on every answer (later, user-triggered only) |
| Tables | Keep tables whole everywhere text is trimmed: the `webfetch` override converts with GFM tables, and the search trimmer never splits a table row from its header | Error 3 is a number losing its label; trimming must not create more of it | Passage cutting that ignores structure |
| Context | A syrup-owned OpenCode plugin: cap and trim web results at the source, mask web results from earlier user turns with a stub that keeps the URLs, plus `limit.input: 120_000` so compaction fires at ~100K | Removes ~80% of the last turn's tokens with no model call; storage and UI keep the full text | Lowering `tool_output.max_bytes` globally (cuts build logs too); summarising searches with a model (+1–3 s each); router-side compression as the main fix |
| Coding outputs | Untouched until a coding eval shows masking is safe | Masking big bash/read output helps on SWE-bench, but our models weren't in that study | Masking everything now |
| One plugin, not three | Context hooks, the `webfetch` override and the eval replay tools ship as **one** plugin file, built by `sidecar/build.mjs`, loaded the same way locally and in the sandbox | One load path to make fast and test; parity by construction | Separate plugins per feature |
| Where `calc` lives | syrup's existing MCP server (`src/server/memory/tools.ts`) | Already runs locally and in the sidecar today, verified | A plugin tool (unverified in the sandbox path) |
| Checks | One check library (`src/lib/answer-checks/`) used by the chat UI, by `pnpm eval` and by the gate | The UI flags and the tests can never disagree | Separate code for UI and tests |

---

## 4. Plan

### Q0 — Measure first, and remove the plugin trap (½–1 day)

- **The check library**, starting from the numbers prototype (13 self-tests passing): money parsing (lakh/crore/k/M, ranges, Indian grouping), table and list totals, currency magnitude, number provenance against tool outputs, cited URLs seen, last-turn input tokens.
- **`pnpm eval:check <export>`** runs the checks on any exported chat. **Tier 0 in every gate:** the real K2 export must fail (errors 1, 2, 3); a hand-corrected copy must pass. No app, no network, under 10 s.
- **Spike (answers everything later phases assume, on 1.18.32, local and sandbox):**
  - The plugin load cost. The 2026-10-07 spike measured **21–28 s** added to a workspace's first request when any plugin or tool file exists, because OpenCode installs `@opencode-ai/plugin` into every config dir; **pre-seeding** each dir (empty `node_modules` plus a `package.json` and lock naming the package) brought it to 0.29 s. Prove the pre-seed in both modes, or no plugin ships.
  - A plugin tool named `webfetch` / `websearch` overrides the built-in.
  - `experimental.chat.messages.transform` sees fresh copies each loop, and changes only what is sent.
  - Whether a system-prompt hook can add the web rules only after a web tool runs (else they are static and cached).
  - `opencode import` accepts a seed built from an export.
  - The v1 SDK `Config` type accepts `limit.input`.

### Q0 results (2026-10-08)

- **The check library** (`src/lib/answer-checks/`, pure TypeScript, no imports outside its folder) and **`pnpm eval:check`**. On the real K2 export it reports 7 errors: list total on turn 14, table total and five 10× currency pairs on turn 20. The hand-corrected copy has none. The mislabel and the unsupported claim are hints only; a judge (Q1) decides those.
- **`pnpm test:eval-checks`** (Tier 0, 60 cases, < 1 s) is in the gate. No false alarm on any correct answer tried: the UI fixture chats, the correct K2 turns, number-heavy docs, and a hand-written set of tricky sentences (rates, per-month vs per-year, separate sentences, metres, years).
- **Plugin load cost, measured** (first request of a fresh workspace):

| | No plugin | Plugin, nothing prepared | Plugin, both config dirs prepared |
|---|---|---|---|
| Local | 0.41 s | **21.5 s** | 0.34 s |
| Vercel Sandbox | 0.45 s | **56 s** | **0.17 s** |

  **Hard rule:** before OpenCode starts, prepare each config dir that has neither `node_modules` nor `package.json`: an empty `node_modules/`, plus a `package.json` and `package-lock.json` naming `@opencode-ai/plugin` 1.18.32. In the sandbox that is `/vercel/.config/opencode` and `/vercel/.opencode` (syrup's own). Locally only the eval engine's private dirs; the user's real `~/.config/opencode` is never seeded (a seed would hide the real install from a tool the user adds later), and the one real install is triggered in the background at engine start instead. Never write into a workspace. A repo with its own `.opencode` folder pays ~20 s once.
- **Verified on 1.18.32:** plugin tools named `websearch`/`webfetch` replace the built-ins; `tool.execute.before/after`, `tool.definition` (via `jsonSchema`), `experimental.chat.messages.transform` (fresh copies each step; storage and the UI keep the full text) and `experimental.chat.system.transform` (adds a second system message, so the web rules can start only after a web tool runs) all work; `opencode import` (CLI only) seeds earlier turns; `limit.input` makes compaction fire at ~100K, but the v1 SDK type needs widening, and auto-compaction then sends OpenCode's own "continue" request (the `experimental.compaction.autocontinue` hook can stop it).
- **Not yet swept:** your other local chats, for false alarms. Exporting them in bulk was refused by the permission check; run `pnpm eval:check` on any exported chat to add it.

### Q1 — The eval runner (1–1½ days)

- **`pnpm eval`**: replays recorded web results (the export holds every tool input and output) through the plugin's replay tools, keeps the model live, seeds earlier turns with `opencode import`, and runs only the turn under test. Zero search quota; ~3 model requests for the K2 case instead of ~25.
- **First set: 20 cases.** K2, 7 number cases, 6 citation cases (conflicting, counterfactual, no-evidence sources), 6 coding cases (hidden tests, so context changes can't silently hurt coding).
- **Tiers:** Tier 1 smoke (5 cases, ~20 requests, 5–8 min) for any round touching prompt, tools, context or routing; Tier 2 (20 × 3, ~250 requests) weekly or before a release, with a trend file. A quota error is never a failure.
- **Judge:** a different model family, yes/no, quoting evidence that code verifies; used only for "is this claim supported"; trusted after ≥ 90% agreement with ~40 hand labels.

### Q1 results (2026-10-08)

- **`pnpm eval` runs** ([TESTING.md](TESTING.md) §1.2): an isolated syrup (`scripts/eval/host.ts`), earlier turns imported with `opencode import`, web results replayed by syrup's plugin, the answer checks on the live turn, hidden tests for coding, a baseline (`scripts/fixtures/eval-baseline.json`), and a table per run.
- **First smoke run: 5 of 5 pass**, 29 model requests, 94 s, 0 Exa calls, 0 scarce-backend requests (all on Gemini Flash-Lite). The K2 replay's last turn converted correctly this time (~278–280 PKR per USD; 4.2M–8.4M PKR for $15k–30k).
- **Known gap, recorded:** the K2 last turn sent **55k** input tokens against the 15k budget. It must fail until Q2, then the gap note goes.
- **The plugin costs nothing when idle.** Measured on 1.18.32 with a fresh workspace, 3 rounds: first request 0.31 s with the plugin and prepared config dirs, 0.51 s without the plugin, 11.1 s with the plugin and nothing prepared. The tool list and system prompt the model receives are byte-identical with and without it; with the replay on, the web tools are identical to the built-ins too.
- **Eval traffic stays off scarce backends** through `x-syrup-eval: 1` (router suite: eval1–eval3).
- **Not built:** the judge (Q1b), the rest of the 20 cases (Tier 2), `--record missing`.
- **Seen in the run, for later:** the citation case searched 7 times for the same page instead of opening it, and in a dry run before it, a K2 answer stated a "total budget" of 4.5M–9M PKR while its listed parts add up to 6.4M–12.8M, which no check flagged (the list-total check doesn't catch a total phrased as a sentence after the list). The smoke run's own answer (7.5M–14M+ against parts of 7.6M–15.4M) passed on the open-ended "+".

### Q2 — Context hygiene (1 day)

- **Prepare the config dirs first** (Q0 hard rule), in `opencode.ts` locally and in the sandbox's engine start.
- The plugin's web hooks: `numResults` 5 (ceiling 6); results trimmed to the query (deduplicated, at most 5 results, ~6,000 characters, URLs always kept, **tables kept whole**); `webfetch` capped at 12,000 characters; web results from earlier user turns replaced by a stub with the query and source URLs; `limit.input: 120_000`.
- **Done when:** the K2 replay's last turn is ≤ 15k input tokens (65k today), no turn over 20k, answers still pass, first text no slower; coding cases unchanged.

### Q2 results (2026-10-08)

- **The K2 replay's last turn: 55.2k → 11.4–11.5k input tokens** (5 of 5 trials; 13.8k once, when the model searched again live). The budget check is now blocking; its gap note is gone. First text on that turn 9.4 s → ~3 s. `bench:agent --set quick`: median first text 6.2 s → 4.9 s.
- **In syrup's plugin** (`contextHygiene`, on unless `SYRUP_CONTEXT_HYGIENE=0`, independent of the eval replay): websearch `numResults` 5 (ceiling 6); search results trimmed to the query (at most 5 results, ~6,000 characters, hard cap 8,000, every shown URL kept, duplicates and near-duplicates dropped, BM25 plus a numbers bonus, a plain 8,000-character cut if Exa's format changes, `{rawChars, keptChars, trim}` in the metadata); webfetch capped at 12,000 characters with a note; web results of earlier user turns sent as a stub with the query and up to 5 sources (storage and the UI keep the text); in the current turn the newest 3 web results are always kept and the rest only within 16K tokens; websearch's definition cut to `{query, numResults}`. Coding tools untouched.
- **Tables kept whole:** a table that fits is kept entire (it may run past the 6,000 target up to the 8,000 cap); a bigger one keeps its header, its separator and its best rows, with a "table cut: N of M rows shown" note. Rows that continue a table straight after Exa's `...` break join that table. Rows the search result gave without any header are kept as one block, whole or not at all, under the line "(table rows without their header row: the column meanings were not in the search result)". They are never given a header that might not be theirs (e.g. Wikipedia's top-10 peaks rows in the K2 chat).
- **`limit.input: 120_000`** on every alias: auto-compaction fires at ~100K instead of 224K.
- **OpenCode's "continue" request after compaction is stopped only when the compaction followed a finished answer** (measured on a mock engine: it bought one extra reply to a question nobody asked). Mid-task it is kept: without it the turn ends right after the summary and the task is dropped. Never stopped on a provider overflow or with a newer question unanswered.
- **Smoke set:** 5 of 5 pass in both after-change runs. Last-turn tokens per case before → after: add-slugify 7.8k → 7.4–7.8k, budget-table 8.9k → 7.3–8.7k, counterfactual-fee 9.6k → 7.1–9.9k, fix-failing-test 8.2k → 7.9–8.3k, k2-pkr 55.2k → 11.4k. Coding requests are ~300 tokens smaller (shorter websearch definition). Their first text is dominated by step count and the model picked; two hygiene-off/on rounds on one model gave per-request first-token medians of 1,149/1,084 ms off and 1,343/1,054 ms on (the sign flips with run order: noise).
- **Not done here:** the 20-question set that would measure passage choice (Tier 2).

### Q3 — Numbers (1–1½ days)

- **`syrup_calc`** on the MCP server: one plain-text argument (`permit = 15k..25k USD`, `total_pkr = total in PKR`), interval arithmetic for ranges, lakh/crore written out, live exchange rate (CC0 source, cached 12 h, hosts added to the sandbox egress list), a paste-ready result.
- **The "Numbers" prompt section** (~85 tokens; wording in the numbers report §6.1). No "double-check" line.
- **In the chat:** after an answer finishes, a quiet note when a total doesn't match its parts or a currency pair is off by more than 1.5×, with a **Fix numbers** button that sends the exact discrepancy back. The button ships only after the check reaches ≥ 95% precision on stored chats.
- **Done when:** in ≥ 4 of 5 K2 replays per routed model, the last turn's total equals the sum of its parts and its PKR equals its USD at the rate it states (±3%), so `eval:check` finds no error; the numeric set passes. (A fixed PKR band would be wrong: the turn's own parts set its total.)

### Q3 results (2026-10-09 – 10-11; independently reviewed)

- **`syrup_calc`** (`calc` on syrup's MCP server, `src/server/memory/tools.ts`; core in `src/server/calc/core.ts`, pure, no `eval`, a null-prototype scope). One `lines` argument, one `name = expression` per line. Ranges (`15k..25k`, `15,000 – 25,000`, `15k to 25k`, `$40–74k`) use interval arithmetic, so a range total is the sum of the lows to the sum of the highs, and remember where a range came from (affine arithmetic): a discount off its own price is 13,500 – 22,500 rather than 12,500 – 23,500, and `a − a` is 0; a product or quotient of independent ranges keeps the plain interval rule (wider than the truth, never narrower). Numbers take k, m, bn, lakh, crore, arab, Western or Indian grouping, and an ISO code or $ € £ ₹. Also `p% of x`, `x + p%`, `^`, `sum/min/max/avg/round`. Results come back paste-ready (`41,55,000 – 69,25,000 PKR (41.55 – 69.25 lakh)`) with a "Rate used" line naming its source and date.
- **Rates.** A rate the lines give wins (`1 USD = 278 PKR`, `rate = 278 PKR per USD`, `x in PKR at 278`, `x in 278 PKR`, or `rate = 278 PKR` when it can only mean one thing). Otherwise today's table: fawazahmed0's currency-api (CC0, no key) with `currency-api.pages.dev` first and jsDelivr as the fallback, 3 s per host, cached 12 h, a failure remembered for a minute, a table up to 3 days old used with its date; the body is read with a 256 KB cap, and a table with EUR, GBP, PKR or INR far outside their range is refused. With nothing usable it asks for a rate, never guesses. Both hosts are on the strict egress list. Refused, not guessed: "L" (lakh or litres), Rs/₨, ¥, lower-case codes, mixed currencies in a sum, `15k-25k`, division by zero or by a range through zero, |x| > 1e15, more than 60 lines or 4,000 characters, more than 40 nested brackets. An error quotes at most 24 characters of the input.
- **Found in the eval:** models write the user's rate as a value (`rate = 280 PKR`). It used to become a plain number while the conversion silently used today's 276.72, and the answer still said "at 280" (1 of 3 `num-convert` trials). Those forms now work; ambiguous ones are refused with the line to write.
- **The prompt's "# Numbers"**: calc for any total, percentage, conversion or estimate; totals equal their parts; range totals; 1 lakh / 1 crore; the user's currency and number system; name the rate. No "double-check" line. ≈ +110 tokens; the tool's definition ≈ 160; together ≈ +270 tokens per request, cached.
- **The note in the chat** (`src/components/number-note.tsx`, rules in `src/lib/number-note.ts`): after the turn ends and the answer has finished typing out, a quiet note lists up to three discrepancies (a total that isn't its parts, or a currency pair off by more than 1.5×). The checks are a lazy chunk run when the browser is idle; nothing runs while a reply streams. It fades in only when the answer streamed in front of you. Not shown in shared snapshots. Same in local and cloud.
- **Fix numbers is off, behind a flag** (`NEXT_PUBLIC_SYRUP_FIX_NUMBERS=1`, or localStorage `syrup.fix-numbers` = `on`). Its rule is ≥ 95% precision on a blind set measured before tuning. Two blind sets measured **90.3%** (28 of 31 flags, 84 answers) and **88.9%** (32 of 36, 98 answers). Every false alarm they found is fixed (all 361 labelled answers now get 0 false alarms, recall 88%), but that is a tuned figure. Next: a third blind set (`BLIND` in `scripts/test-numbers.mjs`).
- **Checker changes** (each from a false alarm or a miss): "-$18" is negative; subtotal items and a "Subtotal" line before add-ons count correctly; per-person, "each" and rate columns (CPC, CPA, "%", "price per") aren't summed; "Total / blended" and average rows aren't totals; items over different periods are a derivation, not parts; a contrast ("while", "but", "vs") or different periods between two currencies means two prices, not a conversion; cross rates go through USD; AED and SAR added; "L" is lakh only on a rupee-marked amount. Two hostile inputs froze the main thread: a 200 KB "1,1,1,…" line (97 s) and "Total: $" + 99,000 spaces + "1" (23 s, found in the 2026-10-11 review). With bounded quantifiers, and every `\s*` hung off its own token, they take 8 ms and 3 ms; `test:numbers` times every token pair around 20,000 spaces. The chat also collapses long whitespace runs and skips answers over 100,000 characters.
- **Eval.** The K2 sums check is blocking. `k2-pkr`: 5/5 on Gemini 3.5 Flash-Lite (twice) and 5/5 on Gemini 3.1 Flash-Lite, on Auto; `syrup_calc` called in every trial. The numeric set (`--set numeric`, 5 cases): 10/10 (×2) and 13/13 counted (×3).
- **Cost: first text on a numbers turn is later.** The model calls `syrup_calc` before it writes: on the K2 last turn the median first text went from ≈ 3 s (after Q2) to 5–9 s; last-turn input 11.4k → 12.0k tokens. Ordinary turns are unaffected. The tool step shows in the chat while it runs.
- **Not done:** units (m↔ft, kg↔lb); the `SYRUP_NUMERIC_EFFORT` A/B; recall gaps (totals in emoji lines or dot leaders, "Gross salary" lines, nested subtotal sections, LaTeX display math); the third blind set.

### Q4 — Grounding (1½ days)

- **`webfetch` override** in the plugin: GFM tables, boilerplate removed, a `Source / Title / Fetched` header.
- **"When you answer from the web"** prompt section (~230 tokens; wording in the grounding report §5.2), with the "open the page before quoting a price" rule decided in §7.
- **In the chat:** links to pages the agent read render as numbered source chips with a card showing the matching snippet; numbers not found in the cited page get a soft flag; "Sources differ:" and "Not confirmed:" lines get callouts; a "Read N pages" footer lists what was read. All after the answer finishes; nothing waits on it.
- **Done when:** all four K2 grounding errors are fixed in ≥ 4 of 5 replays per model; the citation set passes.

### Q5 — Routing (1 day)

- Realistic free-endpoint speeds (OpenRouter `:free` capped at 25 tok/s, 1.5× first-token time), a per-model thinking multiplier, slowness learned fast and forgotten slowly (60-minute half-life), measured speed replayed into new sandboxes.
- A routine turn never picks a backup predicted over max(20 s, 3× the quickest adequate model) unless nothing else can answer.
- A `numeric` turn class (for the "move when nearly as fast" rule and, if the eval says so, the thinking bump).
- "plan A or plan B" stops counting as a hard turn. Google's quota id kept in error messages, so the next failover is diagnosable.
- **Done when:** the K2 replay's last turn never lands on a slow giant; router suite scenarios for each rule; `bench:agent` first text unchanged on lookup turns.

### Q5 results (2026-10-08)

- **Realistic speeds.** OpenRouter ids ending in `:free` start at 25 tok/s and 1.5× the first-token time until measured (`model-registry.ts`). Each model has a `think` multiplier on its expected output on Auto (Gemini Flash 1.8, Gemini 3.1 Pro 2, Nemotron 3 Ultra 2.5, unknown reasoning models 2, the rest 1). Kimi K3 stays at 1: at 2.5 on top of its 45 tok/s prior, a free Kimi lost routine turns to a paid key.
- **Slowness is learned fast and forgotten slowly.** One 10 tok/s answer takes a 195 tok/s estimate to ~75 (it stopped at ~102 before); a faster answer moves it a quarter of the way up. Decode speed decays toward the prior with a 60-minute half-life (first-token time keeps 10 minutes). `Health.seed` replays measured decode speed into a new sandbox.
- **The fallback guardrail.** On a routine later turn, a backend predicted slower than max(20 s, 3× the quickest adequate model) loses 30 points: last, still used when nothing else can answer. On a hard turn, −15 above 90 s.
- **The `numeric` turn class** (`policy.isNumeric`, Auto only): arithmetic, conversions, estimates, price comparisons, and the K2 chat's numberless follow-ups ("approx cost", "in PKR"). Scarcity costs 10 instead of 25 (not on openings). The chat moves to a stronger free model (quality 70+) only when it is predicted to start within 3 s and finish within 8 s of the current one, at a user-turn boundary (reason `numeric`; the chat says "for a calculation"); the usual "clearly better model" release obeys the same slack, so Google-only chats stay on Flash-Lite.
- **The thinking bump is built and off.** `SYRUP_NUMERIC_EFFORT=low|medium` asks Gemini 3.x Flash-Lite for that effort on numeric turns; unset means off until the numeric eval's A/B decides (§3).
- "plan A or plan B" and "the Pro plan's price" are no longer hard turns; "Plan the auth module" still is. Google's quota id stays in the error message.
- **The K2 replay** (real `rank()`/`staticFit()`, ~65K-token last turn, Flash-Lite rate-limited): before, Nemotron 3 Ultra :free was the fallback, predicted 8.7 s (it took ~57 s); after, Gemini 3.5 Flash answers, predicted 20 s, and Nemotron ranks last (predicted 50 s).
- **Measured.** Router suite 96/96, verified alone in a clean worktree. Eval smoke 5/5. Bench before a dev-server restart: lookup turns' first text 3.7–6.6 s, not slower than before; a re-bench on the restarted server is pending.

### Q6 — Small fixes

- Re-title a chat whose first message was small talk, after its first real question.
- The admin probe deletes its temporary workspace even when a step fails.

### Order and overlap with the capability rounds

- **Q0 → Q1 first.** Every later step is measured with them.
- **Q2 and Q5 can run alongside Round 2a**: their files (the plugin, engine config, router) don't overlap with 2a's.
- **Q3 and Q4 come after 2a**: both edit `prompt.ts` and the chat's Markdown rendering, which 2a also edits. Their UI parts plug into 2a's rich-renderer registry instead of adding a second rendering path.
- Every Q step re-baselines initial JS; the checks load lazily, so the first page doesn't grow.

---

## 5. Budget

- **Tokens:** +~315 prompt tokens per request (Numbers + web rules, cached), against ~50k saved on long research turns.
- **Time:** no added first-token time on ordinary turns. Number turns add one tool round trip (~1.5–4 s on Flash-Lite). The "open the page" rule, if kept, adds ~2–5 s to price questions only.
- **Quota:** the plugin and checks use none. Evals: Tier 1 ~20 requests per qualifying round; Tier 2 ~250 weekly, kept off scarce backends.
- **Effort:** about 6–7 working days for Q0–Q5.

---

## 6. Risks

- **Plugin load time** (the 21–28 s trap). Mitigated by the pre-seed; Q0 proves it or the plugin parts move to the router or the MCP server.
- **`experimental.*` hooks** may change on an OpenCode upgrade. The version is pinned; the plugin self-tests at load and falls back to a plain cut.
- **Exa's free output format** may change. The trimmer falls back to a plain 8,000-character cut.
- **Weak models skip `calc`.** The code check is the backstop.
- **Correct arithmetic on wrong inputs** is still wrong. Grounding is the defence.
- **Checker false alarms.** Flags are soft hints; the Fix button waits for ≥ 95% precision.
- **Over-hedging** ("Not confirmed" everywhere) on weak models. The citation set measures it.
- **Masked results re-fetched.** The stub keeps URLs; the eval counts repeat searches.

---

## 7. Decisions (founder, 2026-10-08)

1. **Token budget for the K2 replay's last turn: 15k.**
2. **The real K2 chat is committed as a test fixture** (its text and search results; no secrets).
3. **A Tier 1 regression blocks the push** until someone reads it.
4. **Eval traffic stays off scarce backends** (Gemini Flash, OpenRouter's daily cap).
5. **"Open the page before quoting a price": on.** The eval measures its cost; if it adds more than 5 s to price questions, it is revisited.
