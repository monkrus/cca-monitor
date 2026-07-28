/**
 * CCA Monitor API — Cloudflare Worker
 *
 * Serves auction data from GitHub with CORS, filtering, and caching.
 * Deploy: npx wrangler deploy
 * Free tier: 100K requests/day
 *
 * Endpoints:
 *   GET /api/v1/auctions          — all auctions (filter: ?chain=mainnet&status=graduated&hook=true&q=AZTEC)
 *   GET /api/v1/auctions/:name    — single auction by name/symbol
 *   GET /api/v1/summary           — summary stats + bidder insights
 *   GET /api/v1/overlap           — bidder overlap matrix
 *   GET /                         — API docs
 */

const DATA_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/results.json';
const CACHE_TTL = 300; // 5 minutes

async function fetchData(cacheApi, cacheKey) {
  const cached = await cacheApi.match(cacheKey);
  if (cached) return cached.clone();

  const resp = await fetch(DATA_URL);
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
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const DOCS = {
  name: 'CCA Monitor API',
  version: '1.0',
  endpoints: {
    'GET /api/v1/auctions': {
      description: 'List all auctions',
      query: {
        chain: 'Filter by chain (mainnet, base, arbitrum, unichain)',
        status: 'Filter by status (graduated, failed)',
        hook: 'Filter by validation hook (true, false)',
        test: 'Include test auctions (true). Excluded by default.',
        q: 'Search token name/symbol',
      },
    },
    'GET /api/v1/auctions/:name': 'Get single auction by name or symbol',
    'GET /api/v1/summary': 'Summary stats and bidder insights',
    'GET /api/v1/overlap': 'Bidder overlap matrix',
  },
  source: 'https://github.com/monkrus/cca-monitor',
  dashboard: 'https://monkrus.github.io/cca-monitor',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (path === '/' || path === '/api' || path === '/api/v1') {
      return json(DOCS);
    }

    // Fetch and parse data
    const cacheApi = caches.default;
    const cacheKey = new Request(DATA_URL);
    const dataResp = await fetchData(cacheApi, cacheKey);
    if (!dataResp) return json({ error: 'Failed to fetch data' }, 502);

    const data = await dataResp.json();

    // /api/v1/summary
    if (path === '/api/v1/summary') {
      return json({ timestamp: data.timestamp, summary: data.summary });
    }

    // /api/v1/overlap
    if (path === '/api/v1/overlap') {
      return json({ overlapMatrix: data.summary?.overlapMatrix || {} });
    }

    // /api/v1/auctions/:name
    const singleMatch = path.match(/^\/api\/v1\/auctions\/(.+)$/);
    if (singleMatch) {
      const name = decodeURIComponent(singleMatch[1]).toLowerCase();
      const auction = data.auctions.find(
        a => a.name?.toLowerCase() === name ||
             a.tokenSymbol?.toLowerCase() === name
      );
      if (!auction) return json({ error: 'Auction not found' }, 404);
      return json(auction);
    }

    // /api/v1/auctions
    if (path === '/api/v1/auctions') {
      let auctions = data.auctions;

      // Exclude test auctions by default
      const includeTest = url.searchParams.get('test') === 'true';
      if (!includeTest) {
        auctions = auctions.filter(a => !a.isTest);
      }

      // Filter: chain
      const chain = url.searchParams.get('chain');
      if (chain) {
        auctions = auctions.filter(a => a.chain === chain.toLowerCase());
      }

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
        auctions,
      });
    }

    return json({ error: 'Not found', docs: '/' }, 404);
  },
};
