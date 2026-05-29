// Unit tests for the real toConcise truncation logic (imported from the server,
// so it can't drift from production). Pure function, no network.
// Run with: node test-truncation.js
import { toConcise } from './payload-mcp.js';

const CONCISE_CAP = 800; // mirrors the cap in payload-mcp.js
const MARKER_TAIL = 'for the complete section.]';
const fenceCount = (s) => (s.match(/```/g) || []).length;

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// CASE 1 — long prose, no code fence: plain truncation.
console.log('\n✂️  plain prose truncation');
const c1 = '## Intro\n\n' + 'word '.repeat(220); // ~1110 chars, no fence
const r1 = toConcise(c1);
check('truncated result is shorter than the original', r1.length < c1.length, `${r1.length} vs ${c1.length}`);
check('ends with the escalation marker', r1.trimEnd().endsWith(MARKER_TAIL));

// CASE 2 — cut lands mid-fence with substantial trailing content: extend to close.
console.log('\n🧩 mid-fence cut extends to close the fence');
const c2 = '## Code\n\n' + 'pad '.repeat(190) + '\n\n```ts\n' + 'const a = 1\n'.repeat(8) + '```\n\n' + 'trailing '.repeat(40);
const r2 = toConcise(c2);
check('output has balanced code fences', fenceCount(r2) % 2 === 0, `${fenceCount(r2)} fences`);
check('result is shorter than the original', r2.length < c2.length, `${r2.length} vs ${c2.length}`);
check('ends with the escalation marker', r2.trimEnd().endsWith(MARKER_TAIL));

// CASE 3 — unclosed fence in the source: cannot close it, return unchanged.
console.log('\n🚧 unclosed fence in source is returned untouched');
const c3 = '## Broken\n\n' + 'word '.repeat(150) + '\n\n```ts\nfunction broken() {\n  // never closed';
const r3 = toConcise(c3);
check('returns the source unchanged (no broken fence, no marker)', r3 === c3);

// CASE 4 — REGRESSION: dropped tail is smaller than the marker. The truncated
// form would be LONGER than the original, so toConcise must return the original.
console.log('\n🛡️  hardening: concise never longer than the original');
const c4 = '## Edge\n\n' + 'pad '.repeat(195) + '\n\n```ts\n' + 'const secret = 1\n'.repeat(2) + '```\n' + 'end';
const r4 = toConcise(c4);
check('result is never longer than the original', r4.length <= c4.length, `${r4.length} vs ${c4.length}`);
check('falls back to the full content when truncation would not save space', r4 === c4);

// CASE 5 — already under the cap: untouched.
console.log('\n📏 under-cap content is untouched');
const c5 = '## Tiny\n\nshort body here';
check('returns short content unchanged', toConcise(c5) === c5);
check('adds no marker to short content', !toConcise(c5).includes(MARKER_TAIL));

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
