# dk2 — Handover

Read this before touching anything. It is written for whoever picks up the work next — a new
session, a new model, a new person. Last updated 2026-09-02.

## What this is

An AI clone of Ketu that answers buyers on WhatsApp and Instagram for a Delhi wholesale
blank-t-shirt business (bulkplaintshirt.com / sale91.com). The goal is not "a helpful assistant".
The goal is that **buyers cannot tell it apart from Ketu**.

The single measure that matters:

> **If Ketu had to reply manually, the AI failed.**

His manual reply is the ground truth for every miss. Not a rubric, not a score — his actual words.

## Where the quality actually lives

Not in any conversation's context. It lives in three places, all in this repo:

1. **`server/process.js`** — a ~156,000-character system prompt built one correction at a time
   over months. Every rule cites the buyer number and date that caused it. Do not "tidy" it.
2. **Deterministic code paths** — prefilters, canned shortcuts, the live stock block, outbound
   scrubs. These run **before or instead of** the model.
3. **`~/.claude/.../memory/`** — the operator's memory index, loaded each session.

Corollary: handing this work to a new session loses almost nothing, **provided the new session
reads the repo.** A chat summary is not a substitute and gets compacted away.

## The hardest-won lesson

**Never leave a join to the model.**

Three separate bugs, same shape — the model was handed two lists and asked to cross-reference:

- It said "Maroon 46 is out" because *other* colours' 46 was out.
- It promised "Kids Black 24 in ~6 days" by reading the *Mustard Yellow* shipment row.
- It answered "dispatching ASAP" into a wrong-item complaint because the guards were text
  regexes and the message was a wordless `[Image]`.

Each time the fix was the same: **resolve the match in code, hand the model one pre-computed
answer.** When you find yourself adding a rule that says "carefully check X against Y", stop —
compute it instead.

The corollary for the canned shortcuts: **a prompt rule cannot fix a bug in a path that never
calls the model.** The 2026-09-02 audit found 4 of 13 misses were exactly this — the prompt
already forbade all four.

## The watch loop

This is the job. Run it daily.

```bash
node tools/audit-interventions.mjs 2      # pull traffic, find where Ketu had to type
```

Then for each intervention ask: did the clone **contradict** Ketu, or dodge a question he then
answered? That is a real miss. Roughly half will be benign — him saying "Ok", or handling
something only he can (bank details, a dispute, a refund, a live pickup). **Do not inflate the
count**; a fix aimed at a non-defect makes the clone worse.

Then: reproduce → fix → **verify against the real model** → deploy → confirm live.

## Verification discipline (learned the hard way)

- **Deploy is not done when Railway says SUCCESS.** Require the *exact* SHA *and* `SUCCESS`.
  An empty `$SHA` variable produced a false "deployed" twice.
- **The prompt is DB-synced on boot**, a little after the deploy goes green. Confirm the rule is
  actually live by grepping `/api/settings`, not by trusting deploy status. Poll — it lags.
- **Never trust an audit's claims without checking production.** One audit reported dangerous
  filters were live and the catalog was priceless. Both were false. Verify, then act.
- **When switching a data source, diff the FIELD NAMES.** Moving to the live products.json broke
  prices for 5 days because the live schema used `bulkPriceFrom/To`, not `bulkPrice`. 17 of 22
  products had no price and nobody noticed.

## Cost

Ketu pays for the production API. Subagents/workflows run on the operator's inference and are
free to him — **prefer those for analysis.** Direct calls to `api.anthropic.com` with dk2's key
cost his money; state the cost before spending it. A full 6-case replay against the live prompt
is ≈ ₹200 because the prompt is large.

Budget is capped daily and visible in the wwbun header. Cache-warm matters: the cached prefix is
`staticPrompt + catalogBlock`; a cache miss costs ~14× a hit.

## Standing rules — violating these is worse than staying silent

- **Never invent a delivery, arrival, restock or dispatch time.** Sanctioned exceptions only:
  generic "2-3 din" delivery, Delhi-local "1-2 ghante" bike, AIR sample "1-2 din", and a live
  COMING SOON ETA matching the exact product **+ colour + size**. Dispatch is **day-granular** —
  never a clock hour.
- **Never share bank/UPI/account details.** Ketu does that himself, always.
- **Prices come only from the live catalog block.** Never from the prompt, never from memory,
  never from a retrieved chunk. Prices have leaked three times; all injection points are now
  sanitised, but conversation HISTORY remains the one un-sanitised path. *(open)*
- **Phone 7048954134 is retired** — never send it. Calls: 9336695049. Godam/visits: 8368648533.
- **Never claim stock without the live block.** With the block, answer from it; without it, defer.

## Reflexive "No" — a recurring failure mode worth naming

The clone treats "we don't do X" as the end of a conversation. Ketu uses it as the start of a
different offer:

| Buyer asked | Clone said | Ketu said |
|---|---|---|
| Ship outside India? | "No sir, India only" | "Buy from us, arrange your own forwarder from India" |
| Move goods to my printer? | "No sir" | "Printer is next door, we'll hand it over" |
| Any coupon code? | "Fixed price, no codes" | "Tell me the piece count, I'll give you a code" |
| More photos? | "Only this one available" | "All the photos are in the link — plus the live godam camera" |

Before writing any refusal, ask what Ketu would *offer instead*. Two of these are fixed; the
coupon and photo cases are still open (see below).

## Open items

- ~~Coupon/discount-code asks~~ — DONE 2026-09-02: clone asks the piece count once, then hands to
  Ketu (his policy: codes are his call).
- ~~Photo scarcity~~ — DONE 2026-09-02: never "only this photo"; invite the swipe + live godam
  camera `https://www.youtube.com/@BulkPlainTshirt_com/live`.
- ~~Acid-wash fade~~ — DONE 2026-09-02, in Ketu's words (fading is normal, don't soak, 15-20 min).
- ~~Discount code "not working"~~ — DONE 2026-09-02: "poora code copy karo, RV- se shuru hota hai".
- ~~"Again AI reply😊"~~ — POLICY SET 2026-09-02: never deny, never volunteer; if asked, "Main Ketu
  ki buyers se chat mein help karta hoon sir 🙏" then answer the question.
- **Seasonal facts must be computed, not written** — the "Winter stock September ke baad" sentence
  went stale the day the season turned. Now `winterStockLine()` in process.js builds it from the IST
  month and injects it only on winter-item messages. Any other date-bound fact in the prompt is the
  same bug waiting to happen (grep for "abhi", "temporary", "currently").
- **Dropped middle message** — buyer 9818070935 sent 3 messages on 2026-08-31 (Hi / "shorts ka
  stock refill kab" / "off white beige stock nahi"); the middle one never reached the model and the
  clone answered about the wrong product. Root cause under investigation (ingest/merge path). *(HIGH)*
- ~~Corrections DB poisoning~~ — DONE 2026-09-02: full audit of all 1,253 CORRECTION chunks
  (14 finder agents + refute pass, quotes required) → **358 deleted** (190 stored defers, 68 with
  the retired phone, 36 frozen prices incl. the dead "extra ₹2" discount, 32 other harmful, 19 stale
  timings, 12 mispaired, 2 Drive links, 1 payment line). 1,253 → 895. Backup + delete log in
  `~/dk2_corpus/` (chunks_backup_2026-09-02.json, deleted_corrections_2026-09-02.json). By origin:
  reviewer_ai 166/265 bad (63%) → **the AI reviewer no longer writes CORRECTION chunks** (its
  suggestions stay in DeferToKetu for the dashboard); intervention/edit 141/592; reviewed manual
  pairs 50/396. Every remaining write path now runs `replyAnswersBuyer()` (one Haiku yes/no,
  fail-open) + `hasGarbledTranscript()` before storing. Re-audit monthly with the same workflow
  shape; a correction is Ketu's words about THAT buyer text, nothing else.
- **Prompt consolidation** — ~156k chars, rules stacked for months and now interacting in ways
  nobody tracks. Roughly ₹1,400/month per 10% trimmed. **This is the one genuinely hard design
  problem left** and the best first task for a fresh pair of eyes. Build a regression suite first;
  the last one was lost to a dead scratchpad.
- **Buyer asked "Again AI reply😊" and the clone denied being AI.** Flagged to Ketu; no decision
  yet. Needs a policy call from him, not a code change.

## Tools

| Command | What it does |
|---|---|
| `node tools/audit-interventions.mjs [days]` | The watch loop — find where Ketu had to type |
| `node tools/stock-block.mjs` | Print the live stock block exactly as the model sees it |
| `node tools/guard-tests.mjs` | Regression: canned dispatch-ack guards |
| `node tools/clock-scrub-tests.mjs` | Regression: dispatch clock-hour scrub |
| `node tools/replay.mjs tools/cases/<file>.json --prompt local` | Replay a case file against the prompt you are ABOUT to ship, on production Opus 5 (**costs money**: ~₹60 cache write + ~₹3.5/case). `--prompt live` = what is live now. `--dump <dir>` writes the exact prompts without calling the API (free proxy runs). |
| `node tools/winter-line-tests.mjs` | Regression: the date-computed ❄️ winter-stock line + its trigger regex |

`replay.mjs` reads the key from `~/.dk2_anthropic_key` (chmod 600; Ketu pastes it from Railway →
digital-ketu2 → Variables) or `ANTHROPIC_API_KEY`. It rebuilds the request the way `runAiFlow` does
(static prompt + catalog block cached, stock/photo/winter blocks per case, RECENT CONVERSATION).
Cases live in `tools/cases/` — each has `must` / `mustNot` regexes and a `why` citing the buyer and
date. Add a case for every miss you fix, plus a CONTROL case for the neighbouring rule that must
NOT change. Run the free `--dump` + operator-model proxy first, the paid run once before shipping.

## Do not

- Do not push with the wrong GitHub account — `gh auth switch -u thakyanamtumhara` first
  (the other account 403s).
- Do not "clean up" prompt rules that cite a buyer number and date. Each one is a scar.
- Do not add a rule to fix a bug in a canned path. Fix the path.
- Do not report a fix as shipped until the exact SHA is live **and** the rule greps in
  `/api/settings`.
