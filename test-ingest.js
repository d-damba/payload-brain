// Unit tests for the ingest chunking helpers. Pure functions, no network.
// Run with: node test-ingest.js
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanMdx, splitIntoBlocks, splitOversized, processFile } from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}
// A chunk must never contain an unbalanced number of code fences.
const fenceCount = (s) => (s.match(/^\s*```/gm) || []).length;

// ── cleanMdx ─────────────────────────────────────────────────────────────────
console.log('\n🧹 cleanMdx');
const rawDoc = [
  '---',
  'title: Test Doc',
  'order: 5',
  '---',
  '',
  "import { Foo } from './foo'",
  "import Bar from 'bar'",
  '',
  '# Heading One',
  '',
  'Intro prose.',
  '',
  '## Section A',
  '',
  'Body prose.',
  '',
  '```ts',
  "import { CollectionConfig } from 'payload' // inside fence — must survive",
  'export const x = 1',
  '```',
].join('\n');
const cleaned = cleanMdx(rawDoc);
check('strips YAML frontmatter', !cleaned.includes('title: Test Doc'));
check('strips preamble imports (before first heading)', !cleaned.includes("from './foo'"));
check('preserves imports inside code fences', cleaned.includes("import { CollectionConfig } from 'payload'"));
check('starts at the first heading', cleaned.startsWith('# Heading One'));

// ── splitIntoBlocks: fences stay atomic ───────────────────────────────────────
console.log('\n🧱 splitIntoBlocks');
const fenced = 'Para one.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nPara two.';
const blocks = splitIntoBlocks(fenced);
check('blank line inside a fence does NOT split it',
  blocks.some(b => b.includes('const a = 1') && b.includes('const b = 2')), JSON.stringify(blocks));
check('prose paragraphs split on blank lines', blocks.length === 3, `${blocks.length} blocks`);

// ── splitOversized: bad-then-good teaching section ─────────────────────────────
console.log('\n✂️  splitOversized');
const pad = (label) => `${label} ` + 'lorem ipsum dolor sit amet. '.repeat(20);
const bigSection = [
  '### myHook',
  '',
  pad('Intro explaining the hook.'),
  '',
  'Bad example:',
  '```ts',
  '// DANGER: this creates an infinite loop',
  'await req.payload.update({ collection: "self" })',
  '```',
  '',
  pad('Now here is why that is wrong and what to do instead.'),
  '',
  'Good example:',
  '```ts',
  '// Correct: guard with context',
  'if (!context.triggered) { /* ... */ }',
  '```',
  '',
  pad('Closing notes.'),
].join('\n');
check('test fixture actually exceeds the cap', bigSection.length > 1200, `${bigSection.length} chars`);
const pieces = splitOversized(bigSection);
check('oversized section is split into >1 piece', pieces.length > 1, `${pieces.length} pieces`);
check('every piece has balanced code fences', pieces.every(p => fenceCount(p) % 2 === 0),
  pieces.map(fenceCount).join(','));
check('no piece exceeds cap (allowing the heading-prepend + single-block slack)',
  pieces.every(p => p.length <= 1200 * 1.5), pieces.map(p => p.length).join(','));
check('DANGER and Correct examples land in different pieces',
  pieces.findIndex(p => p.includes('DANGER')) !== pieces.findIndex(p => p.includes('Correct')));
check('follow-on pieces re-prepend the heading', pieces.slice(1).every(p => p.startsWith('### myHook')));
check('under-cap section is returned untouched',
  splitOversized('### tiny\n\nshort body').length === 1);

// ── processFile against the real offending doc ─────────────────────────────────
console.log('\n📄 processFile on docs/hooks/context.mdx');
const real = processFile(path.join(__dirname, 'docs/hooks/context.mdx'), path.join(__dirname, 'docs'), 'payload/docs');
check('produces chunks', real.length > 0, `${real.length} chunks`);
check('chunk_index is contiguous from 0',
  real.every((c, i) => c.chunk_index === i));
check('no chunk has unbalanced fences', real.every(c => fenceCount(c.content) % 2 === 0));
check('url + category set correctly',
  real[0].url === 'payload/docs/hooks/context.mdx' && real[0].category === 'hooks');
const maxLen = Math.max(...real.map(c => c.content.length));
console.log(`  ℹ️  ${real.length} chunks, max length ${maxLen}`);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
