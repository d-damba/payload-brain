// Integration test: drives the real payload-mcp.js over stdio via an MCP client
// and asserts the v1.1.0 behavior (slim/compact payload, concise truncation,
// and the in-memory cache). Run with: node test-mcp.js
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const KEYWORDS = 'beforeChange hook collection';
const INTENT = 'How do collection hooks like beforeChange work in Payload v3';

async function call(client, args) {
  const res = await client.callTool({ name: 'search_payload_docs', arguments: args });
  const raw = res.content[0].text;
  return { raw, parsed: JSON.parse(raw) };
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'payload-mcp.js')],
  });
  const client = new Client({ name: 'payload-brain-test', version: '1.0.0' });
  await client.connect(transport);

  try {
    // ── tools/list ───────────────────────────────────────────────────────────
    console.log('\n📋 tools/list');
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'search_payload_docs');
    check('search_payload_docs is exposed', !!tool);
    check('mode enum is concise|full',
      JSON.stringify(tool?.inputSchema?.properties?.mode?.enum) === '["concise","full"]');

    // ── concise query (cold) ──────────────────────────────────────────────────
    console.log('\n🔍 concise query (cold cache)');
    const t0 = Date.now();
    const concise = await call(client, { keywords: KEYWORDS, semantic_intent: INTENT, mode: 'concise', limit: 3 });
    const coldMs = Date.now() - t0;
    console.log(`  ⏱️  ${coldMs}ms, ${concise.parsed.results.length} results`);

    check('compact JSON (no pretty-print newlines)', !concise.raw.includes('\n'));
    check('has diagnostics.confidence', !!concise.parsed.diagnostics?.confidence,
      JSON.stringify(concise.parsed.diagnostics));

    const r0 = concise.parsed.results[0] || {};
    check('result keys are exactly url/category/content',
      JSON.stringify(Object.keys(r0).sort()) === '["category","content","url"]',
      JSON.stringify(Object.keys(r0)));
    check('no scoring block on results', !('scoring' in r0));
    check('no metadata on results', !('metadata' in r0));

    // Truncation marker should appear on any concise chunk that was cut.
    const MARKER = 'call again with mode:"full"';
    const truncated = concise.parsed.results.filter(r => r.content.includes(MARKER));
    const overCap = concise.parsed.results.filter(r => r.content.length > 1200);
    check('no concise chunk wildly exceeds the cap (≤1200 incl. fence extension)', overCap.length === 0,
      `${overCap.length} oversized`);
    check('truncated chunks carry the escalation marker (or none needed)',
      truncated.length > 0 || concise.parsed.results.every(r => r.content.length <= 800),
      `${truncated.length} marked`);
    // Marker, when present, must be at the very end.
    check('marker (if present) is at end of content',
      concise.parsed.results.every(r => !r.content.includes(MARKER) || r.content.trimEnd().endsWith('full" for the complete section.]')));

    // ── repeat query (warm cache) ─────────────────────────────────────────────
    console.log('\n♻️  identical query (warm cache)');
    const t1 = Date.now();
    const repeat = await call(client, { keywords: KEYWORDS, semantic_intent: INTENT, mode: 'concise', limit: 3 });
    const warmMs = Date.now() - t1;
    console.log(`  ⏱️  ${warmMs}ms (cold was ${coldMs}ms)`);
    check('cache hit is faster than cold call', warmMs < coldMs, `${warmMs}ms vs ${coldMs}ms`);
    check('cached response is byte-identical to cold', repeat.raw === concise.raw);

    // ── full mode on the same rows (mode not part of cache key) ────────────────
    console.log('\n📖 full mode (same underlying rows)');
    const full = await call(client, { keywords: KEYWORDS, semantic_intent: INTENT, mode: 'full', limit: 3 });
    check('full mode never injects the truncation marker',
      full.parsed.results.every(r => !r.content.includes(MARKER)));
    // Concise must never be LONGER than full — that would mean truncation added
    // tokens instead of saving them (regression: fence extension + marker on a
    // chunk that was effectively whole).
    check('no concise chunk exceeds its full counterpart',
      concise.parsed.results.every((r, i) => r.content.length <= full.parsed.results[i].content.length));
    check('at least one chunk was genuinely truncated (concise < full)',
      concise.parsed.results.some((r, i) => r.content.length < full.parsed.results[i].content.length));
    check('full mode reports query_mode=full', full.parsed.diagnostics?.query_mode === 'full');

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  } finally {
    await client.close();
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('❌ Test harness error:', err); process.exit(1); });
