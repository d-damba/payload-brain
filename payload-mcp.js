import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: semanticIntent,
    });
    const query_embedding = embeddingResponse.data[0].embedding;

    const { data, error } = await supabase.rpc("match_payload_docs", {
      query_text: keywords,
      query_embedding: `[${query_embedding.join(',')}]`,
      match_threshold: 0.0, 
      match_count: finalLimit,
      filter_category: category
    });

    if (error) throw error;

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
          }, null, 2) 
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
        scoring: {
          rrf: parseFloat(doc.rrf_score.toFixed(4)),
          fts_rank: doc.fts_rank || "miss",
          vector_rank: doc.vector_rank || "miss"
        },
        content: doc.content,
        metadata: doc.payload
      }))
    };

    console.error(`[search] mode="${mode}" keywords="${keywords}" confidence="${responsePayload.diagnostics.confidence}" top_rrf=${topScore.toFixed(4)} results=${data.length}`);

    return {
      content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }]
    };

  } catch (err) {
    console.error("Hybrid search error:", err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
      isError: true
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Payload Brain (v1.0 API Mode) initialized.");
}

run().catch(console.error);

process.on('SIGINT', async () => {
  console.error("\nShutting down Payload Brain...");
  await server.close();
  process.exit(0);
});