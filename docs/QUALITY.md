# Answer quality

Status: **agreed 2026-10-08 (decisions in §7); Q0 done; Q1 next.** This is the plan for making syrup's answers right, not only fast. It comes from one real chat that went wrong and five research reports on why. [ROADMAP.md](ROADMAP.md) gets a "Q" track once §7 is answered.

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

  **Hard rule:** before OpenCode starts, prepare each config dir that has neither `node_modules` nor `package.json`: an empty `node_modules/`, plus a `package.json` and `package-lock.json` naming `@opencode-ai/plugin` 1.18.32. In the sandbox that is `/vercel/.config/opencode` and `/vercel/.opencode`; locally the XDG config dir and `~/.opencode` if it exists, and only when it holds no plugin or tool files of the user's. Never write into a workspace. A repo with its own `.opencode` folder pays ~20 s once.
- **Verified on 1.18.32:** plugin tools named `websearch`/`webfetch` replace the built-ins; `tool.execute.before/after`, `tool.definition` (via `jsonSchema`), `experimental.chat.messages.transform` (fresh copies each step; storage and the UI keep the full text) and `experimental.chat.system.transform` (adds a second system message, so the web rules can start only after a web tool runs) all work; `opencode import` (CLI only) seeds earlier turns; `limit.input` makes compaction fire at ~100K, but the v1 SDK type needs widening, and auto-compaction then sends OpenCode's own "continue" request (the `experimental.compaction.autocontinue` hook can stop it).
- **Not yet swept:** your other local chats, for false alarms. Exporting them in bulk was refused by the permission check; run `pnpm eval:check` on any exported chat to add it.

### Q1 — The eval runner (1–1½ days)

- **`pnpm eval`**: replays recorded web results (the export holds every tool input and output) through the plugin's replay tools, keeps the model live, seeds earlier turns with `opencode import`, and runs only the turn under test. Zero search quota; ~3 model requests for the K2 case instead of ~25.
- **First set: 20 cases.** K2, 7 number cases, 6 citation cases (conflicting, counterfactual, no-evidence sources), 6 coding cases (hidden tests, so context changes can't silently hurt coding).
- **Tiers:** Tier 1 smoke (5 cases, ~20 requests, 5–8 min) for any round touching prompt, tools, context or routing; Tier 2 (20 × 3, ~250 requests) weekly or before a release, with a trend file. A quota error is never a failure.
- **Judge:** a different model family, yes/no, quoting evidence that code verifies; used only for "is this claim supported"; trusted after ≥ 90% agreement with ~40 hand labels.

### Q2 — Context hygiene (1 day)

- **Prepare the config dirs first** (Q0 hard rule), in `opencode.ts` locally and in the sandbox's engine start.
- The plugin's web hooks: `numResults` 5 (ceiling 6); results trimmed to the query (deduplicated, at most 5 results, ~6,000 characters, URLs always kept, **tables kept whole**); `webfetch` capped at 12,000 characters; web results from earlier user turns replaced by a stub with the query and source URLs; `limit.input: 120_000`.
- **Done when:** the K2 replay's last turn is ≤ 15k input tokens (65k today), no turn over 20k, answers still pass, first text no slower; coding cases unchanged.

### Q3 — Numbers (1–1½ days)

- **`syrup_calc`** on the MCP server: one plain-text argument (`permit = 15k..25k USD`, `total_pkr = total in PKR`), interval arithmetic for ranges, lakh/crore written out, live exchange rate (CC0 source, cached 12 h, hosts added to the sandbox egress list), a paste-ready result.
- **The "Numbers" prompt section** (~85 tokens; wording in the numbers report §6.1). No "double-check" line.
- **In the chat:** after an answer finishes, a quiet note when a total doesn't match its parts or a currency pair is off by more than 1.5×, with a **Fix numbers** button that sends the exact discrepancy back. The button ships only after the check reaches ≥ 95% precision on stored chats.
- **Done when:** in ≥ 4 of 5 K2 replays per routed model, the last turn's total equals the sum of its parts and its PKR equals its USD at the rate it states (±3%), so `eval:check` finds no error; the numeric set passes. (A fixed PKR band would be wrong: the turn's own parts set its total.)

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
