import { run, type ExecResult } from './exec';

/**
 * Runs a PowerShell command.
 *
 * The app-model surface — `Add-AppxPackage`, `Get-AppxPackage`, `Remove-AppxPackage` — has no
 * command-line equivalent and no Node binding, so package registration necessarily goes
 * through PowerShell. `-NoProfile` matters: a user profile that writes to stdout corrupts
 * every JSON response, and a slow one is paid on every call.
 */
export async function powershell(script: string, timeoutMs = 300_000): Promise<ExecResult> {
    return run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeoutMs }
    );
}

/**
 * Runs a PowerShell command whose last statement emits an object, and parses it as JSON.
 *
 * `ConvertTo-Json` collapses a single-element array to a bare object, so callers asking for a
 * list get an object back when exactly one thing matched — a difference that only shows up
 * once real data has more than one row. Normalising here means callers never have to care.
 */
export async function powershellJson<T>(script: string, timeoutMs = 300_000): Promise<T[]> {
    const result = await powershell(
        `$ErrorActionPreference='Stop'; ${script} | ConvertTo-Json -Depth 6 -Compress`,
        timeoutMs
    );
    const text = result.stdout.trim();
    if (!text) {
        return [];
    }
    try {
        const parsed = JSON.parse(text) as T | T[];
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        return [];
    }
}

/** Quotes a path for embedding in a single-quoted PowerShell string literal. */
export function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
