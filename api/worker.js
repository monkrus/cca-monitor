/**
 * CCA Monitor API — Cloudflare Worker
 *
 * Serves auction data from GitHub with CORS, filtering, caching, and API key tiers.
 * Deploy: cd api && npx wrangler deploy
 * Free tier: 100K requests/day (Cloudflare), 60 req/min per IP
 *
 * Endpoints (free — no API key):
 *   GET /api/v1/auctions          — auctions with basic fields
 *   GET /api/v1/auctions/:name    — single auction (basic fields)
 *   GET /api/v1/summary           — summary stats
 *   GET /                         — API docs
 *
 * Endpoints (pro — requires X-API-Key header):
 *   GET /api/v1/auctions          — full fields incl. concentration, Q96 prices
 *   GET /api/v1/auctions/:name    — full single auction
 *   GET /api/v1/overlap           — bidder overlap matrix
 *   GET /api/v1/bidders           — bidder index (top bidders, cross-auction)
 *   GET /api/v1/concentration     — concentration metrics for all auctions
 */

const DATA_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/results.json';
const BIDDER_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/bidder-index.json';
const CACHE_TTL = 300; // 5 minutes

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
  // Prune old entries periodically
  if (rateLimits.size > 10000) {
    for (const [k, v] of rateLimits) {
      if (now - v.start > RATE_WINDOW) rateLimits.delete(k);
    }
  }
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count), limit };
}

// ─── API key validation ─────────────────────────────────────────────────────
function validateKey(request, env) {
  const key = request.headers.get('X-API-Key');
  if (!key) return false;
  // Keys stored as comma-separated list in env var
  const valid = (env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  return valid.includes(key);
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
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  return cors(new Response(JSON.stringify(data), { status, headers }));
}

// ─── Docs ───────────────────────────────────────────────────────────────────
const DOCS = {
  name: 'CCA Monitor API',
  version: '2.0',
  tiers: {
    free: {
      rate: `${FREE_RATE_LIMIT} requests/minute`,
      endpoints: [
        'GET /api/v1/auctions — basic auction data',
        'GET /api/v1/auctions/:name — single auction (basic)',
        'GET /api/v1/summary — summary stats',
      ],
      note: 'Basic fields only. No concentration, overlap, or bidder data.',
    },
    pro: {
      rate: `${PRO_RATE_LIMIT} requests/minute`,
      endpoints: [
        'GET /api/v1/auctions — full auction data with concentration metrics',
        'GET /api/v1/auctions/:name — full single auction',
        'GET /api/v1/summary — summary stats + bidder insights',
        'GET /api/v1/overlap — bidder overlap matrix',
        'GET /api/v1/bidders — bidder index',
        'GET /api/v1/concentration — concentration metrics',
      ],
      auth: 'X-API-Key header',
      contact: 'DM @monkrus on Telegram or X for API access',
    },
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    // Docs (no rate limit)
    if (path === '/' || path === '/api' || path === '/api/v1') {
      return json(DOCS);
    }

    // Auth + rate limit
    const isPro = validateKey(request, env);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rate = checkRate(ip, isPro);
    const rateHeaders = {
      'X-RateLimit-Limit': String(rate.limit),
      'X-RateLimit-Remaining': String(rate.remaining),
      'X-API-Tier': isPro ? 'pro' : 'free',
    };

    if (!rate.ok) {
      return json(
        { error: 'Rate limit exceeded', limit: rate.limit, retry_after: '60s' },
        429,
        rateHeaders,
      );
    }

    // Fetch main data
    const cacheApi = caches.default;
    const dataResp = await fetchData(cacheApi, DATA_URL);
    if (!dataResp) return json({ error: 'Failed to fetch data' }, 502, rateHeaders);
    const data = await dataResp.json();

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
          { error: 'Pro API key required', docs: '/', contact: 'DM @monkrus for access' },
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
          { error: 'Pro API key required', docs: '/', contact: 'DM @monkrus for access' },
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
          { error: 'Pro API key required', docs: '/', contact: 'DM @monkrus for access' },
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

      // Exclude test auctions by default
      const includeTest = url.searchParams.get('test') === 'true';
      if (!includeTest) {
        auctions = auctions.filter(a => !a.isTest);
      }

      // Filter: chain
      const chain = url.searchParams.get('chain');
      if (chain) auctions = auctions.filter(a => a.chain === chain.toLowerCase());

      // Filter: status
      const status = url.searchParams.get('status');
      if (status === 'graduated') auctions = auctions.filter(a => a.graduated === true);
      else if (status === 'failed') auctions = auctions.filter(a => a.graduated === false);

      // Filter: hook
      const hook = url.searchParams.get('hook');
      if (hook === 'true') auctions = auctions.filter(a => a.hasValidationHook);
      else if (hook === 'false') auctions = auctions.filter(a => !a.hasValidationHook);

      // Filter: search
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
        tier: isPro ? 'pro' : 'free',
        auctions: isPro ? auctions : auctions.map(stripToFree),
      }, 200, rateHeaders);
    }

    return json({ error: 'Not found', docs: '/' }, 404, rateHeaders);
  },
};
