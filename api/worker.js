/**
 * CCA Monitor API — Cloudflare Worker
 *
 * Serves auction data from GitHub with CORS, filtering, caching, tiered auth,
 * per-endpoint pricing, usage metering, and AI agent discovery.
 *
 * Deploy: cd api && npx wrangler deploy
 * Free tier: 100K requests/day (Cloudflare), 60 req/min per IP
 *
 * Endpoints (free — no API key):
 *   GET /api/v1/auctions          — auctions with basic fields
 *   GET /api/v1/auctions/:name    — single auction (basic fields)
 *   GET /api/v1/summary           — summary stats
 *   GET /                         — API docs
 *
 * Endpoints (pro — requires X-API-Key or Cloudflare agent wallet):
 *   GET /api/v1/auctions          — full fields incl. concentration, Q96 prices
 *   GET /api/v1/auctions/:name    — full single auction
 *   GET /api/v1/overlap           — bidder overlap matrix
 *   GET /api/v1/bidders           — bidder index (top bidders, cross-auction)
 *   GET /api/v1/concentration     — concentration metrics for all auctions
 *
 * Agent discovery:
 *   GET /.well-known/ai-plugin.json   — AI agent plugin manifest
 *   GET /api/v1/usage/:identity       — usage stats for an agent identity
 */

const AI_PLUGIN = {
  schema_version: 'v1',
  name_for_human: 'CCA Monitor API',
  name_for_model: 'cca_monitor',
  description_for_human: 'Query Continuous Clearing Auction (CCA) data from Uniswap V4 — auction results, bidder analytics, concentration metrics, and overlap matrices.',
  description_for_model: 'Access structured data about Uniswap V4 Continuous Clearing Auctions (CCAs). Retrieve auction results (clearing prices, floor prices, graduation status, bid counts), bidder concentration metrics (HHI, Gini, top-N share), bidder overlap/flow between auctions, and per-bidder cross-auction activity. Supports filtering by chain (mainnet, base), status (graduated, failed), and token search. Free tier provides basic auction fields; paid tier unlocks concentration, overlap, and bidder endpoints.',
  auth: {
    type: 'multi',
    methods: [
      { type: 'api_key', header: 'X-API-Key', description: 'Static API key for pro tier access. Contact @monkrus on Telegram or X.' },
      { type: 'cloudflare_agent_wallet', status: 'coming_soon', description: 'Cloudflare agent identity + wallet for autonomous pay-per-call access. Pay with stablecoins, no API key needed.' },
    ],
  },
  api: { type: 'openapi', url: 'https://cca-monitor-api.sergeigodev.workers.dev/.well-known/openapi.json', has_user_authentication: false },
  payment: {
    provider: 'cloudflare.pay',
    status: 'coming_soon',
    currency: 'USDC',
    pricing: {
      model: 'per_call',
      free_endpoints: ['/api/v1/auctions', '/api/v1/auctions/:name', '/api/v1/summary'],
      paid_endpoints: { '/api/v1/concentration': '$0.001', '/api/v1/overlap': '$0.001', '/api/v1/bidders': '$0.005' },
      note: 'Until cloudflare.pay launches, use an API key for pro endpoints.',
    },
  },
  logo_url: 'https://monkrus.github.io/cca-monitor/favicon.ico',
  contact_email: 'sergeigodev@gmail.com',
  legal_info_url: 'https://github.com/monkrus/cca-monitor',
};

const DATA_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/results.json';
const BIDDER_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/bidder-index.json';
const CACHE_TTL = 300; // 5 minutes

// ─── Per-endpoint pricing (USDC) ────────────────────────────────────────────
// Free endpoints cost nothing. Paid endpoints have a per-call price.
// These prices take effect when cloudflare.pay integration goes live.
const PRICING = {
  '/api/v1/auctions':      { tier: 'free', price: 0 },
  '/api/v1/summary':       { tier: 'free', price: 0 },
  '/api/v1/concentration': { tier: 'pro',  price: 0.001 },
  '/api/v1/overlap':       { tier: 'pro',  price: 0.001 },
  '/api/v1/bidders':       { tier: 'pro',  price: 0.005 },
};

// ─── Free-tier field allowlist ───────────────────────────────────────────────
const FREE_FIELDS = new Set([
  'name', 'chain', 'isTest', 'tokenName', 'tokenSymbol', 'tokenSupply',
  'startBlock', 'endBlock', 'durationHours', 'hasValidationHook',
  'currencySymbol', 'graduated', 'clearingPrice', 'floorPrice',
  'clearingVsFloor', 'currencyRaisedFormatted', 'totalBids', 'uniqueBidders',
  'flags',
]);

function stripToFree(auction) {
  const out = {};
  for (const key of FREE_FIELDS) {
    if (key in auction) out[key] = auction[key];
  }
  return out;
}

// ─── Rate limiting (per IP, in-memory) ──────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW = 60_000; // 1 minute
const FREE_RATE_LIMIT = 30;
const PRO_RATE_LIMIT = 300;

function checkRate(ip, isPro) {
  const now = Date.now();
  const limit = isPro ? PRO_RATE_LIMIT : FREE_RATE_LIMIT;
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    entry = { start: now, count: 0 };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  if (rateLimits.size > 10000) {
    for (const [k, v] of rateLimits) {
      if (now - v.start > RATE_WINDOW) rateLimits.delete(k);
    }
  }
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count), limit };
}

// ─── Pluggable authentication ───────────────────────────────────────────────
// Returns { tier: 'free'|'pro', method: 'none'|'api_key'|'agent_wallet', identity: string|null }
function authenticate(request, env) {
  // Method 1: Static API key (current)
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey) {
    const valid = (env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (valid.includes(apiKey)) {
      return { tier: 'pro', method: 'api_key', identity: `apikey:${apiKey.slice(0, 8)}...` };
    }
  }

  // Method 2: Cloudflare agent wallet identity (future — cloudflare.pay)
  // When the SDK ships, this will verify the agent's wallet signature and
  // check payment status. The header name follows Cloudflare's convention.
  const agentId = request.headers.get('CF-Agent-ID');
  const agentSig = request.headers.get('CF-Agent-Signature');
  if (agentId && agentSig) {
    // TODO: When cloudflare.pay SDK is available, replace this with:
    //   const verified = await env.AGENT_WALLETS.verify(agentId, agentSig);
    //   if (verified && verified.hasFunds) return { tier: 'pro', method: 'agent_wallet', identity: agentId };
    // For now, this path is inactive — agents should use API keys.
    return { tier: 'free', method: 'agent_wallet_pending', identity: agentId };
  }

  return { tier: 'free', method: 'none', identity: null };
}

// ─── Usage metering (Cloudflare KV) ─────────────────────────────────────────
// Tracks per-identity call counts and estimated spend per endpoint.
// Data is stored in KV with key format: usage:{identity}:{YYYY-MM}
async function recordUsage(env, auth, endpoint) {
  if (!env.USAGE || !auth.identity) return;

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `usage:${auth.identity}:${month}`;
  const price = PRICING[endpoint]?.price || 0;

  try {
    const raw = await env.USAGE.get(key, { type: 'json' });
    const usage = raw || { identity: auth.identity, month, totalCalls: 0, totalSpend: 0, endpoints: {} };

    usage.totalCalls++;
    usage.totalSpend = Math.round((usage.totalSpend + price) * 1e6) / 1e6; // avoid float drift

    if (!usage.endpoints[endpoint]) {
      usage.endpoints[endpoint] = { calls: 0, spend: 0 };
    }
    usage.endpoints[endpoint].calls++;
    usage.endpoints[endpoint].spend = Math.round((usage.endpoints[endpoint].spend + price) * 1e6) / 1e6;

    await env.USAGE.put(key, JSON.stringify(usage), { expirationTtl: 90 * 86400 }); // 90-day retention
  } catch {
    // Non-critical — don't fail the request if metering errors
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function fetchData(cacheApi, url) {
  const cacheKey = new Request(url);
  const cached = await cacheApi.match(cacheKey);
  if (cached) return cached.clone();

  const resp = await fetch(url);
  if (!resp.ok) return null;

  const response = new Response(resp.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
    },
  });
  await cacheApi.put(cacheKey, response.clone());
  return response;
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, CF-Agent-ID, CF-Agent-Signature');
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  return cors(new Response(JSON.stringify(data), { status, headers }));
}

// ─── Docs ───────────────────────────────────────────────────────────────────
const DOCS = {
  name: 'CCA Monitor API',
  version: '3.0',
  description: 'Uniswap V4 Continuous Clearing Auction analytics. Agent-friendly with pay-per-call pricing.',
  agent_discovery: '/.well-known/ai-plugin.json',
  tiers: {
    free: {
      rate: `${FREE_RATE_LIMIT} requests/minute`,
      price: 'Free',
      endpoints: [
        'GET /api/v1/auctions — basic auction data',
        'GET /api/v1/auctions/:name — single auction (basic)',
        'GET /api/v1/summary — summary stats',
      ],
    },
    pro: {
      rate: `${PRO_RATE_LIMIT} requests/minute`,
      price: 'Per-call (USDC) or API key',
      endpoints: [
        'GET /api/v1/auctions — full auction data ($0 with key)',
        'GET /api/v1/auctions/:name — full single auction ($0 with key)',
        'GET /api/v1/summary — summary stats + bidder insights ($0 with key)',
        'GET /api/v1/overlap — bidder overlap matrix ($0.001/call)',
        'GET /api/v1/bidders — bidder index ($0.005/call)',
        'GET /api/v1/concentration — concentration metrics ($0.001/call)',
      ],
      auth: [
        'X-API-Key header (current — DM @monkrus on Telegram or X)',
        'Cloudflare agent wallet (coming soon — pay-per-call with USDC)',
      ],
    },
  },
  pricing: {
    currency: 'USDC',
    model: 'per_call',
    status: 'API keys active. Cloudflare wallet payments coming soon.',
    endpoints: PRICING,
  },
  utility: {
    usage: 'GET /api/v1/usage/:identity — view your usage stats (pro)',
  },
  filters: {
    chain: 'mainnet, base, arbitrum, unichain',
    status: 'graduated, failed',
    hook: 'true, false',
    test: 'true (include test auctions)',
    q: 'search token name/symbol',
  },
  source: 'https://github.com/monkrus/cca-monitor',
  dashboard: 'https://monkrus.github.io/cca-monitor',
};

// ─── Main handler ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    // ── Agent discovery ───────────────────────────────────────────────────
    if (path === '/.well-known/ai-plugin.json') {
      return json(AI_PLUGIN);
    }

    // ── Docs (no rate limit) ──────────────────────────────────────────────
    if (path === '/' || path === '/api' || path === '/api/v1') {
      return json(DOCS);
    }

    // ── Auth + rate limit ─────────────────────────────────────────────────
    const auth = authenticate(request, env);
    const isPro = auth.tier === 'pro';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rate = checkRate(ip, isPro);
    const rateHeaders = {
      'X-RateLimit-Limit': String(rate.limit),
      'X-RateLimit-Remaining': String(rate.remaining),
      'X-API-Tier': auth.tier,
      'X-Auth-Method': auth.method,
    };

    if (!rate.ok) {
      return json(
        { error: 'Rate limit exceeded', limit: rate.limit, retry_after: '60s' },
        429,
        rateHeaders,
      );
    }

    // ── /api/v1/usage/:identity (pro only) ────────────────────────────────
    const usageMatch = path.match(/^\/api\/v1\/usage\/(.+)$/);
    if (usageMatch) {
      if (!isPro) {
        return json({ error: 'Pro access required' }, 403, rateHeaders);
      }
      if (!env.USAGE) {
        return json({ error: 'Usage metering not configured' }, 501, rateHeaders);
      }
      const identity = decodeURIComponent(usageMatch[1]);
      const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const key = `usage:${identity}:${month}`;
      const usage = await env.USAGE.get(key, { type: 'json' });
      if (!usage) {
        return json({ identity, month, totalCalls: 0, totalSpend: 0, endpoints: {} }, 200, rateHeaders);
      }
      return json(usage, 200, rateHeaders);
    }

    // ── Fetch main data ───────────────────────────────────────────────────
    const cacheApi = caches.default;
    const dataResp = await fetchData(cacheApi, DATA_URL);
    if (!dataResp) return json({ error: 'Failed to fetch data' }, 502, rateHeaders);
    const data = await dataResp.json();

    // Normalize endpoint path for metering (strip single-auction name)
    const meterPath = path.match(/^\/api\/v1\/auctions\/.+$/) ? '/api/v1/auctions' : path;

    // Record usage asynchronously (non-blocking)
    if (auth.identity) {
      const usagePromise = recordUsage(env, auth, meterPath);
      if (ctx?.waitUntil) {
        ctx.waitUntil(usagePromise);
      } else {
        usagePromise.catch(() => {});
      }
    }

    // ── /api/v1/summary ──────────────────────────────────────────────────
    if (path === '/api/v1/summary') {
      const summary = { ...data.summary };
      if (!isPro) {
        delete summary.bidderInsights;
        delete summary.overlapMatrix;
      }
      return json({ timestamp: data.timestamp, summary }, 200, rateHeaders);
    }

    // ── /api/v1/overlap (pro only) ───────────────────────────────────────
    if (path === '/api/v1/overlap') {
      if (!isPro) {
        return json(
          { error: 'Pro access required', pricing: '$0.001/call', auth_options: DOCS.tiers.pro.auth },
          403,
          rateHeaders,
        );
      }
      return json({ overlapMatrix: data.summary?.overlapMatrix || {} }, 200, rateHeaders);
    }

    // ── /api/v1/concentration (pro only) ─────────────────────────────────
    if (path === '/api/v1/concentration') {
      if (!isPro) {
        return json(
          { error: 'Pro access required', pricing: '$0.001/call', auth_options: DOCS.tiers.pro.auth },
          403,
          rateHeaders,
        );
      }
      const real = data.auctions.filter(a => !a.isTest && a.concentration);
      const result = real.map(a => ({
        name: a.name,
        chain: a.chain,
        tokenSymbol: a.tokenSymbol,
        graduated: a.graduated,
        concentration: a.concentration,
      }));
      return json({ timestamp: data.timestamp, count: result.length, auctions: result }, 200, rateHeaders);
    }

    // ── /api/v1/bidders (pro only) ───────────────────────────────────────
    if (path === '/api/v1/bidders') {
      if (!isPro) {
        return json(
          { error: 'Pro access required', pricing: '$0.005/call', auth_options: DOCS.tiers.pro.auth },
          403,
          rateHeaders,
        );
      }
      const bidderResp = await fetchData(cacheApi, BIDDER_URL);
      if (!bidderResp) return json({ error: 'Bidder data unavailable' }, 502, rateHeaders);
      const bidders = await bidderResp.json();
      const count = typeof bidders === 'object' ? Object.keys(bidders).length : 0;
      return json({ count, bidders }, 200, rateHeaders);
    }

    // ── /api/v1/auctions/:name ───────────────────────────────────────────
    const singleMatch = path.match(/^\/api\/v1\/auctions\/(.+)$/);
    if (singleMatch) {
      const name = decodeURIComponent(singleMatch[1]).toLowerCase();
      const auction = data.auctions.find(
        a => a.name?.toLowerCase() === name ||
             a.tokenSymbol?.toLowerCase() === name
      );
      if (!auction) return json({ error: 'Auction not found' }, 404, rateHeaders);
      return json(isPro ? auction : stripToFree(auction), 200, rateHeaders);
    }

    // ── /api/v1/auctions ─────────────────────────────────────────────────
    if (path === '/api/v1/auctions') {
      let auctions = data.auctions;

      const includeTest = url.searchParams.get('test') === 'true';
      if (!includeTest) {
        auctions = auctions.filter(a => !a.isTest);
      }

      const chain = url.searchParams.get('chain');
      if (chain) auctions = auctions.filter(a => a.chain === chain.toLowerCase());

      const status = url.searchParams.get('status');
      if (status === 'graduated') auctions = auctions.filter(a => a.graduated === true);
      else if (status === 'failed') auctions = auctions.filter(a => a.graduated === false);

      const hook = url.searchParams.get('hook');
      if (hook === 'true') auctions = auctions.filter(a => a.hasValidationHook);
      else if (hook === 'false') auctions = auctions.filter(a => !a.hasValidationHook);

      const q = url.searchParams.get('q');
      if (q) {
        const lower = q.toLowerCase();
        auctions = auctions.filter(a =>
          (a.name || '').toLowerCase().includes(lower) ||
          (a.tokenSymbol || '').toLowerCase().includes(lower) ||
          (a.tokenName || '').toLowerCase().includes(lower)
        );
      }

      return json({
        timestamp: data.timestamp,
        count: auctions.length,
        tier: auth.tier,
        auctions: isPro ? auctions : auctions.map(stripToFree),
      }, 200, rateHeaders);
    }

    return json({ error: 'Not found', docs: '/' }, 404, rateHeaders);
  },
};
