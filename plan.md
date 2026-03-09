# Digital Ketu 2 — Implementation Plan

## Architecture Overview
WhatsApp (wwbun) → digital-ketu2 API → Claude Haiku 4.5 → Reply via wwbun

## What's Built & Working

### Core System
- [x] Incoming message webhook (`POST /api/incoming`) from wwbun
- [x] Message merge buffer (3-sec window — multiple messages = one thought)
- [x] 10-step checks pipeline before Claude is called
- [x] Claude Haiku 4.5 API integration with full knowledge base context
- [x] Reply delivery via wwbun API (`/api/messages/send-ai-reply`)
- [x] Duplicate message protection (messageId dedup)

### Knowledge Base
- [x] Sync catalog from `products.json` (21 products with full details)
- [x] Sync saved replies from wwbun API (60 templates)
- [x] Auto-generate POLICY chunk (MOQ, GST, payment terms, etc.)
- [x] All chunks sent to Claude per request (no vector search for replies)
- [x] Vector search only for defer-to-ketu matching (threshold 0.85)
- [x] Scheduled sync every 3 days + manual sync button
- [x] Product descriptions ARE synced (fabric type, GSM, composition)

### AI Reply Style
- [x] System prompt enforces 10-15 word max replies
- [x] Style learned from Om's real corrections (Defer-to-Ketu list)
- [x] Up to 10 real reply examples injected into system prompt as STYLE EXAMPLES
- [x] Language matching: Hindi/English/Hinglish auto-detect
- [x] First-time buyer gets catalog link (sale91.com/catalog)
- [x] [DEFER] marker when Claude can't answer → sends defer message

### Processing Checks (in order)
1. System active?
2. Working hours (schedule)?
3. Daily budget limit?
4. Media-only message?
5. Empty/spam?
6. Cooldown (Om intervened)?
7. Post-defer acknowledgment (ok/thanks/theek hai)?
8. Greeting detection (skip defer check)?
9. Defer-to-Ketu similarity match?
10. Knowledge base empty?

### Dashboard (React SPA)
- [x] **Live Monitor** — Real-time message log with visual processing pipeline
  - Click any message → see full 5-step pipeline view
  - Step 1: Incoming message details
  - Step 2: Which checks passed/failed
  - Step 3: Knowledge chunks sent (saved replies, catalog, policies listed)
  - Step 4: Claude API call (input/output tokens, cost in USD + INR, processing time)
  - Step 5: AI reply output + delivery status
  - View full system prompt and user prompt for any message
- [x] **Analytics** — Messages, tokens, costs, intervention rate (today/week/month)
- [x] **Defer to Ketu** — View/manage Om's corrections, edit defer message
- [x] **Settings** — AI toggle, budget, thresholds, schedule, messages
- [x] **Sync tab — Complete Knowledge Base Viewer**
  - AI Instructions: Full system prompt + how knowledge is assembled
  - Processing Pipeline: Visual 10-step flow explanation
  - Configured Messages: Defer + media messages
  - Business Policies: MOQ, GST, payment terms, delivery info
  - Synced Catalog: All 21 products with prices, colors, sizes, descriptions
  - Synced Saved Replies: All 60 templates with content + media type
  - Defer-to-Ketu Rules: Om's corrections used for auto-defer
  - Sync History: Audit trail of past syncs

### Cost Control
- [x] Daily budget in INR (default ₹500)
- [x] Per-message cost tracking (prompt + completion tokens)
- [x] Auto-reset at midnight
- [x] Budget bar in dashboard header

### Intervention System
- [x] Om sends manual message → cooldown set (default 10 min)
- [x] Om edits AI reply → saved as defer-to-ketu correction
- [x] Corrections become style examples for future replies
- [x] Similar questions auto-defer (vector similarity > 85%)

## Tech Stack
- **Runtime**: Bun
- **Server**: Hono
- **Database**: PostgreSQL + Prisma + pgvector
- **AI**: Claude Haiku 4.5 (claude-haiku-4-5-20251001)
- **Frontend**: React (Vite, inline styles, zero external UI deps)
- **Hosting**: Railway
- **WhatsApp**: wwbun (message relay)

## API Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/incoming` | POST | Receive messages from wwbun |
| `/api/intervention` | POST | Om manual message → set cooldown |
| `/api/correction` | POST | Om edits AI reply → defer-to-ketu |
| `/api/settings` | GET/PUT | Read/update settings |
| `/api/logs` | GET | Message history |
| `/api/analytics` | GET | Aggregate stats |
| `/api/defer-list` | GET/DELETE | Manage defer rules |
| `/api/knowledge/download` | GET | Full KB export |
| `/api/sync/all` | POST | Trigger full sync |
| `/api/sync/saved-replies` | POST | Sync saved replies only |
| `/api/sync/catalog` | POST | Sync catalog only |
| `/api/sync/logs` | GET | Sync history |
