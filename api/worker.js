/**
 * CCA Monitor API — Cloudflare Worker
 *
 * Serves auction data from GitHub with CORS, filtering, caching, tiered auth,
 * x402 agentic payments (USDC on Base), usage metering, and AI agent discovery.
 *
 * Deploy: cd api && npx wrangler deploy
 * Free tier: 100K requests/day (Cloudflare), 60 req/min per IP
 *
 * Endpoints (free — no auth):
 *   GET /api/v1/auctions          — auctions with basic fields
 *   GET /api/v1/auctions/:name    — single auction (basic fields)
 *   GET /api/v1/summary           — summary stats
 *   GET /                         — API docs
 *
 * Endpoints (pro — requires X-API-Key or x402 USDC payment):
 *   GET /api/v1/auctions          — full fields incl. concentration, Q96 prices
 *   GET /api/v1/auctions/:name    — full single auction
 *   GET /api/v1/overlap           — bidder overlap matrix ($0.001/call)
 *   GET /api/v1/bidders           — bidder index ($0.005/call)
 *   GET /api/v1/concentration     — concentration metrics ($0.001/call)
 *
 * Agent discovery:
 *   GET /.well-known/ai-plugin.json   — AI agent plugin manifest
 *   GET /api/v1/usage/:identity       — usage stats for an agent identity
 *
 * x402 payment flow:
 *   1. Agent hits pro endpoint without API key → 402 + PAYMENT-REQUIRED header
 *   2. Agent signs USDC payment → retries with PAYMENT-SIGNATURE header
 *   3. Worker verifies via facilitator → serves data + settles payment
 *
 * Env vars (set via wrangler secret):
 *   API_KEYS         — comma-separated pro API keys
 *   PAYMENT_ADDRESS  — 0x wallet address to receive USDC payments
 */

const AI_PLUGIN = {
  schema_version: 'v1',
  name_for_human: 'CCA Monitor API',
  name_for_model: 'cca_monitor',
  description_for_human: 'Query Continuous Clearing Auction (CCA) data from Uniswap V4 — auction results, bidder analytics, concentration metrics, and overlap matrices.',
  description_for_model: 'Access structured data about Uniswap V4 Continuous Clearing Auctions (CCAs). Retrieve auction results (clearing prices, floor prices, graduation status, bid counts), bidder concentration metrics (HHI, Gini, top-N share), bidder overlap/flow between auctions, and per-bidder cross-auction activity. Supports filtering by chain (mainnet, base), status (graduated, failed), and token search. Free tier provides basic auction fields; paid tier unlocks concentration, overlap, and bidder endpoints. Pro endpoints accept x402 USDC payments on Base.',
  auth: {
    type: 'multi',
    methods: [
      { type: 'api_key', header: 'X-API-Key', description: 'Static API key for pro tier access. Contact @monkrus on Telegram or X.' },
      { type: 'x402', protocol: 'https://docs.x402.org', description: 'Pay-per-call with USDC on Base. Send GET request, receive 402 with payment requirements, sign and retry.' },
    ],
  },
  api: { type: 'openapi', url: 'https://cca-monitor-api.sergeigodev.workers.dev/.well-known/openapi.json', has_user_authentication: false },
  payment: {
    provider: 'x402',
    status: 'active',
    currency: 'USDC',
    network: 'Base (eip155:8453)',
    facilitator: 'https://x402.org/facilitator',
    pricing: {
      model: 'per_call',
      free_endpoints: ['/api/v1/auctions', '/api/v1/auctions/:name', '/api/v1/summary'],
      paid_endpoints: { '/api/v1/concentration': '$0.001', '/api/v1/overlap': '$0.001', '/api/v1/bidders': '$0.005' },
    },
  },
  logo_url: 'https://monkrus.github.io/cca-monitor/favicon.ico',
  contact_email: 'sergeigodev@gmail.com',
  legal_info_url: 'https://github.com/monkrus/cca-monitor',
};

const BASE = 'https://cca-monitor-api.sergeigodev.workers.dev';
const DATA_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/results.json';
const BIDDER_URL = 'https://raw.githubusercontent.com/monkrus/cca-monitor/master/data/bidder-index.json';
const CACHE_TTL = 300; // 5 minutes

// ─── x402 config ────────────────────────────────────────────────────────────
const FACILITATOR_URL = 'https://x402.org/facilitator';
const PAYMENT_NETWORK = 'eip155:8453'; // Base mainnet

// ─── Per-endpoint pricing (USDC) ────────────────────────────────────────────
const PRICING = {
  '/api/v1/auctions':      { tier: 'free', price: 0,     usdcUnits: '0' },
  '/api/v1/summary':       { tier: 'free', price: 0,     usdcUnits: '0' },
  '/api/v1/concentration': { tier: 'pro',  price: 0.001, usdcUnits: '1000' },    // $0.001 = 1000 (6 decimals)
  '/api/v1/overlap':       { tier: 'pro',  price: 0.001, usdcUnits: '1000' },
  '/api/v1/bidders':       { tier: 'pro',  price: 0.005, usdcUnits: '5000' },
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
const RATE_WINDOW = 60_000;
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
function authenticate(request, env) {
  // Method 1: Static API key
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey) {
    const valid = (env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (valid.includes(apiKey)) {
      return { tier: 'pro', method: 'api_key', identity: `apikey:${apiKey.slice(0, 8)}...` };
    }
  }

  // Method 2: x402 payment (checked later in requirePro — auth just detects the header)
  const paymentSig = request.headers.get('Payment-Signature') || request.headers.get('X-Payment');
  if (paymentSig) {
    return { tier: 'pending_x402', method: 'x402', identity: null, paymentSig };
  }

  return { tier: 'free', method: 'none', identity: null };
}

// ─── x402 payment protocol ──────────────────────────────────────────────────

function buildPaymentRequired(endpoint, payTo) {
  const pricing = PRICING[endpoint];
  if (!pricing || pricing.tier === 'free') return null;

  return {
    accepts: [{
      scheme: 'exact',
      network: PAYMENT_NETWORK,
      maxAmountRequired: pricing.usdcUnits,
      resource: endpoint,
      description: `CCA Monitor API — ${endpoint} ($${pricing.price}/call)`,
      mimeType: 'application/json',
      payTo,
    }],
    description: `CCA Monitor API — ${endpoint}`,
    mimeType: 'application/json',
  };
}

// Return 402 response with x402 payment requirements
function return402(endpoint, payTo, rateHeaders) {
  const paymentRequired = buildPaymentRequired(endpoint, payTo);
  const pricing = PRICING[endpoint];

  const body = {
    error: 'Payment required',
    protocol: 'x402',
    pricing: `$${pricing.price}/call USDC on Base`,
    how_to_pay: 'Sign a USDC payment and retry with the PAYMENT-SIGNATURE header. See https://docs.x402.org',
    alternatives: ['X-API-Key header (contact @monkrus on Telegram or X)'],
  };

  const paymentJson = JSON.stringify(paymentRequired);
  const encoded = btoa(unescape(encodeURIComponent(paymentJson)));
  return json(body, 402, {
    ...rateHeaders,
    'Payment-Required': encoded,
    'X-Payment-Required': encoded, // v1 compat
  });
}

// Verify a payment signature via the x402 facilitator
async function verifyX402Payment(paymentSig, endpoint, payTo) {
  const paymentRequired = buildPaymentRequired(endpoint, payTo);
  if (!paymentRequired) return { ok: false, error: 'No payment config' };

  try {
    const resp = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: paymentSig,
        paymentRequirements: paymentRequired,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Facilitator returned ${resp.status}: ${text}` };
    }

    const result = await resp.json();
    return { ok: result.valid === true || result.verified === true, result };
  } catch (err) {
    return { ok: false, error: `Facilitator error: ${err.message}` };
  }
}

// Settle a verified payment via the x402 facilitator (non-blocking)
async function settleX402Payment(paymentSig, endpoint, payTo) {
  const paymentRequired = buildPaymentRequired(endpoint, payTo);
  if (!paymentRequired) return;

  try {
    await fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: paymentSig,
        paymentRequirements: paymentRequired,
      }),
    });
  } catch {
    // Settlement errors are logged but don't block the response
  }
}

// Check pro access: API key OR verified x402 payment
// Returns { authorized, auth, response? (if 402/error) }
async function requirePro(auth, endpoint, env, rateHeaders) {
  // Already authorized via API key
  if (auth.tier === 'pro') {
    return { authorized: true, auth };
  }

  const payTo = env.PAYMENT_ADDRESS;

  // x402 payment signature present — verify it
  if (auth.tier === 'pending_x402' && auth.paymentSig && payTo) {
    const verification = await verifyX402Payment(auth.paymentSig, endpoint, payTo);
    if (verification.ok) {
      return {
        authorized: true,
        auth: { ...auth, tier: 'pro', identity: `x402:${endpoint}`, settlementData: auth.paymentSig },
      };
    }
    return {
      authorized: false,
      response: json(
        { error: 'Payment verification failed', detail: verification.error },
        402,
        rateHeaders,
      ),
    };
  }

  // No auth and no payment — return 402 if payment is configured, otherwise 403
  if (payTo) {
    return { authorized: false, response: return402(endpoint, payTo, rateHeaders) };
  }

  // No PAYMENT_ADDRESS configured — fall back to 403 with instructions
  return {
    authorized: false,
    response: json(
      { error: 'Pro access required', pricing: `$${PRICING[endpoint]?.price}/call`, auth_options: DOCS.tiers.pro.auth },
      403,
      rateHeaders,
    ),
  };
}

// ─── Usage metering (Cloudflare KV) ─────────────────────────────────────────
async function recordUsage(env, auth, endpoint) {
  if (!env.USAGE || !auth.identity) return;

  const month = new Date().toISOString().slice(0, 7);
  const key = `usage:${auth.identity}:${month}`;
  const price = PRICING[endpoint]?.price || 0;

  try {
    const raw = await env.USAGE.get(key, { type: 'json' });
    const usage = raw || { identity: auth.identity, month, totalCalls: 0, totalSpend: 0, endpoints: {} };

    usage.totalCalls++;
    usage.totalSpend = Math.round((usage.totalSpend + price) * 1e6) / 1e6;

    if (!usage.endpoints[endpoint]) {
      usage.endpoints[endpoint] = { calls: 0, spend: 0 };
    }
    usage.endpoints[endpoint].calls++;
    usage.endpoints[endpoint].spend = Math.round((usage.endpoints[endpoint].spend + price) * 1e6) / 1e6;

    await env.USAGE.put(key, JSON.stringify(usage), { expirationTtl: 90 * 86400 });
  } catch {
    // Non-critical
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
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Payment-Signature, X-Payment');
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  return cors(new Response(JSON.stringify(data), { status, headers }));
}

// Add x402 settlement receipt to a response
function withPaymentReceipt(response, receipt) {
  if (!receipt) return response;
  const headers = new Headers(response.headers);
  headers.set('Payment-Response', typeof receipt === 'string' ? receipt : btoa(JSON.stringify(receipt)));
  return new Response(response.body, { status: response.status, headers });
}

// ─── Agent-readiness: static content ────────────────────────────────────────

const ROBOTS_TXT = `User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: Amazonbot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Allow: /

Content-Signal: ai-train=no
Content-Signal: search=yes
Content-Signal: ai-input=yes

Sitemap: ${BASE}/sitemap.xml
`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${BASE}/api/v1/auctions</loc><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>${BASE}/api/v1/summary</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${BASE}/api/v1/concentration</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>${BASE}/api/v1/overlap</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>${BASE}/api/v1/bidders</loc><changefreq>daily</changefreq><priority>0.7</priority></url>
  <url><loc>${BASE}/.well-known/ai-plugin.json</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
</urlset>`;

const API_CATALOG = {
  linkset: [
    {
      anchor: `${BASE}/`,
      'service-desc': [{ href: `${BASE}/.well-known/ai-plugin.json`, type: 'application/json' }],
      'service-doc': [{ href: `${BASE}/`, type: 'application/json' }],
      describedby: [{ href: `${BASE}/.well-known/ai-plugin.json`, type: 'application/json' }],
    },
  ],
};

const AGENT_SKILLS = {
  $schema: 'https://agentskills.io/schema/v0.2.0/index.json',
  skills: [
    {
      name: 'list-auctions',
      type: 'api',
      description: 'List Uniswap V4 CCA auctions with optional filters (chain, status, hook, search)',
      url: `${BASE}/api/v1/auctions`,
    },
    {
      name: 'get-auction',
      type: 'api',
      description: 'Get details for a specific CCA auction by name or token symbol',
      url: `${BASE}/api/v1/auctions/{name}`,
    },
    {
      name: 'get-summary',
      type: 'api',
      description: 'Get summary statistics across all CCA auctions',
      url: `${BASE}/api/v1/summary`,
    },
    {
      name: 'get-concentration',
      type: 'api',
      description: 'Get bidder concentration metrics (HHI, Gini, top-N share) for all auctions. Pro: $0.001/call USDC via x402.',
      url: `${BASE}/api/v1/concentration`,
    },
    {
      name: 'get-overlap',
      type: 'api',
      description: 'Get bidder overlap matrix showing cross-auction bidder flow. Pro: $0.001/call USDC via x402.',
      url: `${BASE}/api/v1/overlap`,
    },
    {
      name: 'get-bidders',
      type: 'api',
      description: 'Get bidder index with cross-auction activity. Pro: $0.005/call USDC via x402.',
      url: `${BASE}/api/v1/bidders`,
    },
  ],
};

const MCP_SERVER_CARD = {
  serverInfo: {
    name: 'cca-monitor',
    version: '4.0',
    description: 'Uniswap V4 Continuous Clearing Auction analytics API. Query auction results, bidder concentration, overlap matrices, and cross-auction activity.',
  },
  transport: {
    type: 'https',
    url: `${BASE}/api/v1`,
  },
  capabilities: {
    resources: true,
    tools: AGENT_SKILLS.skills.map(s => ({
      name: s.name,
      description: s.description,
      inputSchema: { type: 'object', properties: {} },
    })),
  },
  authentication: {
    schemes: [
      { type: 'apiKey', header: 'X-API-Key', description: 'Static API key for pro tier' },
      { type: 'x402', description: 'Pay-per-call USDC on Base via x402 protocol' },
    ],
  },
};

const MARKDOWN_DOCS = `# CCA Monitor API v4.0

Uniswap V4 Continuous Clearing Auction analytics. AI agents can pay per call with USDC on Base via x402.

## Agent Discovery

- Plugin manifest: [/.well-known/ai-plugin.json](${BASE}/.well-known/ai-plugin.json)
- API catalog: [/.well-known/api-catalog](${BASE}/.well-known/api-catalog)
- Agent skills: [/.well-known/agent-skills/index.json](${BASE}/.well-known/agent-skills/index.json)
- MCP server card: [/.well-known/mcp/server-card.json](${BASE}/.well-known/mcp/server-card.json)
- x402 discovery: [/.well-known/x402](${BASE}/.well-known/x402)

## Free Endpoints (no auth)

| Endpoint | Description |
|----------|-------------|
| GET /api/v1/auctions | List auctions (basic fields) |
| GET /api/v1/auctions/:name | Single auction by name or symbol |
| GET /api/v1/summary | Summary statistics |

## Pro Endpoints (API key or x402 USDC payment)

| Endpoint | Price | Description |
|----------|-------|-------------|
| GET /api/v1/concentration | $0.001/call | Bidder concentration metrics (HHI, Gini) |
| GET /api/v1/overlap | $0.001/call | Bidder overlap matrix |
| GET /api/v1/bidders | $0.005/call | Bidder index with cross-auction activity |

## Authentication

1. **API Key**: Set \`X-API-Key\` header. Contact @monkrus on Telegram or X.
2. **x402**: Send GET request → receive 402 with \`PAYMENT-REQUIRED\` header → sign USDC payment → retry with \`PAYMENT-SIGNATURE\` header. See [docs.x402.org](https://docs.x402.org).

## Filters

- \`chain\`: mainnet, base, arbitrum, unichain
- \`status\`: graduated, failed
- \`hook\`: true, false
- \`test\`: true (include test auctions)
- \`q\`: search token name/symbol

## Links

- Dashboard: [monkrus.github.io/cca-monitor](https://monkrus.github.io/cca-monitor)
- Source: [github.com/monkrus/cca-monitor](https://github.com/monkrus/cca-monitor)
`;

// ─── Docs ───────────────────────────────────────────────────────────────────
const DOCS = {
  name: 'CCA Monitor API',
  version: '4.0',
  description: 'Uniswap V4 Continuous Clearing Auction analytics. AI agents can pay per call with USDC on Base via x402.',
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
      price: 'Per-call USDC on Base (x402) or API key',
      endpoints: [
        'GET /api/v1/auctions — full auction data ($0 with key)',
        'GET /api/v1/auctions/:name — full single auction ($0 with key)',
        'GET /api/v1/summary — summary + bidder insights ($0 with key)',
        'GET /api/v1/overlap — bidder overlap matrix ($0.001/call)',
        'GET /api/v1/bidders — bidder index ($0.005/call)',
        'GET /api/v1/concentration — concentration metrics ($0.001/call)',
      ],
      auth: [
        'x402: Send GET → receive 402 with PAYMENT-REQUIRED → sign USDC payment → retry with PAYMENT-SIGNATURE header',
        'API key: X-API-Key header (DM @monkrus on Telegram or X)',
      ],
    },
  },
  pricing: {
    protocol: 'x402 (https://docs.x402.org)',
    currency: 'USDC',
    network: 'Base (eip155:8453)',
    facilitator: FACILITATOR_URL,
    model: 'per_call',
    endpoints: Object.fromEntries(
      Object.entries(PRICING).map(([k, v]) => [k, v.price === 0 ? 'free' : `$${v.price}`])
    ),
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

    // ── Agent-readiness routes (no rate limit) ─────────────────────────
    if (path === '/robots.txt') {
      return cors(new Response(ROBOTS_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    }

    if (path === '/sitemap.xml') {
      return cors(new Response(SITEMAP_XML, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      }));
    }

    if (path === '/.well-known/ai-plugin.json') {
      return json(AI_PLUGIN);
    }

    if (path === '/.well-known/api-catalog') {
      const resp = new Response(JSON.stringify(API_CATALOG), {
        headers: { 'Content-Type': 'application/linkset+json' },
      });
      return cors(resp);
    }

    if (path === '/.well-known/agent-skills/index.json') {
      return json(AGENT_SKILLS);
    }

    if (path === '/.well-known/mcp/server-card.json' || path === '/.well-known/mcp.json' || path === '/.well-known/mcp/server-cards.json') {
      return json(MCP_SERVER_CARD);
    }

    // x402 resource discovery — advertises paid endpoints and pricing
    if (path === '/.well-known/x402' || path === '/x402/discovery/resources') {
      return json({
        protocol: 'x402',
        facilitator: FACILITATOR_URL,
        network: PAYMENT_NETWORK,
        currency: 'USDC',
        resources: Object.entries(PRICING)
          .filter(([, v]) => v.tier === 'pro')
          .map(([endpoint, v]) => ({
            resource: `${BASE}${endpoint}`,
            method: 'GET',
            scheme: 'exact',
            maxAmountRequired: v.usdcUnits,
            price: `$${v.price}`,
            description: `CCA Monitor API — ${endpoint}`,
          })),
      });
    }

    // ── Docs (no rate limit) — with Link headers for agent discovery ──────
    if (path === '/' || path === '/api' || path === '/api/v1') {
      const accept = request.headers.get('Accept') || '';
      const linkHeader = [
        `<${BASE}/.well-known/api-catalog>; rel="api-catalog"`,
        `<${BASE}/.well-known/ai-plugin.json>; rel="service-desc"`,
        `<${BASE}/sitemap.xml>; rel="sitemap"`,
      ].join(', ');
      const extraHeaders = {
        'Link': linkHeader,
        'X-Payment-Protocol': 'x402',
        'X-Payment-Network': PAYMENT_NETWORK,
        'X-Payment-Currency': 'USDC',
      };

      // Markdown content negotiation — return docs as markdown when requested
      if (accept.includes('text/markdown')) {
        const resp = cors(new Response(MARKDOWN_DOCS, {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            ...extraHeaders,
          },
        }));
        return resp;
      }

      const resp = json(DOCS, 200, extraHeaders);
      return resp;
    }

    // ── Auth + rate limit ─────────────────────────────────────────────────
    let auth = authenticate(request, env);
    const isPro = auth.tier === 'pro';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rate = checkRate(ip, isPro);
    const rateHeaders = {
      'X-RateLimit-Limit': String(rate.limit),
      'X-RateLimit-Remaining': String(rate.remaining),
      'X-API-Tier': auth.tier === 'pending_x402' ? 'x402' : auth.tier,
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

    // Normalize endpoint path for metering
    const meterPath = path.match(/^\/api\/v1\/auctions\/.+$/) ? '/api/v1/auctions' : path;

    // Record usage asynchronously
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

    // ── /api/v1/overlap (pro only — $0.001/call) ─────────────────────────
    if (path === '/api/v1/overlap') {
      const access = await requirePro(auth, '/api/v1/overlap', env, rateHeaders);
      if (!access.authorized) return access.response;
      auth = access.auth;

      let response = json({ overlapMatrix: data.summary?.overlapMatrix || {} }, 200, rateHeaders);

      if (auth.settlementData && ctx?.waitUntil) {
        ctx.waitUntil(settleX402Payment(auth.settlementData, '/api/v1/overlap', env.PAYMENT_ADDRESS));
      }
      return response;
    }

    // ── /api/v1/concentration (pro only — $0.001/call) ───────────────────
    if (path === '/api/v1/concentration') {
      const access = await requirePro(auth, '/api/v1/concentration', env, rateHeaders);
      if (!access.authorized) return access.response;
      auth = access.auth;

      const real = data.auctions.filter(a => !a.isTest && a.concentration);
      const result = real.map(a => ({
        name: a.name,
        chain: a.chain,
        tokenSymbol: a.tokenSymbol,
        graduated: a.graduated,
        concentration: a.concentration,
      }));
      let response = json({ timestamp: data.timestamp, count: result.length, auctions: result }, 200, rateHeaders);

      if (auth.settlementData && ctx?.waitUntil) {
        ctx.waitUntil(settleX402Payment(auth.settlementData, '/api/v1/concentration', env.PAYMENT_ADDRESS));
      }
      return response;
    }

    // ── /api/v1/bidders (pro only — $0.005/call) ─────────────────────────
    if (path === '/api/v1/bidders') {
      const access = await requirePro(auth, '/api/v1/bidders', env, rateHeaders);
      if (!access.authorized) return access.response;
      auth = access.auth;

      const bidderResp = await fetchData(cacheApi, BIDDER_URL);
      if (!bidderResp) return json({ error: 'Bidder data unavailable' }, 502, rateHeaders);
      const bidders = await bidderResp.json();
      const count = typeof bidders === 'object' ? Object.keys(bidders).length : 0;
      let response = json({ count, bidders }, 200, rateHeaders);

      if (auth.settlementData && ctx?.waitUntil) {
        ctx.waitUntil(settleX402Payment(auth.settlementData, '/api/v1/bidders', env.PAYMENT_ADDRESS));
      }
      return response;
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
        tier: auth.tier === 'pending_x402' ? 'free' : auth.tier,
        auctions: isPro ? auctions : auctions.map(stripToFree),
      }, 200, rateHeaders);
    }

    return json({ error: 'Not found', docs: '/' }, 404, rateHeaders);
  },
};
