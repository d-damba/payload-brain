import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// ── Bulletproof .env Loading ────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import pLimit from 'p-limit';
import crypto from 'crypto';

// 1. Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 2. Configuration
const BATCH_ID = crypto.randomUUID();
const CONCURRENCY_LIMIT = 10;
const limit = pLimit(CONCURRENCY_LIMIT);

// Local paths to cloned repositories
const TARGET_DIRS = [
  { path: path.resolve('./docs'), prefix: 'payload/docs' },
  { path: path.resolve('./skills'), prefix: 'payload/skills' }
];

const MIN_CONTENT_LENGTH = 50;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ── Local File System Discovery ─────────────────────────────────────────────

function getMdxFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getMdxFiles(filePath, fileList);
    } else if (filePath.endsWith('.mdx') || filePath.endsWith('.md')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// ── Content Parsing & Chunking ──────────────────────────────────────────────

function processFile(filePath, baseDir, prefix) {
  const content = fs.readFileSync(filePath, 'utf-8');

  const relativePath = path.relative(baseDir, filePath);
  const url = `${prefix}/${relativePath.replace(/\\/g, '/')}`;

  // If it comes from skills, label the category as 'skills'. Otherwise, use the folder name.
  const category = prefix.includes('skills') ? 'skills' : (relativePath.split(path.sep)[0] || 'general');

  // Split the MDX document into chunks based on Markdown headers (## or ###)
  const rawChunks = content.split(/(?=^##\s|^###\s)/m);

  const chunks = [];
  let chunkIndex = 0;

  for (let text of rawChunks) {
    text = text.trim();
    if (text.length < MIN_CONTENT_LENGTH) continue;

    chunks.push({
      url,
      chunk_index: chunkIndex++,
      category,
      content: text,
      payload: { source_file: relativePath } // Storing filepath in the JSON payload
    });
  }

  return chunks;
}

// ── Embedding & Storage ─────────────────────────────

async function embedAndStore(chunk, attempt = 1) {
  while (attempt <= MAX_RETRIES) {
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunk.content,
        dimensions: 1536
      });

      const { error } = await supabase.from('payload_docs').upsert({
        url: chunk.url,
        chunk_index: chunk.chunk_index,
        category: chunk.category,
        sync_batch_id: BATCH_ID,
        content: chunk.content,
        payload: chunk.payload,
        embedding: embeddingResponse.data[0].embedding
      }, { onConflict: 'url,chunk_index' });

      if (error) throw error;
      return true;

    } catch (error) {
      if (attempt === MAX_RETRIES) {
        console.error(`Failed to store chunk for ${chunk.url}:`, error.message);
        return false;
      }
      await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
      attempt++;
    }
  }
  return false;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

async function runIngestion() {
  console.log(`🚀 STARTING PAYLOAD INGESTION PIPELINE (Batch: ${BATCH_ID})`);

  // Pull the latest from both repos
  console.log("📥 Pulling latest standard Docs from GitHub...");
  execSync('npx degit payloadcms/payload/docs ./docs --force', { stdio: 'inherit' });

  console.log("📥 Pulling latest AI Skills from GitHub...");
  execSync('npx degit payloadcms/skills/skills/payload ./skills --force', { stdio: 'inherit' });

  let filesToProcess = [];

  // Discover files in both directories
  for (const dirConfig of TARGET_DIRS) {
    if (fs.existsSync(dirConfig.path)) {
      const files = getMdxFiles(dirConfig.path);
      // Attach the custom prefix to the file path payload so we know where it came from
      filesToProcess.push(...files.map(f => ({ filePath: f, prefix: dirConfig.prefix, baseDir: dirConfig.path })));
    }
  }

  console.log(`\n📊 Found ${filesToProcess.length} MDX files to process across all sources.`);
  let processed = 0;
  let succeeded = 0;
  let chunksStored = 0;

  await Promise.all(filesToProcess.map(fileObj => limit(async () => {
    // Pass the baseDir so the script can accurately calculate the relative path category
    const chunks = processFile(fileObj.filePath, fileObj.baseDir, fileObj.prefix);
    if (chunks && chunks.length > 0) {
      for (const chunk of chunks) {
        if (await embedAndStore(chunk)) chunksStored++;
      }
      succeeded++;
    }
    processed++;
    if (processed % 10 === 0) console.log(`   📊 Progress: ${processed}/${filesToProcess.length} files (${chunksStored} chunks stored)`);
  })));

  // Cleanup old records not in this batch
  if (succeeded === filesToProcess.length) {
    console.log(`\n🧹 Ingestion 100% successful. Cleaning up stale data...`);
    const { error: deleteError } = await supabase.from('payload_docs').delete().neq('sync_batch_id', BATCH_ID);
    if (deleteError) console.error("⚠️ Cleanup failed:", deleteError.message);
  } else {
    console.warn(`\n⚠️ SKIPPING CLEANUP: ${filesToProcess.length - succeeded} files failed to process. Preserving old records to prevent data loss.`);
  }

  console.log(`\\n✅ INGESTION COMPLETE!`);
  console.log(`Files Processed: ${succeeded}/${filesToProcess.length}`);
  console.log(`Total Chunks Stored: ${chunksStored}`);
}

runIngestion();