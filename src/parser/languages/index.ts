/**
 * Language configuration registry
 */

import type { SupportedLanguage } from '../tree-sitter.js';
import * as csharp from './csharp.js';
import * as typescript from './typescript.js';
import * as rust from './rust.js';
import * as python from './python.js';
import * as c from './c.js';
import * as cpp from './cpp.js';
import * as java from './java.js';
import * as go from './go.js';
import * as php from './php.js';
import * as ruby from './ruby.js';
import * as hcl from './hcl.js';
import * as kotlin from './kotlin.js';
import * as swift from './swift.js';

export interface LanguageConfig {
    isKeyword: (term: string) => boolean;
    identifierNodes: Set<string>;
    commentNodes: Set<string>;
    methodNodes: Set<string>;
    typeNodes: Set<string>;
    propertyNodes?: Set<string>;
    /**
     * Node types holding a string literal (Lot 3).
     *
     * Every entry below was READ off the grammar with a probe, never guessed:
     * the names differ per grammar in ways no convention predicts
     * (`interpreted_string_literal` in Go, `encapsed_string` in PHP,
     * `line_string_literal` in Swift, `string_lit` in HCL).
     *
     * Interpolating forms are left OUT on purpose -- C#'s
     * `interpolated_string_expression` is not here, and the ones that share a
     * node type with their plain form (a Python f-string is still `string`) are
     * dropped later, by the extractor, on seeing an interpolation child. An
     * interpolated string has no stable text to index.
     *
     * Required, not optional: a new language must state what its strings are
     * called. Defaulting to empty would silently index nothing and report the
     * language as 0% covered, which reads as "measured" rather than "forgotten".
     */
    stringNodes: Set<string>;
}

// Shared across the C-family and the two TS dialects; declared once so a fix
// lands everywhere at the same time.
const TS_STRING_NODES = new Set(['string', 'template_string']);
const C_STRING_NODES = new Set(['string_literal']);

const configs: Record<SupportedLanguage, LanguageConfig> = {
    csharp: {
        isKeyword: csharp.isKeyword,
        identifierNodes: csharp.CSHARP_IDENTIFIER_NODES,
        commentNodes: csharp.CSHARP_COMMENT_NODES,
        methodNodes: csharp.CSHARP_METHOD_NODES,
        typeNodes: csharp.CSHARP_TYPE_NODES,
        propertyNodes: csharp.CSHARP_PROPERTY_NODES,
        // `verbatim_string_literal` (@"...") is a single opaque token with no
        // children, so the extractor falls back to stripping its delimiters.
        stringNodes: new Set(['string_literal', 'verbatim_string_literal', 'raw_string_literal']),
    },
    typescript: {
        isKeyword: typescript.isKeyword,
        identifierNodes: typescript.TYPESCRIPT_IDENTIFIER_NODES,
        commentNodes: typescript.TYPESCRIPT_COMMENT_NODES,
        methodNodes: typescript.TYPESCRIPT_METHOD_NODES,
        typeNodes: typescript.TYPESCRIPT_TYPE_NODES,
        stringNodes: TS_STRING_NODES,
    },
    javascript: {
        // JavaScript uses same config as TypeScript
        isKeyword: typescript.isKeyword,
        identifierNodes: typescript.TYPESCRIPT_IDENTIFIER_NODES,
        commentNodes: typescript.TYPESCRIPT_COMMENT_NODES,
        methodNodes: typescript.TYPESCRIPT_METHOD_NODES,
        typeNodes: typescript.TYPESCRIPT_TYPE_NODES,
        stringNodes: TS_STRING_NODES,
    },
    rust: {
        isKeyword: rust.isKeyword,
        identifierNodes: rust.RUST_IDENTIFIER_NODES,
        commentNodes: rust.RUST_COMMENT_NODES,
        methodNodes: rust.RUST_METHOD_NODES,
        typeNodes: rust.RUST_TYPE_NODES,
        stringNodes: new Set(['string_literal', 'raw_string_literal']),
    },
    python: {
        isKeyword: python.isKeyword,
        identifierNodes: python.PYTHON_IDENTIFIER_NODES,
        commentNodes: python.PYTHON_COMMENT_NODES,
        methodNodes: python.PYTHON_METHOD_NODES,
        typeNodes: python.PYTHON_TYPE_NODES,
        // One node type covers plain, triple-quoted, f- and b-strings. The
        // f-string is filtered out later by its `interpolation` child.
        stringNodes: new Set(['string']),
    },
    c: {
        isKeyword: c.isKeyword,
        identifierNodes: c.C_IDENTIFIER_NODES,
        commentNodes: c.C_COMMENT_NODES,
        methodNodes: c.C_METHOD_NODES,
        typeNodes: c.C_TYPE_NODES,
        stringNodes: C_STRING_NODES,
    },
    cpp: {
        isKeyword: cpp.isKeyword,
        identifierNodes: cpp.CPP_IDENTIFIER_NODES,
        commentNodes: cpp.CPP_COMMENT_NODES,
        methodNodes: cpp.CPP_METHOD_NODES,
        typeNodes: cpp.CPP_TYPE_NODES,
        stringNodes: new Set(['string_literal', 'raw_string_literal']),
    },
    java: {
        isKeyword: java.isKeyword,
        identifierNodes: java.JAVA_IDENTIFIER_NODES,
        commentNodes: java.JAVA_COMMENT_NODES,
        methodNodes: java.JAVA_METHOD_NODES,
        typeNodes: java.JAVA_TYPE_NODES,
        stringNodes: C_STRING_NODES,
    },
    go: {
        isKeyword: go.isKeyword,
        identifierNodes: go.GO_IDENTIFIER_NODES,
        commentNodes: go.GO_COMMENT_NODES,
        methodNodes: go.GO_METHOD_NODES,
        typeNodes: go.GO_TYPE_NODES,
        stringNodes: new Set(['interpreted_string_literal', 'raw_string_literal']),
    },
    php: {
        isKeyword: php.isKeyword,
        identifierNodes: php.PHP_IDENTIFIER_NODES,
        commentNodes: php.PHP_COMMENT_NODES,
        methodNodes: php.PHP_METHOD_NODES,
        typeNodes: php.PHP_TYPE_NODES,
        // `encapsed_string` is the double-quoted form; a "$var" inside it shows
        // up as a `variable_name` child and drops the whole literal.
        stringNodes: new Set(['string', 'encapsed_string']),
    },
    ruby: {
        isKeyword: ruby.isKeyword,
        identifierNodes: ruby.RUBY_IDENTIFIER_NODES,
        commentNodes: ruby.RUBY_COMMENT_NODES,
        methodNodes: ruby.RUBY_METHOD_NODES,
        typeNodes: ruby.RUBY_TYPE_NODES,
        stringNodes: new Set(['string']),
    },
    hcl: {
        isKeyword: hcl.isKeyword,
        identifierNodes: hcl.HCL_IDENTIFIER_NODES,
        commentNodes: hcl.HCL_COMMENT_NODES,
        methodNodes: hcl.HCL_METHOD_NODES,
        typeNodes: hcl.HCL_TYPE_NODES,
        propertyNodes: hcl.HCL_PROPERTY_NODES,
        // Block labels are already indexed as items by extractTypeInfo. Indexing
        // them again as literals is harmless: same term, same line, so the
        // occurrence collapses to kind 'both' instead of duplicating.
        stringNodes: new Set(['string_lit']),
    },
    kotlin: {
        isKeyword: kotlin.isKeyword,
        identifierNodes: kotlin.KOTLIN_IDENTIFIER_NODES,
        commentNodes: kotlin.KOTLIN_COMMENT_NODES,
        methodNodes: kotlin.KOTLIN_METHOD_NODES,
        typeNodes: kotlin.KOTLIN_TYPE_NODES,
        propertyNodes: kotlin.KOTLIN_PROPERTY_NODES,
        stringNodes: new Set(['string_literal', 'multiline_string_literal']),
    },
    swift: {
        isKeyword: swift.isKeyword,
        identifierNodes: swift.SWIFT_IDENTIFIER_NODES,
        commentNodes: swift.SWIFT_COMMENT_NODES,
        methodNodes: swift.SWIFT_METHOD_NODES,
        typeNodes: swift.SWIFT_TYPE_NODES,
        propertyNodes: swift.SWIFT_PROPERTY_NODES,
        stringNodes: new Set(['line_string_literal', 'multi_line_string_literal']),
    },
    astro: {
        // Astro frontmatter is TypeScript; reuse TypeScript config
        isKeyword: typescript.isKeyword,
        identifierNodes: typescript.TYPESCRIPT_IDENTIFIER_NODES,
        commentNodes: typescript.TYPESCRIPT_COMMENT_NODES,
        methodNodes: typescript.TYPESCRIPT_METHOD_NODES,
        typeNodes: typescript.TYPESCRIPT_TYPE_NODES,
        stringNodes: TS_STRING_NODES,
    },
};

/**
 * Get language configuration
 */
export function getLanguageConfig(language: SupportedLanguage): LanguageConfig {
    return configs[language];
}

/**
 * Check if a term is a keyword for the given language
 */
export function isKeyword(term: string, language: SupportedLanguage): boolean {
    return configs[language].isKeyword(term);
}
