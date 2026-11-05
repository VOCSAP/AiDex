/**
 * Parser module exports
 */

export {
    extract,
    detectLanguage,
    isSupported,
    getSupportedExtensions,
    type ExtractionResult,
    type ExtractedItem,
    type ExtractedLine,
    type ExtractedMethod,
    type ExtractedType,
    type ExtractedEdge,
} from './extractor.js';

export { parse, parseFile, getParser, astroHasNoFrontmatterFence, type SupportedLanguage } from './tree-sitter.js';

export { getLanguageConfig, isKeyword } from './languages/index.js';
