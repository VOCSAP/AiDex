/**
 * Shared CLI "Warnings" block for a per-file errors[] array -- bfb7bf8f.
 *
 * Extracted out of src/index.ts because the `init` and `rebuild-index` CLI
 * branches carried this block character-for-character identical (only their
 * surrounding comments differed): both call init() under the hood and both
 * print its errors[] even when the run reports success:true, so a partially
 * failed run never again hides its diagnostic behind a "Done!" and a
 * silently-reduced Files count (the exact gap fixed for init() alone in
 * 16d8512, then extended to rebuild-index in bfb7bf8f).
 *
 * Lives outside src/index.ts specifically so it can be unit-tested directly:
 * src/index.ts is a CLI entry point whose module-level `main().catch(...)`
 * runs unconditionally on import, which would make importing it from a test
 * fire off the CLI itself. This module has no such side effect.
 */
export function printIndexWarnings(errors: string[]): void {
    if (errors.length === 0) return;
    console.log(`  Warnings: ${errors.length} file(s) reported errors during indexing`);
    for (const e of errors.slice(0, 10)) console.log(`    - ${e}`);
    if (errors.length > 10) console.log(`    ... and ${errors.length - 10} more`);
}
