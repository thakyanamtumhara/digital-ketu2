# Digital Ketu 2 — Implementation Plan

## Architecture Overview
WhatsApp (wwbun) → digital-ketu2 API → Claude Haiku 4.5 → Reply via wwbun

## What's Built & Working

### Core System
- [x] Incoming message webhook (`POST /api/incoming`) from wwbun
- [x] Message merge buffer (3-sec window — multiple messages = one thought)
- [x] 14-step pre-AI filter pipeline before Claude is called
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
- [x] Smart chunk filtering — only sends relevant chunks to Claude (~2000-3000 tokens instead of ~8000)
- [x] Style guide extraction from Om's real conversations

### AI Reply Style
- [x] System prompt enforces 10-15 word max replies
- [x] Style learned from Om's real corrections (Defer-to-Ketu list)
- [x] Up to 10 real reply examples injected into system prompt as STYLE EXAMPLES
- [x] Om's extracted style guide (compact, ~200 words) injected into prompt
- [x] Language matching: Hindi/English/Hinglish auto-detect
- [x] First-time buyer gets catalog link (sale91.com/catalog)
- [x] [DEFER] marker when Claude can't answer → sends defer message
- [x] Dispatch intent detection — reassures buyer about immediate dispatch
- [x] Buying intent detection — mentions sale91.com only once
- [x] Price negotiation detection — politely says prices are fixed

### Pre-AI Filters (14 checks, 0 tokens consumed)
These run BEFORE Claude is ever called. Each saves tokens by handling the message locally:

| # | Filter | Type | Action | Tokens |
|---|--------|------|--------|--------|
| 1 | System Active (ON/OFF) | System | Skip silently | 0 |
| 2 | Working Hours Schedule | System | Skip silently | 0 |
| 3 | Daily Budget Limit | System | Skip silently | 0 |
| 4 | Emoji Reaction Skip | Message | Skip silently | 0 |
| 5 | Media-Only Auto-Reply | Message | Auto-reply with media message | 0 |
| 6 | BillNo PDF Detection | Keyword | Auto-reply: "Ok noted sir, dispatching ASAP" | 0 |
| 7 | Empty/Spam Messages | Message | Skip silently | 0 |
| 8 | Manual Intervention Cooldown | User | Skip silently | 0 |
| 9 | Acknowledgment Keywords (29 words) | Keyword | Skip silently (ok, thanks, hmm, theek hai...) | 0 |
| 10 | Greeting Detection | Keyword | Passes to Claude but skips defer check | Varies |
| 11 | Welcome Message Bypass | Auto-Reply | First-time or 7+ day gap → welcome message | 0 |
| 12 | Defer to Ketu (Vector Match) | AI Match | Auto-reply with Om's correction or defer | 0 |
| 13 | Empty Knowledge Base | System | Defer message | 0 |
| 14 | Claude [DEFER] Marker | Post-AI | Claude can't answer → defer to Om | Yes |

### Dashboard (React SPA — 6 tabs)
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
- [x] **Pre-AI Filters** — Dedicated tab showing all 14 pre-AI rules
  - Summary cards: messages filtered, reached Claude, filter rate %
  - Visual pipeline flow showing message path through filters
  - Expandable filter details with description, state, action, keywords
  - Period selector (today/7 days/30 days)
  - Color-coded filter types (System, Message, Keyword, User, AI Match, Post-AI)
- [x] **Settings** — AI toggle, budget, thresholds, schedule, messages
- [x] **Sync** — Complete Knowledge Base Viewer
  - AI Instructions: Full system prompt + how knowledge is assembled
  - Processing Pipeline: Visual 10-step flow explanation
  - Configured Messages: Defer + media messages
  - Business Policies: MOQ, GST, payment terms, delivery info
  - Synced Catalog: All 21 products with prices, colors, sizes, descriptions
  - Synced Saved Replies: All 60 templates with content + media type
  - Defer-to-Ketu Rules: Om's corrections used for auto-defer
  - Sync History: Audit trail of past syncs

### Cost Control
- [x] Daily budget in INR (default Rs 500)
- [x] Per-message cost tracking (prompt + completion tokens)
- [x] Auto-reset at midnight
- [x] Budget bar in dashboard header
- [x] Smart chunk filtering reduces token usage by ~60-70%

### Intervention System
- [x] Om sends manual message → cooldown set (default 10 min)
- [x] Om edits AI reply → saved as defer-to-ketu correction
- [x] Corrections become style examples for future replies
- [x] Similar questions auto-defer (vector similarity > 85%)
- [x] Corrected replies used directly (0 tokens, no Claude call)

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
| `/api/filters/stats` | GET | Pre-AI filter statistics + rule definitions |
| `/api/knowledge/download` | GET | Full KB export |
| `/api/sync/all` | POST | Trigger full sync |
| `/api/sync/saved-replies` | POST | Sync saved replies only |
| `/api/sync/catalog` | POST | Sync catalog only |
| `/api/sync/style-pairs` | POST | Sync Om's style pairs |
| `/api/sync/logs` | GET | Sync history |
