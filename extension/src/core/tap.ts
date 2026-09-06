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
