# Candidate import and call edges

## Intent

Extend AiDex from an identifier locator into a lightweight code-navigation graph.
The first graph version records useful relationships that can be extracted locally
without claiming compiler-grade semantic resolution.

The graph must make uncertainty explicit. Every relationship introduced by this
phase is a `candidate`: it is supported by syntax and local index evidence, but it
is not guaranteed to be the binding selected by a compiler or language server.

## User value

The new index should let an agent answer questions that lexical search alone cannot:

- Which files import this file?
- Which indexed symbols probably call this symbol?
- Which files and symbols may be affected by changing this symbol?
- Is a relationship exact, candidate, or unresolved?

## Phase 1 scope

### Import edges

Record project-local imports when a parser can extract a module specifier and the
specifier can be mapped to an indexed file. The edge connects the importing file to
the imported file.

Initial supported forms should follow the syntax already understood by AiDex's
Tree-sitter language parsers. Relative imports are the safest starting point.

### Call edges

Record direct call expressions such as `foo()` when the callee name can be matched
to a declaration in the same project. Prefer same-file declarations, then imported
bindings where the import information is sufficient. Ambiguous matches remain
candidate edges and must not be presented as exact.

### Confidence contract

Each edge stores:

- a relationship kind (`import` or `call`);
- a confidence (`candidate` in this phase);
- source and target file identifiers;
- optional source and target symbol identifiers;
- the source location that produced the relationship;
- enough provenance to explain how the relationship was inferred.

## Storage and lifecycle

Edges live in the project SQLite index and participate in the existing file-level
incremental lifecycle:

- reindexing a file replaces every edge originating from that file;
- deleting a file removes its outgoing edges and clears the resolved target of
  incoming observations, which remain visible as unresolved candidates;
- a full rebuild recreates the graph deterministically;
- schema migration preserves existing indexes without requiring manual deletion.

## Agent-facing surface

Add read-only MCP queries for candidate relationships. Results must include file,
line, relationship kind, confidence, and provenance. Empty results must not be
described as proof of semantic absence: the graph is syntax-derived and incomplete.

The first useful surface is expected to support:

- references/callers of a symbol or file;
- direct outgoing dependencies;
- a shallow impact view built from incoming import and call edges.

## Non-goals

- Compiler- or LSP-grade binding resolution.
- Runtime flows through HTTP, queues, dependency injection, reflection, or dynamic
  property access.
- Cross-project relationships in the first phase.
- Presenting candidate edges as guaranteed call relationships.
- Replacing lexical or semantic search.

## Acceptance direction

The feature is useful when it produces deterministic local edges, updates them
correctly after a file change, exposes their uncertainty to agents, and never
regresses the current identifier/signature/embedding index.

## Likely follow-ups

1. Promote selected edges to `exact` using language-specific compiler or LSP data.
2. Resolve aliases, re-exports, methods, and qualified calls.
3. Add cross-project edges through existing AiDex project links.
4. Incorporate graph neighbourhood signals into hybrid search ranking.
