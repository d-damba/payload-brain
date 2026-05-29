import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey || !openaiKey) {
  console.error("🚨 Missing required environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const openai = new OpenAI({ apiKey: openaiKey });

const server = new Server(
  { name: "payload-brain", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool Definition ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "search_payload_docs",
    description: "Search the local vector database for official Payload CMS v3 documentation utilizing Hybrid Search.",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "string",
          description: "Exact technical terms for Full-Text Search. Use double quotes for exact phrases (e.g., '\"beforeChange\"')."
        },
        semantic_intent: {
          type: "string",
          description: "The conceptual question or descriptive intent (e.g., 'How to set up native folders in a media collection')."
        },
        category: {
          type: "string",
          description: "Filter by top-level documentation folder (e.g., 'admin', 'collections', 'fields', 'globals', 'hooks', 'authentication'). Leave empty to search all."
        },
        mode: {
          type: "string",
          enum: ["concise", "full"],
          description: "Request the lightweight parameter schema ('concise') or the extended prose documentation ('full'). Default is 'concise'."
        },
        limit: {
          type: "number",
          description: "Number of chunks to return. Default 5. Max 15."
        }
      },
      required: ["keywords", "semantic_intent"]
    }
  }]
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

// NOTE (tuning lever): since ingest now bounds chunk size, most chunks already
// arrive near this cap, so concise does less trimming than it did pre-v1.2.0.
// If you want to squeeze more tokens, this cap could be lowered (~500) — chunks
// are small enough and adjacency restores surrounding context. Not needed now.
const CONCISE_CAP = 800;
const TRUNCATION_MARKER = '\n\n[Truncated — call again with mode:"full" for the complete section.]';

// Truncate a chunk to ~CONCISE_CAP chars without ever cutting inside a code
// fence. If the cap lands mid-fence, extend to the closing ``` so examples stay
// whole. Returns the chunk untouched if it's already under the cap.
function toConcise(content) {
  if (content.length <= CONCISE_CAP) return content;

  let cut = CONCISE_CAP;
  const fencesBeforeCut = (content.slice(0, cut).match(/```/g) || []).length;

  // Odd count means the cap landed inside an open code fence — extend to its close.
  if (fencesBeforeCut % 2 === 1) {
    const close = content.indexOf('```', cut);
    cut = close === -1 ? content.length : close + 3;
  }

  // If the fence extension swallowed the whole chunk, nothing is actually
  // truncated — return it as-is rather than appending a marker (which would
  // make the "concise" result longer than "full").
  if (cut >= content.length) return content;

  // Only return the truncated form if it's actually shorter. When the dropped
  // tail is smaller than the marker itself, the marker would make "concise"
  // longer than the original — in that case just return the full content.
  const result = content.slice(0, cut).trimEnd() + TRUNCATION_MARKER;
  return result.length < content.length ? result : content;
}

// In-memory caches. The docs are static for the server's lifetime, so no TTL —
// re-running ingest requires a server restart to clear these (see README).
// Map preserves insertion order, giving us LRU eviction for free: read refreshes
// recency, overflow evicts the oldest key. Bound is just a memory backstop.
const CACHE_MAX = 300;
const embeddingCache = new Map(); // semantic_intent -> embedding string "[...]"
const resultCache = new Map();    // query signature  -> raw rows from the RPC

function cacheGet(cache, key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ── Tool Execution ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "search_payload_docs") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = request.params.arguments;
  
  const keywords = args.keywords.replace(/[^\w\s"]/g, ' ').replace(/\s+/g, ' ').trim();
  const semanticIntent = args.semantic_intent;
  const category = args.category || null;
  const mode = args.mode || 'concise';
  const finalLimit = Math.max(1, Math.min(Number(args.limit) || 5, 15));

  try {
    // Result cache is keyed on everything that changes the rows (not mode —
    // mode only affects formatting, applied below on cached rows just the same).
    const resultKey = `${keywords}::${category}::${finalLimit}::${semanticIntent}`;
    let data = cacheGet(resultCache, resultKey);

    if (data === undefined) {
      // Embedding cache keyed on intent alone, so it still hits when the same
      // intent is paired with different keywords/category/limit (a cache miss
      // on resultKey). This is the only call that costs money on a repeat.
      let query_embedding = cacheGet(embeddingCache, semanticIntent);
      if (query_embedding === undefined) {
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: semanticIntent,
        });
        query_embedding = `[${embeddingResponse.data[0].embedding.join(',')}]`;
        cacheSet(embeddingCache, semanticIntent, query_embedding);
      }

      const { data: rows, error } = await supabase.rpc("match_payload_docs", {
        query_text: keywords,
        query_embedding,
        match_threshold: 0.0,
        match_count: finalLimit,
        filter_category: category
      });

      if (error) throw error;

      data = rows || [];
      cacheSet(resultCache, resultKey, data);
    }

    if (!data || data.length === 0) {
      console.error(`[search] keywords="${keywords}" intent="${semanticIntent}" results=0`);
      return { 
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            diagnostics: {
              query_mode: mode,
              confidence: "LOW",
              warning: "No relevant documentation found. Please reformulate with broader keywords or exact field/hook names."
            },
            results: []
          })
        }]
      };
    }

    const LOW_CONFIDENCE_THRESHOLD = 0.015;
    const topScore = data[0]?.rrf_score || 0;
    const isLowConfidence = topScore < LOW_CONFIDENCE_THRESHOLD;
    const isFtsMiss = data.every(doc => !doc.fts_rank);

    let diagnosticWarning = "Search optimal. Strong exact and semantic matches found.";
    if (isLowConfidence) {
      diagnosticWarning = "Top RRF score is below threshold. Results may not match your query. Consider reformulating.";
    } else if (isFtsMiss) {
      diagnosticWarning = "Exact keywords not found. Results are based entirely on semantic vector matching.";
    }

    const responsePayload = {
      diagnostics: {
        query_mode: mode,
        confidence: isLowConfidence ? "LOW" : (isFtsMiss ? "MARGINAL" : "HIGH"),
        top_rrf_score: parseFloat(topScore.toFixed(4)),
        warning: diagnosticWarning
      },
      results: data.map(doc => ({
        url: doc.url,
        category: doc.category,
        content: mode === 'concise' ? toConcise(doc.content) : doc.content
      }))
    };

    console.error(`[search] mode="${mode}" keywords="${keywords}" confidence="${responsePayload.diagnostics.confidence}" top_rrf=${topScore.toFixed(4)} results=${data.length}`);

    return {
      content: [{ type: "text", text: JSON.stringify(responsePayload) }]
    };

  } catch (err) {
    const msg = err?.message || String(err);
    const isAuth = err?.status === 401 || /api key|invalid key|unauthorized/i.test(msg);
    const isNetwork = /fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg);

    const warning = isAuth
      ? "Authentication failed. Verify OPENAI_API_KEY and SUPABASE_SERVICE_KEY in .env."
      : isNetwork
        ? "Could not reach search service. Check your network connection and SUPABASE_URL in .env."
        : "Search service encountered an unexpected error. Please try again or re-run the ingest.";

    console.error(`[search] error type=${isAuth ? 'auth' : isNetwork ? 'network' : 'unknown'} message=${msg}`);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          diagnostics: {
            query_mode: mode,
            confidence: "LOW",
            warning
          },
          results: []
        })
      }]
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Payload Brain (v1.0 API Mode) initialized.");
}

// Only boot the server when run directly (`node payload-mcp.js`), so the pure
// helpers (e.g. toConcise) can be imported by tests without launching it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(console.error);

  process.on('SIGINT', async () => {
    console.error("\nShutting down Payload Brain...");
    await server.close();
    process.exit(0);
  });
}

export { toConcise };