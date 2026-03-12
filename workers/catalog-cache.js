/**
 * CLOUDFLARE WORKER — KV-Backed Catalog Cache
 *
 * The problem this solves:
 *   Hitting a database (Airtable, Supabase, etc.) on every query is slow and
 *   expensive at scale. This Worker fetches the full catalog once, stores it
 *   in Cloudflare KV, and serves it from the edge on subsequent requests —
 *   reducing database calls by ~99% per query window.
 *
 * What this does:
 *   1. GET /api/catalog        — serves the cached catalog to server-side consumers
 *   2. POST /api/catalog/refresh — forces a manual cache refresh (e.g. after editing data)
 *   3. Cron trigger            — automatically refreshes the cache on a schedule
 *   4. Stale-while-revalidate  — if the database is unreachable during a refresh,
 *                                serves the last known good data rather than failing
 *
 * Environment variables (Cloudflare dashboard → Workers → Settings → Variables):
 *   AIRTABLE_API_KEY       Personal access token with read scope
 *   AIRTABLE_BASE_ID       Your Airtable base ID (appXXXXXXXXXXX)
 *   AIRTABLE_EX_TABLE_NAME Table name for the main catalog
 *   AIRTABLE_IN_TABLE_NAME Table name for owned/inventory items
 *   CACHE_SECRET           Shared secret sent in X-Cache-Secret header
 *                          (prevents the endpoint from being scraped publicly)
 *
 * KV namespace binding (Cloudflare dashboard → Workers → Bindings):
 *   YOUR_KV_NAMESPACE      KV namespace bound to this worker
 *
 * Cron trigger (wrangler.toml or Cloudflare dashboard → Workers → Triggers):
 *   e.g. "0 *\/12 * * *"  — every 12 hours
 */

// ============================================================
// CONFIG
// ============================================================

const CACHE_KEY  = 'your_cache_key';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const VIEW_NAME  = 'Your Airtable View';   // view that filters to publishable records only

// Field projections — only fetch what each table needs.
// Actual field names are proprietary; the pattern is the point.
// Two arrays share a common core, each extended with table-specific fields.
const SHARED_FIELDS = [
    'Title',
    'Players_min', 'Players_max',
    'Playtime_bucket', 'Play_min_minutes', 'Play_max_minutes',
    // ... logistics fields
    // ... taxonomy dimension fields (mechanics, categories, weight, etc.)
    // ... display fields (summary, image URL, external links)
];

const INVENTORY_FIELDS = [...SHARED_FIELDS]; // + inventory-specific fields (condition, price, etc.)
const EXTERNAL_FIELDS  = [...SHARED_FIELDS]; // + catalog-specific fields  (affiliate links, popularity, etc.)

// ============================================================
// AIRTABLE HELPERS
// ============================================================

/**
 * Paginates through all Airtable records for a given table.
 * Airtable returns max 100 records per page; this loops until exhausted.
 * Hard cap at 2,000 records to prevent runaway fetches.
 */
async function fetchAllPages(baseId, table, fields, apiKey) {
    let records = [];
    let offset = null;
    const baseUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
    const fieldParams = fields.map(f => `fields%5B%5D=${encodeURIComponent(f)}`).join('&');

    do {
        const parts = ['pageSize=100', `view=${encodeURIComponent(VIEW_NAME)}`, fieldParams];
        if (offset) parts.push(`offset=${encodeURIComponent(offset)}`);
        const url = `${baseUrl}?${parts.join('&')}`;

        const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Airtable fetch failed: ${table} ${res.status} — ${body}`);
        }

        const data = await res.json();
        if (data.records) records.push(...data.records);
        offset = data.offset || null;
    } while (offset && records.length < 2000);

    return records;
}

/** Fetches both tables concurrently. Both fetches are read-only, so Promise.all is safe. */
async function fetchFromAirtable(env) {
    const { AIRTABLE_API_KEY: key, AIRTABLE_BASE_ID: base, AIRTABLE_EX_TABLE_NAME: extTable, AIRTABLE_IN_TABLE_NAME: invTable } = env;
    if (!key || !base || !extTable || !invTable) throw new Error('Missing Airtable env vars');

    const [external, inventory] = await Promise.all([
        fetchAllPages(base, extTable, EXTERNAL_FIELDS, key),
        fetchAllPages(base, invTable, INVENTORY_FIELDS, key),
    ]);

    return { external, inventory };
}

// ============================================================
// KV CACHE HELPERS
// ============================================================

async function getCache(env) {
    try { return await env.YOUR_KV_NAMESPACE.get(CACHE_KEY, 'json'); }
    catch { return null; }
}

async function setCache(env, data) {
    await env.YOUR_KV_NAMESPACE.put(CACHE_KEY, JSON.stringify({ cached_at: Date.now(), data }));
}

function isCacheFresh(entry) {
    if (!entry?.cached_at) return false;
    return (Date.now() - entry.cached_at) < CACHE_TTL_MS;
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

/**
 * GET /api/catalog
 * Server-to-server endpoint — not intended for browser access.
 * Protected by a shared secret header to prevent public scraping.
 *
 * Cache strategy:
 *   HIT   → return cached data immediately
 *   MISS  → fetch from Airtable, populate cache, return fresh data
 *   STALE → Airtable failed but stale cache exists: serve stale rather than 502
 *   ERROR → no cache + Airtable failed: 502
 */
async function handleCatalog(request, env) {
    const secret = request.headers.get('X-Cache-Secret');
    if (!secret || secret !== env.CACHE_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const cached = await getCache(env);
    if (isCacheFresh(cached)) {
        return new Response(JSON.stringify(cached.data), {
            headers: {
                'Content-Type': 'application/json',
                'X-Cache': 'HIT',
                'X-Cache-Age': `${Math.floor((Date.now() - cached.cached_at) / 1000)}s`,
            },
        });
    }

    try {
        const data = await fetchFromAirtable(env);
        await setCache(env, data);
        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
        });
    } catch (error) {
        if (cached) {
            console.error('Airtable refresh failed, serving stale cache:', error.message);
            return new Response(JSON.stringify(cached.data), {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Cache': 'STALE',
                    'X-Cache-Error': error.message,
                },
            });
        }
        return new Response(JSON.stringify({ error: error.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

/**
 * POST /api/catalog/refresh
 * Forces an immediate cache refresh — useful after editing catalog data
 * without waiting for the next cron cycle.
 */
async function handleCacheRefresh(request, env) {
    const secret = request.headers.get('X-Cache-Secret');
    if (!secret || secret !== env.CACHE_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        const data = await fetchFromAirtable(env);
        await setCache(env, data);
        return new Response(JSON.stringify({
            success: true,
            external: data.external.length,
            inventory: data.inventory.length,
            cached_at: new Date().toISOString(),
        }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// ============================================================
// SCHEDULED HANDLER (Cron Trigger)
// ============================================================

/**
 * Runs on a cron schedule to pre-warm the cache.
 * Prevents the first request after cache expiry from incurring Airtable latency.
 */
async function refreshCache(env) {
    try {
        console.log('Scheduled cache refresh starting...');
        const data = await fetchFromAirtable(env);
        await setCache(env, data);
        console.log(`Cache refreshed: ${data.external.length} external, ${data.inventory.length} inventory`);
    } catch (error) {
        console.error('Scheduled cache refresh failed:', error.message);
    }
}

// ============================================================
// MAIN EXPORT
// ============================================================

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/catalog' && request.method === 'GET') {
            return handleCatalog(request, env);
        }

        if (url.pathname === '/api/catalog/refresh' && request.method === 'POST') {
            return handleCacheRefresh(request, env);
        }

        return new Response('Not found', { status: 404 });
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(refreshCache(env));
    },
};
