/**
 * Code extractor - extracts items, lines, and metadata from source files
 */

import type Parser from 'tree-sitter';
import { detectLanguage, parseFile, type SupportedLanguage } from './tree-sitter.js';
import { getLanguageConfig } from './languages/index.js';
import type { LineRow, OccurrenceKind } from '../db/queries.js';
import { literalQualifies, normalizeLiteralWhitespace, type LiteralPosition } from '../coverage/rule.js';

// ============================================================
// Types
// ============================================================

export interface ExtractedItem {
    term: string;
    lineNumber: number;
    lineType: LineRow['line_type'];
    /** Why this item exists: a code symbol, or an indexed string literal. */
    kind: OccurrenceKind;
}

/**
 * What the literal pass saw on this file, so a full reindex can report a
 * MEASURED coverage percentage instead of a number written by hand.
 * `seen` counts every string literal node; `indexed` those the rule kept.
 */
export interface LiteralStats {
    seen: number;
    indexed: number;
}

export interface ExtractedLine {
    lineNumber: number;
    lineType: LineRow['line_type'];
}

export interface ExtractedMethod {
    name: string;
    prototype: string;
    lineNumber: number;
    visibility: string | null;
    isStatic: boolean;
    isAsync: boolean;
    bodyText: string | null;
    bodyLines: number | null;
    bodyTruncated: boolean;
}

// Truncation settings for stored method bodies (chars).
// Bodies larger than MAX_BODY_CHARS are truncated to head + tail.
export const MAX_BODY_CHARS = 8000;
export const TRUNC_HEAD_CHARS = 4000;
export const TRUNC_TAIL_CHARS = 1000;

export interface ExtractedType {
    name: string;
    kind: 'class' | 'struct' | 'interface' | 'enum' | 'type';
    lineNumber: number;
}

export interface ExtractedEdge {
    kind: 'import' | 'call';
    targetSymbol: string;
    sourceSymbol: string | null;
    sourceLine: number;
    provenance: string;
}

export interface ExtractionResult {
    language: SupportedLanguage;
    items: ExtractedItem[];
    lines: ExtractedLine[];
    methods: ExtractedMethod[];
    types: ExtractedType[];
    edges: ExtractedEdge[];
    headerComments: string[];
    literalStats: LiteralStats;
}

// ============================================================
// String literals (Lot 3)
// ============================================================

/**
 * Child node types carrying the TEXT of a string literal.
 *
 * Every name here was read off a grammar, not inferred: they are all different
 * and none of them is guessable (`line_str_text` in Swift, `template_literal`
 * in HCL, `interpreted_string_literal_content` in Go).
 */
const STRING_CONTENT_NODES = new Set([
    'string_fragment',                    // TypeScript / JavaScript / Java
    'string_content',                     // Rust / C / C++ / PHP / Ruby / Kotlin / Python
    'string_literal_content',             // C#
    'raw_string_content',                 // C# raw / C++ raw
    'interpreted_string_literal_content', // Go
    'raw_string_literal_content',         // Go raw
    'line_str_text',                      // Swift
    'multi_line_str_text',                // Swift multi-line
    'template_literal',                   // HCL
]);

/**
 * Named children that are pure delimiters. They have to be listed, because the
 * rule below is "any OTHER named child disqualifies the literal" -- and in
 * Python, C# raw strings and HCL the quotes themselves are named nodes.
 */
const STRING_DELIMITER_NODES = new Set([
    'string_start', 'string_end',                   // Python
    'raw_string_start', 'raw_string_end',           // C# raw
    'quoted_template_start', 'quoted_template_end', // HCL
]);

/**
 * The literal text, or null when there is no stable text to index.
 *
 * Null on interpolation, whatever the grammar calls it: `template_substitution`
 * (TS), `interpolation` (Python f-string, Ruby), `interpolated_expression`
 * (Swift), `variable_name` (PHP "$x"). Listing the interpolation node types
 * would mean keeping up with 14 grammars, so the test is inverted -- anything
 * named that is neither content nor delimiter disqualifies the literal. An
 * unknown child then costs one literal, never a wrong one.
 */
function literalText(node: Parser.SyntaxNode): string | null {
    const named = node.children.filter(c => c.isNamed);

    // No named children at all: an opaque token (C# @"verbatim"). Strip the
    // delimiters off the raw text.
    if (named.length === 0) {
        const start = node.text.search(/["'`]/);
        if (start === -1) return null;
        return node.text.slice(start).replace(/^["'`]+/, '').replace(/["'`]+$/, '');
    }

    const parts: string[] = [];
    for (const child of named) {
        if (STRING_CONTENT_NODES.has(child.type)) {
            parts.push(child.text);
        } else if (!STRING_DELIMITER_NODES.has(child.type)) {
            return null;
        }
    }
    return parts.length > 0 ? parts.join('') : null;
}

/**
 * Where this literal sits, reduced to what the rule cares about.
 *
 * `pair` + field `value` is shared by TypeScript, JavaScript, Python dicts and
 * Ruby hashes, so one check covers four languages. Grammars spelling the same
 * idea differently (Go `keyed_element`, Swift `dictionary_literal`, HCL
 * `object_elem`) fall through to `other`: their bare lowercase words stay out
 * until someone MEASURES that position on those languages, the way the
 * TypeScript sample was measured.
 */
function literalPosition(node: Parser.SyntaxNode): LiteralPosition {
    const parent = node.parent;
    if (!parent) return 'other';
    if (parent.type === 'literal_type') return 'type';
    if (parent.type === 'jsx_attribute') return 'jsx';
    if (parent.type === 'pair' && parent.childForFieldName('value')?.id === node.id) {
        return 'object_value';
    }
    return 'other';
}

// ============================================================
// Main extraction function

const IMPORT_NODES = new Set(['import_statement', 'import_spec', 'import_from_statement']);
const CALL_NODES = new Set([
    'call',
    'call_expression',
    'invocation_expression',
    'function_call_expression',
    'function_call',
]);

function firstStableString(
    node: Parser.SyntaxNode,
    stringNodes: Set<string>
): string | null {
    if (node.isNamed && stringNodes.has(node.type)) return literalText(node);
    for (const child of node.children) {
        const found = firstStableString(child, stringNodes);
        if (found !== null) return found;
    }
    return null;
}

function importSpecifier(node: Parser.SyntaxNode, language: SupportedLanguage,
    stringNodes: Set<string>): string | null {
    if (language === 'python' && node.type === 'import_from_statement') {
        const moduleNode = node.childForFieldName('module_name')
            ?? node.namedChildren.find(child => child.type === 'relative_import');
        const moduleName = moduleNode?.text ?? null;
        return moduleName?.startsWith('.') ? moduleName : null;
    }
    return firstStableString(node, stringNodes);
}

function directCallee(node: Parser.SyntaxNode): string | null {
    const candidate = node.childForFieldName('function')
        ?? node.childForFieldName('name')
        ?? node.namedChildren[0];
    if (!candidate) return null;
    const value = candidate.text;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : null;
}
// ============================================================

/**
 * Extract all indexable information from source code
 */
export function extract(sourceCode: string, filePath: string): ExtractionResult | null {
    const detectedLanguage = detectLanguage(filePath);
    if (!detectedLanguage) {
        return null;
    }
    const language: SupportedLanguage = detectedLanguage;

    const tree = parseFile(sourceCode, filePath);
    if (!tree) {
        return null;
    }

    const config = getLanguageConfig(language);
    const sourceLines = sourceCode.split('\n');

    const items: ExtractedItem[] = [];
    const linesMap = new Map<number, LineRow['line_type']>();
    const methods: ExtractedMethod[] = [];
    const types: ExtractedType[] = [];
    const headerComments: string[] = [];
    const literalStats: LiteralStats = { seen: 0, indexed: 0 };

    // Track if we've seen non-comment code (for header comments)
    let seenCode = false;
    const edges: ExtractedEdge[] = [];

    /**
     * Recursively visit all nodes in the tree
     */
    function visit(node: Parser.SyntaxNode, sourceSymbol: string | null = null): void {
        let childSourceSymbol = sourceSymbol;
        const lineNumber = node.startPosition.row + 1; // 1-based

        // Check for comments
        // Fix 1.8: Python docstrings (expression_statement containing only a string child)
        const isDocstring = language === 'python'
            && node.type === 'expression_statement'
            && node.childCount === 1
            && node.children[0].type === 'string';
        if (config.commentNodes.has(node.type) || isDocstring) {
            if (!seenCode) {
                // This is a header comment
                headerComments.push(extractCommentText(node.text));
            }
            setLineType(lineNumber, 'comment');
            extractIdentifiersFromComment(node.text, lineNumber, items, config.isKeyword);
            return; // Don't recurse into comments/docstrings
        }

        // Check for type declarations (class, struct, interface, etc.)
        if (config.typeNodes.has(node.type)) {
            seenCode = true;
            const typeInfo = extractTypeInfo(node, language);
            if (typeInfo) {
                types.push(typeInfo);
                setLineType(lineNumber, 'struct');

                // HCL: block labels are in a composed name (e.g. "resource.aws_instance.web").
                // Index each label part as an item so `aidex_query` finds the declaration
                // even when the label is only referenced here (e.g. a never-used module).
                // Skip the first part (block type keyword like "resource"); index the rest
                // unconditionally — labels like "default" or "root" are user-chosen names
                // that happen to collide with HCL_KEYWORDS, but are meaningful here.
                if (language === 'hcl' && node.type === 'block') {
                    const parts = typeInfo.name.split('.');
                    for (let i = 1; i < parts.length; i++) {
                        if (parts[i].length >= 2) {
                            items.push({ term: parts[i], lineNumber, lineType: 'struct', kind: 'symbol' });
                        }
                    }
                }
            }
        }

        // Check for method declarations
        if (config.methodNodes.has(node.type)) {
            seenCode = true;
            const methodInfo = extractMethodInfo(node, language, sourceLines);
            if (methodInfo) {
                methods.push(methodInfo);
                // HCL function_call is a usage (inside an attribute expression), not a definition.
                // Don't overwrite the enclosing attribute's 'property' line type.
                if (!(language === 'hcl' && node.type === 'function_call')) {
                    setLineType(lineNumber, 'method');
                    childSourceSymbol = methodInfo.name;
                }
            }
        }

        // Check for property declarations
        if (config.propertyNodes?.has(node.type)) {
            seenCode = true;
            setLineType(lineNumber, 'property');
        }

        // String literals (Lot 3), BEFORE the identifier check and before
        // recursion. `node.isNamed` is not optional: an ANONYMOUS token carries
        // its own text as its type, so the TypeScript type keyword `string` is
        // a node of type 'string' too, and would be read here as a literal.

        if (IMPORT_NODES.has(node.type)) {
            const specifier = importSpecifier(node, language, config.stringNodes);
            if (specifier?.startsWith('.')) {
                edges.push({
                    kind: 'import',
                    targetSymbol: specifier,
                    sourceSymbol,
                    sourceLine: lineNumber,
                    provenance: 'tree-sitter:relative-import',
                });
            }
        }

        if (CALL_NODES.has(node.type)) {
            const callee = directCallee(node);
            if (callee) {
                edges.push({ kind: 'call', targetSymbol: callee, sourceSymbol,
                    sourceLine: lineNumber, provenance: 'tree-sitter:direct-call' });
            }
        }
        if (node.isNamed && config.stringNodes.has(node.type)) {
            seenCode = true;
            literalStats.seen++;

            const text = literalText(node);
            // Normalized ONCE here and reused for both the qualification check
            // and the stored term: `classifyPattern` (inside `literalQualifies`)
            // normalizes again internally, but that is idempotent -- the point
            // of normalizing here too is that the term actually WRITTEN to the
            // index is the canonical form, matching what db/queries.ts builds
            // its query params against (f08aeeb1).
            const normalized = text !== null ? normalizeLiteralWhitespace(text) : null;
            if (normalized !== null && literalQualifies(normalized, literalPosition(node))) {
                literalStats.indexed++;
                items.push({
                    term: normalized,
                    lineNumber,
                    // Deliberately NOT setLineType: LINE_TYPE_PRIORITY ranks
                    // 'string' above 'code', so flagging the line would flip
                    // 9175 lines from 'code' to 'string' on koryphaios alone and
                    // silently change what every existing `type_filter: ['code']`
                    // query returns. Only a line created from scratch for this
                    // literal gets 'string', resolved in the final pass below.
                    lineType: 'string',
                    kind: 'literal',
                });
            }
            // Never recurse into the TEXT of a string: `string` contains
            // `string_fragment`, which would double-count the same text, and a
            // template literal would come apart into its pieces.
            //
            // Interpolations are the exception, and they matter: the identifiers
            // in `hello ${userName}` or "pre-$x" were indexed as symbols before
            // Lot 3 and have to stay indexed, or this lot would quietly shrink
            // the symbol dimension it promised not to touch.
            for (const child of node.children) {
                if (!child.isNamed) continue;
                if (STRING_CONTENT_NODES.has(child.type)) continue;
                if (STRING_DELIMITER_NODES.has(child.type)) continue;
                visit(child, childSourceSymbol);
            }
            return;
        }

        // Check for identifiers
        if (config.identifierNodes.has(node.type)) {
            seenCode = true;
            const term = node.text;

            // Filter out keywords and very short terms
            if (term.length >= 2 && !config.isKeyword(term)) {
                items.push({
                    term,
                    lineNumber,
                    lineType: linesMap.get(lineNumber) ?? 'code',
                    kind: 'symbol',
                });
                setLineType(lineNumber, linesMap.get(lineNumber) ?? 'code');
            }
        }

        // Recurse into children
        for (const child of node.children) {
            visit(child, childSourceSymbol);
        }
    }

    /**
     * Set line type (doesn't overwrite more specific types)
     */
    function setLineType(lineNumber: number, type: LineRow['line_type']): void {
        const existing = linesMap.get(lineNumber);
        if (!existing || shouldUpgrade(existing, type)) {
            linesMap.set(lineNumber, type);
        }
    }

    // Start traversal
    visit(tree.rootNode);

    // A literal can be the ONLY thing on its line (an element of a string array,
    // a lone object value). No other pass recorded that line, so it has no row
    // to hang an occurrence on -- and the insert would fail on a missing line id.
    // Create it here, typed 'string'.
    //
    // This is the one case where a literal decides a line type, and it is safe
    // precisely because the line does not exist yet: nothing is being upgraded,
    // so no `type_filter: ['code']` query loses a line it used to return.
    for (const item of items) {
        if (item.kind === 'literal' && !linesMap.has(item.lineNumber)) {
            linesMap.set(item.lineNumber, 'string');
        }
    }

    // Convert lines map to array
    const lines: ExtractedLine[] = Array.from(linesMap.entries())
        .map(([lineNumber, lineType]) => ({ lineNumber, lineType }))
        .sort((a, b) => a.lineNumber - b.lineNumber);

    // Update item line types from final linesMap.
    // A literal keeps 'string' ONLY when no other pass typed its line -- i.e.
    // when the line exists purely because of this literal. Measured on
    // koryphaios, 79% of literal occurrences land on a line already typed
    // 'code', and those keep that type untouched.
    for (const item of items) {
        item.lineType = linesMap.get(item.lineNumber)
            ?? (item.kind === 'literal' ? 'string' : 'code');
    }

    return {
        language,
        items,
        lines,
        methods,
        types,
        edges,
        headerComments,
        literalStats,
    };
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Priority order for line types (higher = more specific)
 */
const LINE_TYPE_PRIORITY: Record<LineRow['line_type'], number> = {
    code: 0,
    string: 1,
    comment: 2,
    property: 3,
    method: 4,
    struct: 5,
};

/**
 * Check if we should upgrade from one type to another
 */
function shouldUpgrade(existing: LineRow['line_type'], newType: LineRow['line_type']): boolean {
    return LINE_TYPE_PRIORITY[newType] > LINE_TYPE_PRIORITY[existing];
}

/**
 * Extract plain text from a comment (remove comment markers)
 */
function extractCommentText(commentText: string): string {
    return commentText
        .replace(/^\/\/\s*/gm, '')          // Remove //
        .replace(/^\/\*+\s*/g, '')           // Remove /*
        .replace(/\s*\*+\/$/g, '')           // Remove */
        .replace(/^\s*\*\s?/gm, '')          // Remove * at start of lines
        .replace(/^#+\s*/gm, '')             // Remove # (Python)
        .trim();
}

/**
 * Extract identifiers from comment text
 */
function extractIdentifiersFromComment(
    commentText: string,
    lineNumber: number,
    items: ExtractedItem[],
    isKeyword: (term: string) => boolean
): void {
    // Extract words that look like identifiers (CamelCase, snake_case, etc.)
    const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    const matches = commentText.match(identifierPattern) ?? [];

    for (const term of matches) {
        if (term.length >= 3 && !isKeyword(term)) {
            items.push({
                term,
                lineNumber,
                lineType: 'comment',
                kind: 'symbol',
            });
        }
    }
}

/**
 * Extract type information from a type declaration node
 */
function extractTypeInfo(node: Parser.SyntaxNode, language: SupportedLanguage): ExtractedType | null {
    // HCL blocks: compose name from block type keyword + string labels
    // e.g. `resource "aws_instance" "web"` → `resource.aws_instance.web`
    if (language === 'hcl' && node.type === 'block') {
        const parts: string[] = [];
        for (const child of node.children) {
            if (child.type === 'identifier') {
                parts.push(child.text);
            } else if (child.type === 'string_lit') {
                // Grammar guarantees string_lit for block labels is wrapped in double quotes
                parts.push(child.text.slice(1, -1));
            } else if (child.type === 'block_start') {
                break;
            }
        }
        if (parts.length > 0) {
            return {
                name: parts.join('.'),
                kind: 'type',
                lineNumber: node.startPosition.row + 1,
            };
        }
    }

    // Prefer the grammar's `name` field when present (robust across grammars,
    // e.g. Swift where the name is a `type_identifier` under field `name`).
    // Fall back to scanning children for common identifier node types.
    const nameNode = node.childForFieldName('name') ?? node.children.find(c =>
        c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name'
    );

    if (!nameNode) {
        return null;
    }

    // Determine kind from node type
    let kind: ExtractedType['kind'] = 'class';
    const nodeType = node.type.toLowerCase();

    if (nodeType.includes('struct')) kind = 'struct';
    else if (nodeType.includes('interface')) kind = 'interface';
    else if (nodeType.includes('enum')) kind = 'enum';
    else if (nodeType.includes('type_alias')) kind = 'type';

    return {
        name: nameNode.text,
        kind,
        lineNumber: node.startPosition.row + 1,
    };
}

/**
 * Find the function name inside a C/C++ function_definition node.
 *
 * The tree-sitter-c grammar nests the name under a declarator chain:
 *   function_definition
 *     → (pointer_declarator)*        // one level per `*` in the return type
 *       → function_declarator
 *         → identifier               // the name we want
 *
 * For C++ the chain may also include reference_declarator (`&`), and the leaf
 * may be a field_identifier / qualified_identifier (e.g. `Class::method`).
 * Returns the bare name, or null if no declarator is found.
 */
function findCFunctionName(node: Parser.SyntaxNode): string | null {
    // Descend through wrapping declarators to reach the function_declarator.
    let cursor: Parser.SyntaxNode | null = node.childForFieldName('declarator');
    while (cursor) {
        if (cursor.type === 'function_declarator') {
            const decl = cursor.childForFieldName('declarator');
            if (decl) {
                // decl is identifier / field_identifier / qualified_identifier / destructor_name.
                return decl.text;
            }
            return null;
        }
        // pointer_declarator, reference_declarator, parenthesized_declarator all
        // hold the next declarator in their own `declarator` field.
        cursor = cursor.childForFieldName('declarator');
    }
    return null;
}

/**
 * Extract method information from a method declaration node
 */
function extractMethodInfo(
    node: Parser.SyntaxNode,
    language: SupportedLanguage,
    sourceLines: string[]
): ExtractedMethod | null {
    // Find method name
    let name: string | null = null;
    let visibility: string | null = null;
    let isStatic = false;
    let isAsync = false;

    // Helper to check modifier text
    function checkModifier(text: string): void {
        const lower = text.toLowerCase();
        if (lower === 'public' || lower === 'private' || lower === 'protected' || lower === 'internal') {
            visibility = lower;
        }
        if (lower === 'static') isStatic = true;
        if (lower === 'async') isAsync = true;
    }

    // C/C++: the function name is never a direct identifier child of
    // function_definition. It lives inside a function_declarator, which may be
    // wrapped in any number of pointer_declarator nodes (e.g. `uint8_t *slot_at(...)`)
    // or reference_declarator (C++). Walk down to find it.
    if ((language === 'c' || language === 'cpp') && node.type === 'function_definition') {
        name = findCFunctionName(node);
    }

    // Prefer the grammar's `name` field when present. Needed for Swift, where
    // function names are `simple_identifier` (not matched by the loop below)
    // and init/deinit names are anonymous `init`/`deinit` tokens exposed only
    // via the `name` field. Harmless for other grammars (same result).
    if (!name) {
        const nameField = node.childForFieldName('name');
        if (nameField) name = nameField.text;
    }

    for (const child of node.children) {
        if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'name') {
            if (!name) name = child.text;
        }

        // Fix 3.12: Handle modifier containers (C# modifier_list, etc.)
        if (child.type === 'modifiers' || child.type === 'modifier_list' || child.type === 'modifier') {
            // Recurse into modifier container to find individual modifiers
            for (const mod of child.children) {
                checkModifier(mod.text);
            }
            // Also check the container itself if it's a single modifier
            checkModifier(child.text);
        } else {
            // Check modifiers directly on child
            checkModifier(child.text);
        }
    }

    // Fix 1.7: Arrow functions / function expressions get name from parent variable_declarator
    if (!name && (node.type === 'arrow_function' || node.type === 'function_expression')) {
        const parent = node.parent;
        if (parent && parent.type === 'variable_declarator') {
            const nameNode = parent.children.find(c => c.type === 'identifier');
            if (nameNode) {
                name = nameNode.text;
            }
        }
    }

    if (!name) {
        return null;
    }

    // Extract prototype (first line of method, cleaned up)
    const startLine = node.startPosition.row;
    const endLine = Math.min(startLine + 5, sourceLines.length - 1); // Max 6 lines for prototype

    let prototype = '';
    for (let i = startLine; i <= endLine; i++) {
        const line = sourceLines[i]?.trim() ?? '';
        prototype += (prototype ? ' ' : '') + line;

        // Stop at opening brace or arrow
        if (line.includes('{') || line.includes('=>')) {
            prototype = prototype.replace(/\s*\{.*$/, '').replace(/\s*=>.*$/, '').trim();
            break;
        }
    }

    // Clean up prototype
    prototype = prototype
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ', ')
        .trim();

    // Body extraction: full method text from start line to end line.
    // Used by embeddings for re-indexing on model change and snippet display.
    const bodyStartRow = node.startPosition.row;
    const bodyEndRow = Math.min(node.endPosition.row, sourceLines.length - 1);
    const bodyLineCount = bodyEndRow - bodyStartRow + 1;
    const rawBody = sourceLines.slice(bodyStartRow, bodyEndRow + 1).join('\n');

    let bodyText: string;
    let bodyTruncated = false;
    if (rawBody.length > MAX_BODY_CHARS) {
        bodyTruncated = true;
        const head = rawBody.slice(0, TRUNC_HEAD_CHARS);
        const tail = rawBody.slice(-TRUNC_TAIL_CHARS);
        const skipped = rawBody.length - TRUNC_HEAD_CHARS - TRUNC_TAIL_CHARS;
        bodyText = `${head}\n... [truncated, ${skipped} chars omitted] ...\n${tail}`;
    } else {
        bodyText = rawBody;
    }

    return {
        name,
        prototype,
        lineNumber: node.startPosition.row + 1,
        visibility,
        isStatic,
        isAsync,
        bodyText,
        bodyLines: bodyLineCount,
        bodyTruncated,
    };
}

// ============================================================
// Exports
// ============================================================

export { detectLanguage, isSupported, getSupportedExtensions } from './tree-sitter.js';
