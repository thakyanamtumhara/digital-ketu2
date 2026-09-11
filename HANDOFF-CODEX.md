# Session handoff — dk2 clone watch (written 2026-09-11 06:25 IST)

You are taking over a **running production watch**, not a fresh task. Read this file, then
`HANDOVER.md` in this repo (process + every rule learned so far). Memory index:
`~/.claude/projects/-Users-ankit-Projects/memory/MEMORY.md`.

---

## 1. The standing job

Ketu (owner of bulkplaintshirt.com / sale91.com) handed over his AI clone:
*"keep watching my clone and keep making it better."*

**Standing autonomy:** ship clone-quality fixes without asking per change; report after, in plain
language, ₹ and IST. Stop and ask only for destructive or business-policy decisions.

**Systems**

| What | Where | Notes |
|---|---|---|
| dk2 (the clone) | `~/Projects/digital-ketu2` → `thakyanamtumhara/digital-ketu2` → Railway | prod `https://digital-ketu2-production.up.railway.app`, live build `ddc0211` |
| wwbun (WhatsApp/IG app) | `~/Projects/wwbun` → `thakyanamtumhara/wwbun` → Railway svc `bun-webb` | prod `https://mm.sale91.com`, client version constant `APP_VERSION` in `src/App.jsx` (now `v73`) |

Flow: buyer → WhatsApp/Instagram → wwbun webhook → `POST dk2 /api/incoming` → model reply →
back through wwbun. Ketu works from wwbun's **Waiting** tab only.

## 2. Two schedules — SESSION-ONLY, re-arm them

Both die when this session ends and auto-expire after 7 days (armed 2026-09-05 and 2026-09-09).

| Job | Cron | Purpose |
|---|---|---|
| `b3ed425d` | `13 9-23/2 * * *` | full **watch** tick (audit + fix + deploy) |
| `b768fa16` | `23,53 9-23 * * *` | free **pulse** (health only, no model calls) |

If they are gone after the model switch, re-create both with CronCreate using the prompt text
stored in this session (or re-type: the watch prompt is in `HANDOVER.md`, the pulse prompt is
section 3 below).

## 3. The two checks

**Pulse (every 30 min, free).** Answer in one line when clean.
```bash
cd ~/Projects/digital-ketu2 && node tools/inbox-health.mjs        # exit 1 = something stuck
TOK=$(cat ~/.dk2_read_token)
curl -s -H "X-DK-Read-Token: $TOK" \
  "https://digital-ketu2-production.up.railway.app/api/logs?lite=1&since=<now-35min ISO>&limit=400"
curl -s https://digital-ketu2-production.up.railway.app/api/health      # build + bootedAt
curl -s https://digital-ketu2-production.up.railway.app/api/ai-status   # tripped / onFallback / budget
```
Escalate (investigate + fix, revert the last deploy if it is the cause) when: any `FAILED` row,
replies 0 while inbound arrived, journal pending/stuck, a poller stale, or budget tripped.

**Watch (every 2h).** `node tools/audit-interventions.mjs 1`, then pull `/api/logs` since the last
tick and classify honestly. Bare acks and Ketu-only matters (bank details, disputes, refunds) are
**not** misses. A `DEFERRED` row Ketu then answered himself with a policy or self-serve line **is**
a miss. Also check: double replies, FAILED rows, reasoning leaks, more than one holding line per
buyer inside 45 min, budget trip, and the newer paths (`claude_partial_defer`, `defer_superseded`,
`[Reconcile]` recoveries, product-not-named resolver, `[Export]` hint).

Log row fields: `buyerMessage`, `aiReply`, `status`, `deferReason`, `costUsd`, `sentViaWwbun`,
`conversation.whatsappNumber`. `tools/interventions.json` keys: `num, at, mins, buyer, ai, ketu`.
`/api/logs` needs header `X-DK-Read-Token` (not Bearer); `lite=1` drops the huge `promptSent`
(fetch it without `lite` only for one row when you need to know what the model actually saw).

## 4. Fix discipline (learned the hard way — do not skip)

1. Reproduce the miss as a **replay case** plus a **control** in `tools/cases/watch-<date>.json`,
   and add pure-function **unit tests** in `tools/*-tests.mjs` (17 suites, ~295 tests, all green).
2. Verify with the paid replay: `node tools/replay.mjs tools/cases/<file>.json --prompt local`
   (about ₹15-20 per case; the API key is at `~/.dk2_anthropic_key`).
3. **One deploy per tick.** Each boot cools the prompt cache (₹25-55) — batching matters.
4. **After every deploy, watch for 10 minutes**: poll `/api/health` until `build` matches the new
   sha, then check `/api/logs?since=<bootedAt>` has **0 FAILED** and at least one reply sent.
   Build sha and prompt text alone are NOT verification — on 9-Sep a scope error in a new guard
   failed every reply for 1h48m and only Ketu noticed.
5. Prefer a **code guard** over another prompt rule for anything the model keeps getting wrong.
   All post-model guards now sit inside one try/catch in `runAiFlow`; keep new ones inside it, and
   never reuse a variable declared in another guard's block.

## 5. What shipped 9-10 Sep (recent context)

**dk2**
- `deliveryDaysGuard` — only "2-3 din" + the checkout ETD line is sanctioned; any other day figure
  on a delivery question is replaced (skips train/transport and stock ETAs).
- `bigBuyerDiscountGuard` — a discount ask (including a counter-price like "190 per piece karo")
  with 500+ pcs anywhere in the chat gets Ketu's "1000+ pcs → ₹4/pc" line.
- Restraint-gate bypass `isOurQuestion()` — if the clone's last reply (≤2h) asked the buyer
  something, the buyer's next message always runs the full flow (it was being silenced as chatter,
  and silenced rows never reach Waiting, so Ketu could not see them either).
- Defer chain ends on Ketu's manual reply and after 6h (was 24h).
- `/api/incoming` accepts `autoReply: true` from wwbun as a hint; `REAL_ASK_RE` still overrides.
- Prompt: printer same-parcel follow-ups are answered, not deferred.

**wwbun**
- **Waiting v72/v73**: opening a chat stamps `Conversation.openedAt` and takes it off Waiting
  (click-to-clear, like Unread); comment threads carry their unread count and clear the same way;
  a one-time backfill cleared chats already read (104 rows → ~30).
- **WebhookInbox journal** — every inbound envelope (WhatsApp, Instagram DM, MSG91 bridge for the
  marketing number 918368648533) is persisted *before* processing and replayed every 2 min, 8
  attempts, then a push alert. `GET /api/dk/inbox-health` (s2s) is what `tools/inbox-health.mjs`
  reads. Ketu's words: *"no buyer message may go missing — this is a must."*
- **Instagram comment poller fixed** — the count is recorded only after a post's comments were read
  in full, counts persist across reboots, 6-hourly safety re-read, recent window 48h → 30 days.
  Two comments (5-Sep, 8-Sep) had been lost to a failed poll.
- **Model panel v73** — a newly detected Claude appears above Opus 5 with the checkbox
  *"I have seen the new version, but I don't want to switch"*; ticking it clears the NEW badge until
  a different model appears. Left unticked for Claude Fable 5.1 on Ketu's instruction.
- Comment AI auto-fill (YouTube + Instagram) turned **off** at his request; the ✨ button still
  suggests on demand.

⚠️ Another session also commits to wwbun (latest: `2d01eff` reminders greeter classifier, 10-Sep
19:07). Always `git pull` before touching wwbun.

## 6. Open items

1. **Two questions Ketu has not answered** (asked 9-Sep, do not re-ask more than once):
   - Does colour shade vary batch to batch in bulk? The clone currently says "what you see on the
     website is what you get". If lots differ, his line is needed.
   - During his 10-minute manual-reply cooldown, should the clone still answer plain self-serve
     questions (address, hours, catalog, contact number, how to order) and stay silent on the rest?
     My recommendation was yes; he has not decided.
2. **`reasoning_leak_blocked`, 10-Sep 09:12** — "Black oversized m XS kb tk restock hoga?" cost ₹7.9,
   the guard blocked a leaked-reasoning reply and deferred; Ketu answered himself ("260 gsm mein
   le lo"). One occurrence, worth a case if it repeats.
3. **`all_claude_models_failed` on a bad image, 10-Sep 01:05** — a buyer's photo failed base64
   validation at the API and every model attempt failed; the buyer still got a holding line. Worth
   validating/downscaling images before the model call.
4. `HANDOVER.md` is modified and committed with this handoff. **Never commit `Plan.md`** — it belongs
   to another session. In wwbun never commit `owner-runner/*` or `.claude/scheduled_tasks.lock`.

## 7. Landmines

- **Never print or paste secrets.** Files: `~/.dk2_read_token`, `~/.dk2_admin_token`,
  `~/.dk2_anthropic_key`, and wwbun's `DIGITAL_KETU_SECRET` inside `~/Projects/wwbun/owner-runner/.env`
  (read it inside a script, never echo it).
- **Never open a chat in wwbun** (`GET /api/conversations/:id/messages`) while inspecting — it marks
  the chat read and wipes Ketu's unread badges. He noticed once already. Use only read-only
  endpoints: dk2 `/api/logs`, wwbun `/api/conversations/needs-reply`, `/api/comments/unreplied`,
  `/api/dk/recent-inbound`, `/api/dk/inbox-health`, `/api/comments/poll-health`.
- `gh` keeps flipping to the wrong account → run `gh auth switch -u thakyanamtumhara` before pushes.
- wwbun's `dist/` is tracked but gitignored → stage with `git add -u dist && git add -f dist/index.html dist/sw.js dist/assets/`.
- Columns added by wwbun's boot-time raw `ALTER` (e.g. `openedAt`) are **not** in the Prisma client —
  write them with `$executeRawUnsafe`, or the whole Prisma update throws.
- Prices only from the live catalog block. Never bank or UPI details from the clone. The retired
  phone 7048954134 must not appear (his own saved template still carries it; he has been told twice).
- Buyer-facing replies are the clone's job, not yours: never message a buyer directly.

## 8. State at handoff (2026-09-11 06:25 IST)

- dk2 build `ddc0211` healthy, 10-Sep: 557 rows, **0 failed**, spend ₹1,119 of the ₹1,500 daily cap
  (resets 05:30 IST). Today so far ₹4.
- wwbun up 11h, journal 1,016 received / 1,016 processed in 24h, 0 pending, 0 stuck.
- Comment pollers fresh; YouTube quota 5,635 of 10,000 (resets 12:30 IST).
- No uncommitted dk2 work except `Plan.md` (not ours).
