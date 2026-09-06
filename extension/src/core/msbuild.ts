import { run } from './exec';

export interface EvaluationRequest {
    msbuildPath: string;
    projectPath: string;
    properties: string[];
    items?: string[];
    /** Global properties, e.g. Configuration and Platform. UWP evaluates differently without them. */
    globals?: Record<string, string>;
}

export interface EvaluationResult {
    properties: Record<string, string>;
    items: Record<string, MsBuildItem[]>;
    /** Populated when evaluation failed; the properties/items maps are then empty. */
    error?: string;
}

export interface MsBuildItem {
    Identity: string;
    FullPath?: string;
    [metadata: string]: string | undefined;
}

interface RawOutput {
    Properties?: Record<string, string>;
    Items?: Record<string, MsBuildItem[]>;
}

/**
 * Reads properties and items out of a project by asking MSBuild to evaluate it.
 *
 * This is deliberately not XML parsing. A UWP csproj's real values come from imported
 * targets, `Directory.Build.props`, and conditions on Configuration/Platform, none of which
 * are visible in the file itself — hand-parsing produces answers that are right for simple
 * projects and quietly wrong for real ones.
 *
 * Requires MSBuild 17.8 or later for `-getProperty` / `-getItem`.
 */
export async function evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const args = [request.projectPath, '-nologo'];

    if (request.properties.length > 0) {
        args.push(`-getProperty:${request.properties.join(',')}`);
    }
    if (request.items && request.items.length > 0) {
        args.push(`-getItem:${request.items.join(',')}`);
    }
    for (const [key, value] of Object.entries(request.globals ?? {})) {
        args.push(`-p:${key}=${value}`);
    }

    const result = await run(request.msbuildPath, args);
    const text = result.stdout.trim();

    if (!text) {
        return {
            properties: {},
            items: {},
            error: result.stderr.trim() || `MSBuild exited with code ${result.exitCode} and no output.`
        };
    }

    // A project that fails to evaluate (a missing import, say) prints diagnostics rather than
    // JSON. Report that text: it names the actual problem, where a parse error would not.
    let parsed: RawOutput;
    try {
        parsed = JSON.parse(text) as RawOutput;
    } catch {
        return { properties: {}, items: {}, error: firstMeaningfulLine(text) };
    }

    return { properties: parsed.Properties ?? {}, items: parsed.Items ?? {} };
}

function firstMeaningfulLine(text: string): string {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const error = lines.find((line) => /error\s+[A-Z]+\d+/i.test(line));
    return error ?? lines[0] ?? 'MSBuild produced unparseable output.';
}
