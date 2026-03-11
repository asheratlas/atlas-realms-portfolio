# Dual Analytics in Framer Code Components (PostHog + GA4)

A production-ready pattern for tracking events from Framer code components with full UTM attribution — solving the async timing problem that makes most Framer analytics implementations silently fail.

---

## The Problems This Solves

### 1. PostHog fires before it loads

Framer injects analytics scripts asynchronously. Your code component mounts and fires events before `window.posthog` exists. Most tutorials stop at "add the script tag" — they don't tell you what happens next: your events disappear silently.

**Fix:** A retry loop that attempts to fire for up to 3 seconds, then gives up cleanly.

### 2. UTM params are lost between components

Each Framer code component is isolated. A user arrives from a LinkedIn post, clicks "Find Matches" — but by the time the results component fires its event, the UTM params in the URL are gone.

**Fix:** Capture UTMs on first page load, store in `sessionStorage`, merge into every event automatically.

### 3. Dual tracking without duplication

`posthog.capture()` and `gtag("event", ...)` have different signatures. Calling both consistently from every event requires either copy-paste or a shared helper that neither Framer tutorial provides.

**Fix:** A single `trackEvent()` function handles both providers with the same payload.

---

## The Pattern

### Step 1: Capture UTMs on Page Load

Add this to your primary Framer code component's `useEffect`:

```typescript
useEffect(() => {
    // Capture UTM params + referrer on first load, persist for the session
    const params = new URLSearchParams(window.location.search)
    const utms: Record<string, string> = {}
    
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
        const val = params.get(key)
        if (val) utms[key] = val
    }
    
    const ref = document.referrer
    if (ref) utms["referrer"] = ref
    
    if (Object.keys(utms).length > 0) {
        sessionStorage.setItem("app_utms", JSON.stringify(utms))
    }
}, [])
```

**Why `sessionStorage` and not a React state variable?**  
Framer code components don't share state. If the component that captures UTMs is different from the component that fires an event three user actions later, a React variable is gone. `sessionStorage` persists across all components for the lifetime of the tab.

---

### Step 2: The `trackEvent` Helper

Add this inside any Framer code component that needs to fire events:

```typescript
const trackEvent = (eventName: string, eventProps: Record<string, unknown>) => {
    // Merge stored UTM params into every event automatically
    const utmParams = (() => {
        try { return JSON.parse(sessionStorage.getItem("app_utms") || "{}") }
        catch { return {} }
    })()
    
    const enrichedProps = { ...utmParams, ...eventProps }
    
    // PostHog — retry if not yet loaded (async Framer injection timing)
    if (window.posthog?.capture) {
        window.posthog.capture(eventName, enrichedProps)
    } else {
        let attempts = 0
        const retry = setInterval(() => {
            if (window.posthog?.capture) {
                window.posthog.capture(eventName, enrichedProps)
                clearInterval(retry)
            } else if (++attempts >= 6) {
                clearInterval(retry)  // Give up after 3 seconds (6 × 500ms)
            }
        }, 500)
    }
    
    // Google Analytics 4
    window.gtag?.("event", eventName, enrichedProps)
}
```

---

### Step 3: Track Events

```typescript
// Example: search submitted
trackEvent("search_submitted", {
    user_session_id: userSessionId,
    attempt_id: attemptId,
    query_length: query.length,
    has_anchor_game: queryMentionsGame,
})

// Example: result engaged with
trackEvent("result_card_expanded", {
    user_session_id: userSessionId,
    attempt_id: attemptId,
    item_id: gameId,
    item_position: position,
    source_type: isVaultItem ? "inventory" : "external",
})

// Example: CTA clicked
trackEvent("cta_clicked", {
    user_session_id: userSessionId,
    attempt_id: attemptId,
    item_id: gameId,
    cta_type: "retail" | "used" | "vault",
})
```

---

## TypeScript Declarations

Add this to a `globals.d.ts` or at the top of your component file:

```typescript
declare global {
    interface Window {
        posthog?: {
            capture?: (event: string, props?: Record<string, unknown>) => void
        }
        gtag?: (command: string, event: string, params?: Record<string, unknown>) => void
    }
}
```

---

## Session + Attempt Architecture

For recommendation/search products, a two-level session model makes every event interpretable without a database join:

```typescript
// Session ID: generated once on component mount, persists in React state
const [userSessionId] = useState(() => `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)

// Attempt ID: generated fresh on each search, incremented per session
const [attemptCounter, setAttemptCounter] = useState(0)
const nextAttemptId = `att_${userSessionId}_${attemptCounter}`
```

**Why this matters:** Every event carries both IDs. You can ask "what happened in this session?" (filter by `user_session_id`) or "what happened for this specific search?" (filter by `attempt_id`) without reconstructing the sequence from timestamps.

---

## GA4 Custom Dimensions

GA4 won't show custom properties in reports by default. Register each one:

1. **GA4 Admin** → Data Display → Custom Definitions → Custom Dimensions
2. Add one dimension per property you want to query:
   - `user_session_id` (User scope)
   - `attempt_id` (Event scope)
   - `source_type` (Event scope)
   - `utm_source`, `utm_medium`, `utm_campaign` (User or Session scope)

Without this step, the data arrives in GA4 but only PostHog will show it in queries.

---

## Why Not Just PostHog?

PostHog covers all your in-product analytics with full event properties. GA4 adds:
- Google Search Console integration (organic search attribution)
- Google Ads integration (if you ever run campaigns)
- BigQuery export (free, powerful for ad-hoc queries at scale)

The cost of dual-tracking is one helper function. The optionality is worth it.

---

## What This Pattern Doesn't Cover

- **Server-side events** (e.g., backend API call completed) — requires sending events from your backend directly to PostHog's `/capture` endpoint or a Cloudflare Worker
- **Identity stitching** (associating anonymous sessions with logged-in users) — requires `posthog.identify()` at login time
- **Consent management / cookie banners** — requires wrapping `trackEvent` in a consent gate before firing
