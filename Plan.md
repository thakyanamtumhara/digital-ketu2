# WhatsApp Auto-Reply System — Master Plan

**Project Owner:** Om (BulkPlainTshirt.com / sale91.com)
**Last Updated:** March 9, 2026
**Status:** Planning Phase

---

## 1. System Overview

An AI-powered auto-reply system for WhatsApp that answers buyer queries using a curated knowledge base and Om's communication style. The system uses the WhatsApp API (repo access + token) to read incoming messages and send replies via Claude.

---

## 2. Knowledge Base (3 Sources — Small & Focused)

The knowledge base is intentionally kept **lean and high-quality**. No big warehouse of data.

### Source 1: Saved Replies from WhatsApp Repo
- Om already saves quality replies in the WhatsApp repo.
- These saved replies become the primary FAQ/knowledge base.
- These are pre-vetted by Om — highest quality filter possible.
- No need for real-time chat extraction or pair processing.

### Source 2: Product Catalog (Separate Repo)
- Product details, pricing, sizes, fabric info — all comes from **sale91.com/catalog**.
- This is a separate catalog repo that Om maintains and updates.
- AI reads product info directly from here — never extracted from manual chats.

### Source 3: Communication Style
- Extracted once from analyzing Om's saved replies.
- Covers: tone, language (Hinglish mix), greeting style, closing style, formality level, negotiation approach.
- Stored as a small style guide document (20-30 rules).
- Refined over time.

### What to Extract from Saved Replies (Beyond Product Info)
- **FAQ pairs** — Top 50-100 repeated buyer questions and best answers
- **Objection handling** — Responses to "too expensive", "discount do", "other seller cheaper", etc. (15-20 common objections)
- **Negotiation patterns** — When/how discounts are offered, typical negotiation flow
- **Buyer intent detection** — How to identify serious vs browsing buyers
- **Upselling/cross-selling patterns** — Suggesting related items or bulk deals
- **Closing techniques** — How to push toward a sale (urgency, offers, follow-up)
- **Regional/language adaptation** — Hindi/English switching based on buyer
- **Common policies** — Payment terms, shipping charges, MOQ, delivery timeline, returns

### Knowledge Base Sync Schedule
The system connects to Om's WhatsApp repo via **API token** and syncs automatically.

- **Saved Replies:** Sync once every **3-4 days** (Om doesn't change these often)
- **Product Catalog:** Sync once every **3-4 days** (catalog updates are infrequent)
- **Connection method:** WhatsApp repo API token (provided by Om)
- **Sync is automatic** — no manual action needed from Om
- After each sync, the knowledge base (vector embeddings) is rebuilt with any new/updated content
- Dashboard shows: last sync time, next scheduled sync, number of changes detected

---

## 3. How AI Generates Replies (RAG Approach)

The AI does **NOT** read the entire knowledge base for every reply. That would be too expensive and slow.

### Flow:
1. **Buyer sends a question**
2. **Search step (fast, cheap):** System searches the knowledge base using vector/embedding search and pulls only the **relevant chunks** (5-10 small pieces)
3. **Generate step (Claude):** Only those relevant chunks + communication style are sent to Claude
4. **Claude generates reply** that sounds like Om and has accurate info

### Result:
- Even if knowledge base grows, each reply uses only a small portion
- Token cost stays **low and predictable**
- Better results because AI focuses on relevant info only

### What Exactly Gets Sent to Claude (Prompt Structure)
For every buyer message, the system builds a prompt with exactly **5 components**:

| # | Component | What it contains | Changes per message? | Estimated tokens |
|---|-----------|-----------------|---------------------|-----------------|
| 1 | Instructions | System rules (cooldown, merge, first-time buyer, guide to website, etc.) | No — fixed every time | ~300-500 |
| 2 | Style Guide | Om's communication tone, language, greeting/closing style | No — fixed every time | ~100-200 |
| 3 | Knowledge chunks | Relevant pieces from saved replies + catalog (pulled via vector search) | Yes — different per question | ~200-500 |
| 4 | Conversation history | Last **5 messages** from this buyer's conversation | Yes — changes as conversation progresses | ~100-300 |
| 5 | Buyer's message | The actual new question from the buyer | Yes — unique every time | ~20-50 |

**Estimated total per reply: ~700-1500 input tokens + output tokens for the reply**

**Notes on conversation history:**
- Only the **last 5 messages** are included (not entire conversation)
- This allows AI to understand follow-up questions like "aur polo ka?" after a pricing discussion
- Keeps token cost low while maintaining conversational context
- If conversation has fewer than 5 messages, include whatever is available

---

## 4. Message Handling Rules

### 4.1 Incoming Message Merging
- Buyer may send multiple messages quickly, breaking one thought into several messages.
- **Rule:** If the same person sends multiple messages with **≤ 3 seconds gap** between consecutive messages, **merge them into one message**.
- Once there's a gap of **> 3 seconds**, the buyer is considered done.
- AI then processes the merged message and sends **one single reply** covering everything.
- **Never reply to each individual message separately.**

### 4.2 Reply Behavior
- Always reply **once** per buyer thought (merged messages = one thought).
- Do not send multiple reply messages for one buyer thought.

### 4.3 Media Message Handling (Images, Audio, Video, Documents)
- AI **cannot process media** — it can only read text messages.
- If a buyer sends any media (image, audio, video, document, voice note), the AI replies politely asking them to write in text.
- Tone: Friendly, not robotic. Make it feel like Ketu's assistant is responding.
- Example reply: "Sir, Ketu is not available right now. I'm not able to see images or listen to audio at the moment — could you please write your query in text? I'll read and reply right away."
- This applies to all media types — images, voice notes, videos, PDFs, etc.
- If the buyer sends a media message **along with text**, process the text normally and ignore the media. No need to ask them to write again since they already did.

### 4.4 Spam / Abuse Handling
- If AI detects spam or abusive behavior (nonsense messages, abusive language, repeated junk), **simply don't reply**. No response at all.
- No automated blocking — Om will manually handle these situations when he sees them on the dashboard.

### 4.5 Duplicate Message Protection (Technical Safeguard)
- WhatsApp webhooks can sometimes deliver the **same message twice** due to a technical glitch.
- Every WhatsApp message has a unique **message ID**.
- Before processing any message, the server checks: "Have I already processed this message ID?"
- If yes → **ignore it** (don't reply again).
- If no → process normally.
- This prevents the AI from sending duplicate replies to the same buyer message.

---

## 5. First-Time Buyer Rule

- If a buyer is messaging for the **first time ever**, the AI reply **must always include** the catalog link: **sale91.com/catalog**
- This applies regardless of what the buyer's first message is.
- Example: Buyer asks "What's your price for round neck?" → AI answers the question AND includes the catalog link.
- Ensures every new buyer sees the full product range immediately.

---

## 5.1 Purchase Direction Rule — Always Guide to Website

Buyers come from many sources — YouTube, IndiaMART, direct calls, word of mouth — but the **purchase destination is always sale91.com**.

- When a buyer shows **buying intent** (asking about pricing, MOQ, how to order, payment, etc.), the AI should **nicely guide them to buy from the website**.
- Suggest buying **samples from the website** first — this is a soft, helpful approach.
- Tone should be friendly and helpful, not pushy. Example: "You can check out our full catalog and order samples directly from sale91.com — it's the quickest way to get started!"
- **Always share the website link** (sale91.com) when purchase intent is detected.
- This rule applies regardless of where the buyer came from.

---

## 6. Manual Intervention & Cooldown

### 6.1 When Om Intervenes
- AI replies to a buyer.
- Om sees the reply and decides it's not good enough.
- Om sends his own manual reply in that conversation.

### 6.2 Detection
- WhatsApp API can distinguish between automated messages (sent by API) and manual messages (sent from phone).
- When a manual outgoing message appears in a conversation where AI is active → **intervention detected**.

### 6.3 Cooldown Rule
- Once Om sends a manual message, AI **cools down for 10 minutes** in that conversation.
- Timer starts from **Om's last manual message**.
- If Om sends another manual message at minute 7, timer **resets** — new 10 minutes from that point.
- AI resumes **10 minutes after Om's last manual message**, regardless of buyer activity.
- If buyer sent unanswered messages during cooldown, AI picks them up after cooldown ends.

### 6.4 Intervention ≠ AI Was Wrong
**Important:** Intervention only means Om took over the conversation. It does NOT mean the AI reply was wrong. Om may intervene to add extra info, handle a VIP buyer personally, or for any other reason. The system makes **no assumption** about right or wrong when intervention happens. Only cooldown is triggered.

### 6.5 Edit Button on WhatsApp Repo App — Marking AI as Wrong
The "AI was wrong" signal comes from a **separate action** — an **Edit button** placed on the WhatsApp repo app (not the dashboard).

**How it works:**
1. Om reads conversations in the WhatsApp repo app (already his workflow).
2. Every AI-sent reply has an **Edit button** next to it.
3. Om sees a wrong AI reply → clicks Edit on that specific reply.
4. A **text box** opens → Om types the correct response.
5. Om clicks **Save**.
6. WhatsApp repo app sends a webhook/API call to the auto-reply server with:
   - The **buyer's question** that triggered the AI reply
   - The **AI's wrong reply**
   - **Om's correct reply** (what he typed in the edit box)
7. Auto-reply server saves this to the **"Defer to Ketu" list** with embeddings.

**Key point:** This Edit button is added to the WhatsApp repo codebase (using Om's fine-grained token with code read/write access). Om never needs to leave the WhatsApp app to mark something as wrong.

### 6.6 "Defer to Ketu" — Auto-Skip for Failed Question Types
Questions marked wrong via the Edit button get added to the **"Defer to Ketu" list** — a separate list of question types that AI should not attempt to answer.

**How it works on future messages:**
1. New buyer asks a question
2. System first checks similarity against the "Defer to Ketu" list (using embedding/vector comparison)
3. If **85%+ similarity match** found → AI does NOT call Claude, instead replies: **"Ketu will get back to you shortly on this."**
4. If no match → proceed normally with Claude

**Benefits:**
- Saves tokens — no Claude API call for deferred questions
- No wrong answers — AI doesn't attempt what it already failed at
- Zero cost — similarity check is local, no API needed

**Dashboard — Defer to Ketu Manager:**
- Shows the full list of deferred question types
- Each entry shows: the original buyer question, date it was added, how many times it has been triggered since
- **Delete button** next to each entry — when Om adds a proper answer to saved replies for that question type, he removes it from the defer list and AI starts handling it again
- **Customizable defer message:** The "Ketu will get back to you shortly" message is **editable from the dashboard**. Om can change this text anytime (e.g., "Our team will respond shortly" or "Ketu bhai thodi der mein reply karenge"). Same message is used for both defer-to-Ketu and low-confidence fallback.

**Flow:**
```
New buyer question
       ↓
Check "Defer to Ketu" list (similarity match?)
       ↓                          ↓
   YES (≥85%)                  NO (no match)
       ↓                          ↓
Reply: "Ketu will get       Proceed with normal
back to you shortly"        Claude AI reply flow
(no Claude API call)
```

### 6.7 Low Confidence Fallback — Defer to Ketu
Even if a question doesn't match the "Defer to Ketu" list, the AI may still not have a good answer. This happens when the knowledge base search returns **low similarity results** — meaning no saved reply or catalog entry is relevant to what the buyer asked.

**Rule:** After searching the knowledge base, if the best match similarity score is **below 60%**, do NOT call Claude. Instead reply: **"Ketu will get back to you shortly on this."**

**Example:** Buyer asks "Do you do custom embroidery on t-shirts?" but there's no saved reply about embroidery. Search returns "round neck pricing" as closest match at 35% similarity → too low → defer to Ketu.

**Complete message flow with all checks:**
```
New buyer message
       ↓
Is it media only? ──YES──▶ "Please write in text, can't view media"
       ↓ NO
Merge messages (≤3 sec gap)
       ↓
Is buyer first-time? ──YES──▶ Include sale91.com/catalog in reply
       ↓
Check "Defer to Ketu" list (≥85% match?)
       ↓ YES                    ↓ NO
"Ketu will get back       Search knowledge base
to you shortly"           (saved replies + catalog)
                               ↓
                    Best match similarity ≥60%?
                     ↓ YES              ↓ NO
               Build prompt &      "Ketu will get back
               call Claude API     to you shortly"
                     ↓
               Send AI reply
```

---

## 7. Architecture Summary

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  WhatsApp    │────▶│  Auto-Reply      │────▶│   Claude    │
│  API/Repo    │◀────│  Server          │◀────│   API       │
└─────────────┘     └──────────────────┘     └─────────────┘
                            │
                   ┌────────┼────────┐
                   │        │        │
             ┌─────▼─────┐ ┌▼──────┐ ┌▼────────────┐
             │ Knowledge  │ │Defer  │ │ Intervention │
             │ Base       │ │to Ketu│ │ Log          │
             │ (Vector DB)│ │ List  │ │ (Learning)   │
             └───────────┘ └───────┘ └──────────────┘

Knowledge Base Sources:
├── Saved Replies (from WhatsApp repo)
├── Product Catalog (sale91.com/catalog)
└── Communication Style Guide
```

---

## 8. Live Monitor Dashboard (Analytics & Cost Tracking)

The app dashboard shows a **real-time feed** of every AI interaction, so Om can see exactly what's happening and what it's costing.

### 8.1 Per-Message Live Log
For every buyer message, the dashboard shows the complete pipeline:

1. **Incoming message** — the raw message received from the buyer (after merging if applicable)
2. **Knowledge search** — which chunks were pulled from the knowledge base (saved replies, catalog, style guide) and how many
3. **Catalog lookup** — if the buyer asked about a product, show that the system checked the catalog, which product was matched, and the pricing info retrieved
4. **Claude API call** — the full prompt sent to Claude (buyer question + relevant chunks + style instructions)
5. **Generated reply** — the reply Claude produced
6. **Token usage breakdown:**
   - Input tokens (prompt sent to Claude)
   - Output tokens (reply generated by Claude)
   - Total tokens for this message
   - Cost in USD for this message
7. **Status** — sent / cooldown (Om intervened) / failed

### 8.2 Aggregate Analytics
- **Total messages received** (today / this week / this month)
- **Total AI replies sent**
- **Total interventions** (where Om took over)
- **Total tokens used** (input + output, with cost in USD)
- **Average tokens per reply**
- **Average cost per reply**
- **Most asked questions** (top queries by frequency)
- **Intervention rate** (% of conversations where Om had to step in)

### 8.3 Live Process View
A real-time visual flow for each message showing:
```
Buyer Message → Merge Check → Knowledge Search → Catalog Check → Claude API → Reply Sent
     ↓              ↓              ↓                  ↓              ↓           ↓
  [raw text]    [merged?]    [chunks found]    [product match]  [tokens used] [final reply]
```
Each step shows timing (how many ms it took) and token/cost impact.

---

## 9. Knowledge Base Download

- A **"Download Knowledge"** button on the dashboard.
- Downloads the **entire knowledge base** as a single file (JSON or readable format).
- Includes:
  - All saved reply pairs (FAQ)
  - Communication style guide
  - Objection handling entries
  - Policy entries
  - Catalog reference (or link to catalog repo)
  - Intervention corrections (AI wrong answer → Om's correct answer)
- Om can review, edit offline, and re-upload if needed.
- Acts as a backup and a way to audit what the AI knows.

---

## 10. Infrastructure — Railway

### 10.1 Vector Database: Railway PostgreSQL + pgvector
- Use **existing Railway PostgreSQL** database — no new service needed.
- Enable **pgvector extension** for smart similarity search on knowledge base.
- All saved replies and catalog entries stored as vector embeddings in PostgreSQL.
- When buyer asks a question → pgvector finds the most relevant chunks by meaning (not exact words).
- Setup: `CREATE EXTENSION vector;` on existing Railway PostgreSQL.

### 10.2 What Runs on Railway (Everything)
| Component | Technology | Purpose |
|-----------|-----------|---------|
| WhatsApp Business API | Already deployed on Railway | Send/receive messages, saved replies |
| PostgreSQL + pgvector | Already running on Railway | Knowledge base storage + smart search |
| Auto-Reply Server | Node.js (or Rust) | Handles webhook, message merging, cooldown logic, prompt building, Claude API calls |
| Dashboard Frontend + API | Railway | Web UI for live monitor, analytics, controls, knowledge download |

### 10.3 External APIs (Only 2)
| Service | Purpose |
|---------|---------|
| Claude API (Anthropic) | Generate replies — needs API key from Om |
| Product Catalog (sale91.com/catalog repo) | Product info source |

### 10.4 Toggle & Schedule (Working Hours)
- **Global toggle:** Simple ON/OFF switch on the dashboard. Toggle ON → AI replies. Toggle OFF → AI stops.
- **Schedule option:** Set active hours (e.g., 9 AM - 9 PM, or 24/7, or custom per day). During scheduled hours, AI is active. Outside, it's off.
- Toggle overrides schedule — if Om toggles OFF during active hours, AI stops immediately.
- **Connection:** Om provides a fine-grained WhatsApp repo token. Auto-reply server connects to WhatsApp repo endpoints on Railway. Om creates a Railway project, server hooks into it.

### 10.5 Daily Spending Limit
- Dashboard has a **daily budget field** where Om sets the max spend per 24 hours (in INR).
- Default: **₹500/day** (can be changed anytime from dashboard).
- System tracks token cost in real-time for every Claude API call.
- Once daily spend hits the limit → **AI stops replying for the rest of the day**. Messages are left for Om to handle manually.
- Resets at midnight (or configurable reset time).
- Dashboard shows: amount spent today / daily limit, with a progress bar.
- **Warning alert** at 80% usage (e.g., at ₹400 spent) — so Om knows the limit is approaching.
- Protects against unexpected spikes, spam, or abuse.

### 10.6 Sync Jobs (Run on Railway)
- **Saved Replies Sync:** Every 3-4 days, pull saved replies from WhatsApp repo → regenerate embeddings → update pgvector
- **Catalog Sync:** Every 3-4 days, pull product catalog from **GitHub repo via GitHub API** (using fine-grained token with Content: Read access) → parse product data → regenerate embeddings → update pgvector. No crawling/scraping — direct file read from GitHub.
- **Sync Now button:** Triggers immediate sync from dashboard

---

## 11. Key Design Decisions

| Decision | Chosen Approach | Reason |
|----------|----------------|--------|
| Knowledge source | Saved replies only | No need for real-time chat extraction; saved replies are pre-vetted quality |
| Product info | Separate catalog repo | Kept updated independently; not extracted from chats |
| Knowledge base size | Small & focused | Better search results, fewer irrelevant chunks, lower cost |
| Message merging | ≤ 3 sec gap = same thought | Handles broken thoughts; one reply per thought |
| Intervention cooldown | 10 min from last manual msg | Gives Om time to handle conversation without AI interference |
| Wrong reply marking | Edit button on WhatsApp repo app | Om stays in his natural workflow; no dashboard switching |
| Reply frequency | One reply per buyer thought | Avoids spamming buyer with multiple AI messages |
| Vector database | Railway PostgreSQL + pgvector | Already running, no extra cost, no new platform |
| Hosting | Railway (everything) | Already in use, WhatsApp Business API already deployed there |
| Working hours | Schedule option on dashboard | Configurable when AI is active |
| Cost protection | ₹500/day spending cap | Protects against spikes, spam, or abuse |

---

## 12. What Om Needs to Provide (Checklist Before Building)

⚠️ **Claude Code / Om: Before starting development, go through this checklist and collect all items.**

| # | What | Details | Status |
|---|------|---------|--------|
| 1 | WhatsApp repo token | Fine-grained token for WhatsApp Business API on Railway. Needs: read messages, send messages, read saved replies. **Plus code read/write access** for adding the Edit button to the WhatsApp repo app UI. | Pending |
| 2 | Anthropic API key | For Claude API to generate replies. | Pending |
| 3 | GitHub token (catalog repo) | **Fine-grained token with Content: Read access** to the catalog repo. Used to pull product data via GitHub API every 3-4 days. | Pending |
| 4 | Railway access | Project setup for auto-reply server. Om creates the Railway project. | Already have |
| 5 | Catalog repo name/URL | The GitHub repo where product catalog is stored. | Pending |
| 6 | WhatsApp repo name/URL | The Railway-deployed WhatsApp Business API endpoint details. | Pending |

---

## 13. Pending / To Be Decided

- [ ] WhatsApp repo token handover (including code read/write for Edit button)
- [ ] Railway project setup for auto-reply server
- [ ] Push notification to Om when AI defers to Ketu (so Om knows a buyer is waiting)
- [ ] Edit button UI implementation on WhatsApp repo app

---

*This document will be updated as more plan details are shared.*
