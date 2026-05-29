import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
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
const MAX_CHUNK_LENGTH = 1200; // sections longer than this are sub-split on safe boundaries
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

// Strip a leading YAML frontmatter block and the MDX import/export statements
// that sit in the preamble (before the first Markdown heading). Code examples
// live after headings inside fences, so their imports are left untouched.
function cleanMdx(content) {
  let text = content.replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  const firstHeading = text.search(/^#{1,6}\s/m);
  if (firstHeading === -1) return text.trim();

  const head = text.slice(0, firstHeading).replace(/^\s*(import|export)\s.*$/gm, '');
  return (head + text.slice(firstHeading)).trim();
}

// Split text into atomic blocks on blank lines, treating fenced code blocks as
// indivisible so a ``` fence is never broken across blocks.
function splitIntoBlocks(text) {
  const blocks = [];
  let buf = [];
  let inFence = false;
  const flush = () => { if (buf.length) { blocks.push(buf.join('\n')); buf = []; } };

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
    } else if (!inFence && line.trim() === '') {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks.map(b => b.trim()).filter(Boolean);
}

const isTableLine = (line) => /^\s*\|/.test(line);
// A separator row is the |---|---| line under a table header: only pipes,
// dashes, colons and whitespace.
const isSeparatorLine = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

// A block is a splittable table if it's mostly pipe rows and has a separator.
function isTableBlock(block) {
  const lines = block.split('\n').filter(l => l.trim());
  if (lines.length < 3 || !lines.some(isSeparatorLine)) return false;
  return lines.filter(isTableLine).length / lines.length > 0.8;
}

// Split an oversized markdown table into row-groups under the cap, repeating the
// header + separator rows on each group so every fragment stays self-describing.
// A single row larger than the cap is kept whole (a table row can't be split).
function splitTable(block) {
  const lines = block.split('\n');
  const sepIdx = lines.findIndex(isSeparatorLine);
  if (sepIdx < 1) return [block]; // malformed/headerless — leave intact

  const header = lines.slice(0, sepIdx + 1).join('\n');
  const rows = lines.slice(sepIdx + 1).filter(l => l.trim());

  const groups = [];
  let current = header;
  for (const row of rows) {
    if (current !== header && current.length + row.length + 1 > MAX_CHUNK_LENGTH) {
      groups.push(current);
      current = header;
    }
    current += '\n' + row;
  }
  if (current !== header) groups.push(current);
  return groups.length ? groups : [block];
}

// Sub-split an oversized section into <= MAX_CHUNK_LENGTH pieces on block
// boundaries (never mid-fence). The section's heading is re-prepended to each
// follow-on piece so orphaned sub-chunks keep their context. A single code
// block larger than the cap is kept intact rather than broken.
//
// NOTE (someday, only if retrieval feels off): when a section is prose-then-code,
// the explanatory prose stays in the first piece, leaving follow-on code-only
// pieces semantically "thin" — they lean on the re-prepended heading alone for
// embedding signal, so they can rank below the prose-rich piece (observed with
// the "Preventing Infinite Loops" bad/good examples). Adjacency currently rescues
// this. A future enhancement could carry one lead sentence of prose into each
// code-only follow-on piece so it embeds with more signal. Not an action item.
function splitOversized(section) {
  if (section.length <= MAX_CHUNK_LENGTH) return [section];

  const headingMatch = section.match(/^#{1,6}\s.*$/m);
  const heading = headingMatch ? headingMatch[0].trim() : '';

  // Expand any oversized table into header-carrying row-groups before packing.
  const blocks = [];
  for (const block of splitIntoBlocks(section)) {
    if (block.length > MAX_CHUNK_LENGTH && isTableBlock(block)) blocks.push(...splitTable(block));
    else blocks.push(block);
  }

  const pieces = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > MAX_CHUNK_LENGTH) {
      pieces.push(current.trim());
      current = heading && !block.startsWith('#') ? heading + '\n\n' : '';
    }
    current += (current ? '\n\n' : '') + block;
  }
  if (current.trim()) pieces.push(current.trim());

  // Merge a runt tail back into the previous piece rather than emit/drop it.
  if (pieces.length > 1 && pieces[pieces.length - 1].length < MIN_CONTENT_LENGTH) {
    pieces[pieces.length - 2] += '\n\n' + pieces.pop();
  }

  return pieces;
}

function processFile(filePath, baseDir, prefix) {
  const content = cleanMdx(fs.readFileSync(filePath, 'utf-8'));

  const relativePath = path.relative(baseDir, filePath);
  const url = `${prefix}/${relativePath.replace(/\\/g, '/')}`;

  // If it comes from skills, label the category as 'skills'. Otherwise, use the folder name.
  const category = prefix.includes('skills') ? 'skills' : (relativePath.split(path.sep)[0] || 'general');

  // Primary split on Markdown headers (## or ###), then bound section size.
  const sections = content.split(/(?=^##\s|^###\s)/m);

  const chunks = [];
  let chunkIndex = 0;

  for (let section of sections) {
    section = section.trim();
    if (section.length < MIN_CONTENT_LENGTH) continue;

    for (const piece of splitOversized(section)) {
      if (piece.length < MIN_CONTENT_LENGTH) continue;
      chunks.push({
        url,
        chunk_index: chunkIndex++,
        category,
        content: piece,
        payload: { source_file: relativePath } // Storing filepath in the JSON payload
      });
    }
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
  let chunkFailures = 0;

  await Promise.all(filesToProcess.map(fileObj => limit(async () => {
    // Pass the baseDir so the script can accurately calculate the relative path category
    const chunks = processFile(fileObj.filePath, fileObj.baseDir, fileObj.prefix);
    if (chunks && chunks.length > 0) {
      for (const chunk of chunks) {
        if (await embedAndStore(chunk)) chunksStored++;
        else chunkFailures++;
      }
      succeeded++;
    }
    processed++;
    if (processed % 10 === 0) console.log(`   📊 Progress: ${processed}/${filesToProcess.length} files (${chunksStored} chunks stored)`);
  })));

  // Cleanup old records not in this batch — only when EVERY chunk stored
  // successfully. Gating on files alone would let a file with failed chunks
  // count as "done" and delete the old rows those chunks should have replaced.
  if (chunkFailures === 0 && succeeded === filesToProcess.length) {
    console.log(`\n🧹 Ingestion 100% successful. Cleaning up stale data...`);
    const { error: deleteError } = await supabase.from('payload_docs').delete().neq('sync_batch_id', BATCH_ID);
    if (deleteError) console.error("⚠️ Cleanup failed:", deleteError.message);
  } else {
    console.warn(`\n⚠️ SKIPPING CLEANUP: ${chunkFailures} chunk(s) failed across ${filesToProcess.length - succeeded} unfinished file(s). Preserving old records to prevent data loss.`);
  }

  console.log(`\n✅ INGESTION COMPLETE!`);
  console.log(`Files Processed: ${succeeded}/${filesToProcess.length}`);
  console.log(`Total Chunks Stored: ${chunksStored}${chunkFailures ? ` (${chunkFailures} failed)` : ''}`);
}

// Only run the pipeline when invoked directly (`node ingest.js`), so the pure
// chunking helpers above can be imported by tests without triggering ingestion.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestion();
}

export { cleanMdx, splitIntoBlocks, splitOversized, processFile };