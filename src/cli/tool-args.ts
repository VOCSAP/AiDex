/**
 * CLI flags derived from the inputSchema of the MCP tool a subcommand replaces,
 * so the subcommand accepts exactly the tool's parameters.
 *
 * Property `store_bodies` becomes `--store-bodies`. Booleans: `--flag` or
 * `--flag=true|false`. Numbers and strings: `--flag value` or `--flag=value`;
 * the spaced form refuses a value starting with `--`, which is more likely a
 * forgotten value than a real one. String arrays: the flag repeated once per
 * item, because a glob may contain a comma. Positional properties are given in
 * order, without a flag.
 */

import { PRODUCT_NAME_LOWER } from '../constants.js';

export interface SchemaProperty {
    type?: string;
    items?: { type?: string };
    enum?: unknown[];
    description?: string;
}

export interface ToolInputSchema {
    properties?: Record<string, SchemaProperty>;
    required?: string[];
}

export type ParseResult =
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; error: string };

export function flagName(property: string): string {
    return `--${property.replace(/_/g, '-')}`;
}

function scalar(spec: { type?: string; enum?: unknown[] }, raw: string, flag: string): { value?: unknown; error?: string } {
    let value: unknown = raw;
    if (spec.type === 'number') {
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n)) return { error: `${flag} expects a number, got "${raw}"` };
        value = n;
    } else if (spec.type !== 'string') {
        return { error: `${flag} has a schema type the CLI cannot read (${spec.type})` };
    }
    if (spec.enum && !spec.enum.includes(value)) {
        return { error: `${flag} must be one of: ${spec.enum.join(', ')}` };
    }
    return { value };
}

export function parseToolArgs(schema: ToolInputSchema, argv: string[], positional: string[] = []): ParseResult {
    const props = schema.properties ?? {};
    const byFlag = new Map(
        Object.keys(props).filter((p) => !positional.includes(p)).map((p) => [flagName(p), p])
    );
    const args: Record<string, unknown> = {};
    const positionals: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }
        const eq = token.indexOf('=');
        const flag = eq === -1 ? token : token.slice(0, eq);
        const inline = eq === -1 ? undefined : token.slice(eq + 1);
        const property = byFlag.get(flag);
        if (!property) return { ok: false, error: `unknown option ${flag}` };
        const spec = props[property];

        if (spec.type === 'boolean') {
            if (property in args) return { ok: false, error: `${flag} given twice` };
            if (inline === undefined || inline === 'true') args[property] = true;
            else if (inline === 'false') args[property] = false;
            else return { ok: false, error: `${flag} expects true or false, got "${inline}"` };
            continue;
        }

        let raw = inline;
        if (raw === undefined) {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                return { ok: false, error: `${flag} needs a value (use ${flag}=<value> for a value starting with --)` };
            }
            raw = next;
            i++;
        }

        if (spec.type === 'array') {
            const item = scalar(spec.items ?? {}, raw, flag);
            if (item.error) return { ok: false, error: item.error };
            const list = (args[property] as unknown[] | undefined) ?? [];
            list.push(item.value);
            args[property] = list;
            continue;
        }

        if (property in args) return { ok: false, error: `${flag} given twice` };
        const one = scalar(spec, raw, flag);
        if (one.error) return { ok: false, error: one.error };
        args[property] = one.value;
    }

    if (positionals.length > positional.length) {
        return { ok: false, error: `unexpected argument "${positionals[positional.length]}"` };
    }
    positional.forEach((p, k) => {
        if (positionals[k] !== undefined) args[p] = positionals[k];
    });
    for (const required of schema.required ?? []) {
        if (args[required] === undefined) {
            const name = positional.includes(required) ? `<${required}>` : flagName(required);
            return { ok: false, error: `missing ${name}` };
        }
    }
    return { ok: true, args };
}

export function toolUsage(subcommand: string, schema: ToolInputSchema, positional: string[] = []): string {
    const props = schema.properties ?? {};
    const head = [`Usage: ${PRODUCT_NAME_LOWER} ${subcommand}`, ...positional.map((p) => `<${p}>`), '[options]'].join(' ');
    const lines = Object.entries(props)
        .filter(([p]) => !positional.includes(p))
        .map(([p, spec]) => {
            const value = spec.type === 'boolean' ? '' : spec.type === 'array' ? ' <value> (repeatable)' : ` <${spec.type}>`;
            return `  ${flagName(p)}${value}${spec.description ? `  ${spec.description}` : ''}`;
        });
    return [head, ...lines].join('\n');
}
