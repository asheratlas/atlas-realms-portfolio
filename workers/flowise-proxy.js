/**
 * CLOUDFLARE WORKER — Flowise API Proxy
 *
 * The problem this solves:
 *   Framer (and most no-code frontends) run entirely in the browser. Any API
 *   key passed directly from the frontend is exposed in the network tab.
 *   This Worker sits between the browser and the Flowise pipeline, injecting
 *   the API key server-side from a Cloudflare secret — the browser never sees it.
 *
 * What this does:
 *   1. CORS enforcement — restricts requests to your production domain only
 *   2. Pre-flight handling — responds to OPTIONS requests for CORS compliance
 *   3. API key injection — adds the Flowise bearer token to every proxied request
 *
 * Environment variables (set via Cloudflare dashboard → Workers → Settings → Variables):
 *   FLOWISE_API_URL   Your Flowise pipeline endpoint
 *   FLOWISE_API_KEY   Flowise bearer token (stored as a secret, never in code)
 *
 * Deploy time: ~5 minutes. No KV bindings or cron triggers needed.
 */

export default {
    async fetch(request, env) {
        const ALLOWED_ORIGIN = 'https://www.yourdomain.com'; // restrict to your production domain
        const corsHeaders = {
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // CORS pre-flight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
        }

        try {
            const body = await request.json();

            const flowiseResponse = await fetch(env.FLOWISE_API_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.FLOWISE_API_KEY}`, // injected server-side
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            const data = await flowiseResponse.json();
            return new Response(JSON.stringify(data), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: corsHeaders,
            });
        }
    },
};
