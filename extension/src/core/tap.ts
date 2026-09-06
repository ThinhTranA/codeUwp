import * as fs from 'fs';
import * as path from 'path';

import { run } from './exec';

/** Must match CLSID_UwpToolsTap in native/XamlTap/XamlTap.cpp. */
export const TAP_CLSID = '2C7B1E44-9F3A-4D5E-B18C-6A0D5E7F2A91';

export const TAP_DLL_NAME = 'XamlTap.dll';

export interface TapReport {
    loaded: boolean;
    pid?: number;
    hasXamlDiagnostics: boolean;
    hasVisualTreeService: boolean;
    /** The interface carrying the hot-reload verbs: SetProperty, CreateInstance, ReplaceResource. */
    hasVisualTreeService3: boolean;
    raw: string;
}

export class TapError extends Error {
    constructor(message: string, readonly remedy?: string) {
        super(message);
        this.name = 'TapError';
    }
}

export function findTapDll(extensionRoot: string, platform = 'x64'): string | undefined {
    const candidates = [
        path.join(extensionRoot, 'bin', platform, TAP_DLL_NAME),
        path.join(extensionRoot, '..', 'native', 'XamlTap', 'bin', platform, TAP_DLL_NAME)
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Stages the tap somewhere the target's AppContainer can reach.
 *
 * The tap is loaded *inside* the sandbox, which can read neither Program Files nor an
 * arbitrary developer directory, and it reports back by writing a file — so the directory
 * needs to be both readable and writable by app containers. `uwplaunch inject` grants that;
 * this only has to put the DLL somewhere sensible and per-package.
 */
export function stageTap(tapDllPath: string, packageFamilyName: string): string {
    const workDir = path.join(
        process.env['LOCALAPPDATA'] ?? process.env['TEMP'] ?? '.',
        'Temp',
        'uwp-tools-tap',
        packageFamilyName
    );
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(tapDllPath, path.join(workDir, TAP_DLL_NAME));

    // A stale report from a previous session would be read as this session's answer.
    fs.rmSync(path.join(workDir, 'tap-report.txt'), { force: true });
    return workDir;
}

/**
 * Injects the tap into a running app and reads back what it found.
 *
 * The app must already have its XAML tree up; injecting earlier fails with ERROR_NOT_FOUND
 * (0x80070490) because the diagnostics endpoint does not exist yet. That is a timing problem,
 * not a configuration one, so callers should retry rather than give up.
 */
export async function injectTap(
    uwpLaunchPath: string,
    processId: number,
    workDir: string
): Promise<void> {
    const result = await run(
        uwpLaunchPath,
        [
            'inject',
            '--pid', String(processId),
            '--tap', path.join(workDir, TAP_DLL_NAME),
            '--clsid', TAP_CLSID,
            '--data', workDir
        ],
        { timeoutMs: 60_000 }
    );

    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
    let response: { ok?: boolean; error?: string };
    try {
        response = JSON.parse(line) as { ok?: boolean; error?: string };
    } catch {
        throw new TapError(`uwplaunch inject produced no usable output: ${result.stderr.trim() || line}`);
    }
    if (!response.ok) {
        throw new TapError(response.error ?? 'Injection failed.');
    }
}

/** One element of the live visual tree, as the tap saw it. */
export interface VisualTreeNode {
    handle: string;
    parent: string;
    childIndex: number;
    type: string;
    /** The element's `x:Name`, empty when it has none. */
    name: string;
    /**
     * The XAML file and line that declared this element.
     *
     * Only populated when `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1` was set at process start.
     * This is what lets an edit in a source file be aimed at a live element, so an empty value
     * here means hot reload cannot map markup to the tree.
     */
    sourceFile: string;
    sourceLine: number;
}

/**
 * Whether an element came from the application's own markup rather than a control template.
 *
 * The tree contains far more than the developer wrote: every control expands its template, so
 * a single `InfoBar` contributes a dozen elements from the framework's `generic.xaml`. Those
 * are not editable from the user's source and must not be addressed as if they were.
 *
 * The distinction is in the URI. The app's own markup is `ms-appx:///Page.xaml` — an empty
 * authority. A framework's is authority-qualified, `ms-appx://Microsoft.UI.Xaml.2.8/...`, and
 * built-in themes come from `ms-resource:`.
 *
 * This matters more than it sounds: the sample has two elements named `Title`, one ours and
 * one inside InfoBar's template. Addressing by name without this filter picks whichever came
 * first.
 */
export function isApplicationMarkup(node: VisualTreeNode): boolean {
    return node.sourceFile.startsWith('ms-appx:///');
}

function unescapeField(value: string): string {
    return value.replace(/\\(.)/g, (_, ch: string) =>
        ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === 'n' ? '\n' : ch
    );
}

/**
 * Reads the visual tree snapshot the tap wrote.
 *
 * Handles stay strings rather than becoming numbers: they are 64-bit values, and JavaScript
 * numbers would silently lose precision on a large one. Nothing here needs their magnitude,
 * only their identity.
 */
export function readVisualTree(workDir: string): VisualTreeNode[] | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(workDir, 'tree.tsv'), 'utf16le').replace(/^﻿/, '');
    } catch {
        return undefined;
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
        return undefined;
    }
    // First line is the header; a file with only a header is a real answer (an empty tree),
    // not a failure.
    return lines.slice(1).map((line) => {
        const [handle, parent, childIndex, type, name, sourceFile, sourceLine] = line.split('\t');
        return {
            handle: handle ?? '0',
            parent: parent ?? '0',
            childIndex: Number(childIndex ?? 0),
            type: unescapeField(type ?? ''),
            name: unescapeField(name ?? ''),
            sourceFile: unescapeField(sourceFile ?? ''),
            sourceLine: Number(sourceLine ?? 0)
        };
    });
}

/**
 * Builds the addressable path of an element, the way an edit will refer to it.
 *
 * Named elements are addressed by name; unnamed ones by type and position among same-type
 * siblings. A path built from the root survives the tree being rebuilt, which a raw handle
 * does not — and unnamed elements are the common case in real markup, so addressing by name
 * alone would leave most of a page unreachable.
 */
export function elementPath(nodes: VisualTreeNode[], node: VisualTreeNode): string {
    const byHandle = new Map(nodes.map((n) => [n.handle, n]));
    const segments: string[] = [];

    for (let current: VisualTreeNode | undefined = node; current; current = byHandle.get(current.parent)) {
        // A name roots the path only when it is unambiguous *within the app's own markup*.
        // Control templates reuse ordinary names — the sample has a second `Title` inside
        // InfoBar's template — so an unqualified name is not an address.
        const nameIsUnique =
            current.name !== '' &&
            nodes.filter((n) => n.name === current!.name && isApplicationMarkup(n)).length === 1;
        if (nameIsUnique && isApplicationMarkup(current)) {
            segments.unshift(`#${current.name}`);
            break;
        }
        const siblings = nodes.filter(
            (n) => n.parent === current!.parent && n.type === current!.type
        );
        const index = siblings.findIndex((n) => n.handle === current!.handle);
        segments.unshift(siblings.length > 1 ? `${current.type}[${Math.max(index, 0)}]` : current.type);
    }

    return segments.join('/');
}

/** Reads the tap's report, or undefined if it has not written one yet. */
export function readTapReport(workDir: string): TapReport | undefined {
    const file = path.join(workDir, 'tap-report.txt');
    let raw: string;
    try {
        // The tap writes UTF-16 with a BOM so neither side has to guess an encoding.
        raw = fs.readFileSync(file, 'utf16le').replace(/^﻿/, '');
    } catch {
        return undefined;
    }

    const field = (name: string): string | undefined =>
        new RegExp(`${name}\\s*=\\s*(.+)`).exec(raw)?.[1]?.trim();

    return {
        loaded: field('loaded') === 'yes',
        pid: Number(field('pid')) || undefined,
        hasXamlDiagnostics: field('IXamlDiagnostics') === 'OK',
        hasVisualTreeService: field('IVisualTreeService') === 'OK',
        hasVisualTreeService3: field('IVisualTreeService3') === 'OK',
        raw
    };
}
