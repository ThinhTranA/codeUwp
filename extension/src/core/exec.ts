import { execFile } from 'child_process';

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Runs a program and captures its output. Never rejects on a non-zero exit: the tools this
 * extension shells out to use exit codes as answers (vswhere finds nothing, MSBuild reports
 * a build failure), and treating those as exceptions turns ordinary results into control flow.
 */
export function run(
    file: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number } = {}
): Promise<ExecResult> {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            {
                cwd: options.cwd,
                timeout: options.timeoutMs ?? 120_000,
                // MSBuild's -getProperty output on a large project comfortably exceeds the
                // 1 MB default, and truncation shows up as a JSON parse error a long way
                // from its cause.
                maxBuffer: 64 * 1024 * 1024,
                windowsHide: true
            },
            (error, stdout, stderr) => {
                const exitCode =
                    error && typeof (error as { code?: unknown }).code === 'number'
                        ? ((error as unknown as { code: number }).code)
                        : error
                            ? 1
                            : 0;
                resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
            }
        );
    });
}
