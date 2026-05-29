# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-05-29

### Changed
- **Ingest now bounds chunk size.** After the primary `##`/`###` header split, any section over ~1,200 chars is sub-split on blank-line boundaries (never inside a code fence), with the section heading re-prepended to each follow-on piece. This keeps chunks at a healthy embedding size and tends to separate anti-patterns from canonical examples — mitigating (not eliminating) the concise-truncation limitation noted in 1.1.0. **Requires re-running `node ingest.js`.**

### Added
- `cleanMdx` strips leading YAML frontmatter and preamble `import`/`export` statements (before the first heading) so MDX boilerplate no longer pollutes embeddings or returned content; imports inside code fences are preserved.
- Chunking helpers (`cleanMdx`, `splitIntoBlocks`, `splitOversized`, `processFile`) are exported and `ingest.js` only auto-runs when invoked directly, so they can be unit-tested without triggering ingestion.
- `test-ingest.js` — network-free unit tests for the chunking helpers (fence safety, frontmatter stripping, oversize splitting, validation against a real doc).

### Fixed
- Stale-data cleanup is now gated on **zero chunk-level failures**, not just file completion. Previously a file with failed chunk embeddings still counted as "succeeded," which could let cleanup delete the old rows those failed chunks should have replaced — leaving silent gaps.

## [1.1.0] - 2026-05-29

### Added
- In-memory caching in `payload-mcp.js` to cut token and API costs on repeated queries:
  - **Embedding cache** keyed on `semantic_intent` — skips the OpenAI embedding call (the only paid call) when the same intent recurs, even with different keywords/category/limit.
  - **Result cache** keyed on `keywords::category::limit::intent` — a full hit skips both the OpenAI and Supabase calls.
  - Implemented with a native `Map` (LRU eviction via insertion order, bounded by `CACHE_MAX = 300`). No TTL: docs are static for the server's lifetime, so re-running `ingest.js` requires a server restart to clear the cache.
- Real `concise` mode: chunk `content` is now truncated to an ~800-char, fence-aware cap (never cuts inside a code block) with an explicit `[Truncated — call again with mode:"full" ...]` marker so the model knows to escalate. `full` mode returns the complete chunk.

### Changed
- Slimmed the search response payload: dropped the per-result `scoring` block and the redundant `metadata` (`source_file`, already implied by `url`). Each result is now `{ url, category, content }`.
- Switched all tool responses to compact JSON (removed pretty-print indentation) to reduce token usage.

### Notes
- Top-level `diagnostics.confidence` (`LOW`/`MARGINAL`/`HIGH`) and `top_rrf_score` are unchanged — the confidence signal the architecture mandate relies on is preserved.

### Known Limitations
- **Concise truncation can clip or misrepresent a code example past the ~800-char cap.** `toConcise` only protects a code fence when the cut lands *inside* one; it does not guarantee the canonical example is reached. In sections that front-load prose — or an anti-pattern before the corrected version (e.g. the "Bad example" in `hooks/context.mdx`) — concise mode may return only the preamble, or only the anti-pattern, plus the escalation marker. Reference sections (e.g. `hooks/collections.mdx`) front-load the signature and are unaffected. Note that a positional rule (e.g. "always include the first fence") does *not* fix this: choosing the *correct* example is a semantic judgment a byte-level truncator can't make, and "first fence" would simply lock in the anti-pattern. The `mode:"full"` marker is the real mitigation — concise is a triage/preview layer, and correctness for multi-example sections depends on the model escalating to `full`. The durable fix is cleaner semantic chunking at ingest so anti-patterns and canonical examples don't share a front-loaded chunk.

## [1.0.0] - 2026-05-12

### Added
- Initial release: Payload v3 AI Brain Toolkit.
- `ingest.js` — pulls official Payload v3 docs and AI skills from GitHub, chunks by markdown headers, embeds with `text-embedding-3-small`, and stores in Supabase pgvector.
- `payload-mcp.js` — MCP server exposing the `search_payload_docs` tool with hybrid (RRF) full-text + vector search.
- `setup.js` — installs dependencies and scaffolds `.env` and `.mcp.json`.
