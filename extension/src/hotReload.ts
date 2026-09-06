import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import { diffXaml, resolveEdits } from './core/hotreload';
import {
    findTapDll,
    injectTap,
    readVisualTree,
    sendCommands,
    stageTap,
    type VisualTreeNode
} from './core/tap';
import type { DeployResult } from './core/deploy';

/**
 * Keeps a running app's XAML in step with the editor.
 *
 * The session owns three things that have to stay consistent: the injected tap, the visual
 * tree snapshot that edits are aimed with, and a baseline copy of every XAML file as the app
 * was built from it. A diff is always taken against that baseline rather than the previous
 * save, because the live tree's source lines refer to the markup the app actually loaded.
 */
export class HotReloadSession implements vscode.Disposable {
    private readonly baselines = new Map<string, string>();
    private readonly watchers: vscode.Disposable[] = [];
    private tree: VisualTreeNode[] = [];
    private applying = false;

    private constructor(
        private readonly workDir: string,
        private readonly uwpLaunchPath: string,
        private readonly pid: number,
        private readonly projectDir: string,
        private readonly log: (message: string) => void
    ) { }

    /**
     * Injects the tap and starts watching. Returns undefined when the tap cannot be injected,
     * which usually means the app has not brought its XAML tree up yet.
     */
    static async start(
        extensionRoot: string,
        deployResult: DeployResult,
        uwpLaunchPath: string,
        pid: number,
        projectDir: string,
        log: (message: string) => void
    ): Promise<HotReloadSession | undefined> {
        const tapDll = findTapDll(extensionRoot);
        if (!tapDll) {
            log('hot reload: XamlTap.dll not found; build it with native/XamlTap/build.ps1');
            return undefined;
        }

        const workDir = stageTap(tapDll, deployResult.packageFamilyName);

        // Injecting before the app's tree exists fails with ERROR_NOT_FOUND. That is timing,
        // not configuration, so retry rather than report a problem.
        let injected = false;
        for (let attempt = 0; attempt < 15 && !injected; attempt++) {
            try {
                await injectTap(uwpLaunchPath, pid, workDir);
                injected = true;
            } catch (error) {
                if (attempt === 14) {
                    log(`hot reload: could not inject the tap: ${String(error)}`);
                    return undefined;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        const session = new HotReloadSession(workDir, uwpLaunchPath, pid, projectDir, log);
        await session.refreshTree();
        session.captureBaselines();
        session.watch();
        log(`hot reload: watching ${session.baselines.size} XAML file(s) for ${deployResult.packageFullName}`);
        return session;
    }

    private async refreshTree(): Promise<void> {
        for (let attempt = 0; attempt < 10; attempt++) {
            const tree = readVisualTree(this.workDir);
            if (tree && tree.length > 0) {
                this.tree = tree;
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        this.log('hot reload: the tap wrote no visual tree');
    }

    /**
     * Records each XAML file as it is on disk right now.
     *
     * "Right now" is correct only because the app was just built and launched from these
     * files. Capturing later, after the developer has already edited one, would diff a file
     * against itself and silently skip their first change.
     */
    private captureBaselines(): void {
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (!['bin', 'obj', 'AppPackages', '.vs'].includes(entry.name)) {
                        walk(path.join(dir, entry.name));
                    }
                } else if (entry.name.toLowerCase().endsWith('.xaml')) {
                    const full = path.join(dir, entry.name);
                    this.baselines.set(full.toLowerCase(), fs.readFileSync(full, 'utf8'));
                }
            }
        };
        walk(this.projectDir);
        this.log(
            `hot reload: baselines captured for ${[...this.baselines.keys()]
                .map((f) => path.basename(f))
                .join(', ')}`
        );
    }

    private watch(): void {
        this.watchers.push(
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (document.fileName.toLowerCase().endsWith('.xaml')) {
                    this.log(`hot reload: saw save of ${document.fileName}`);
                    void this.apply(document.fileName, document.getText());
                }
            })
        );
    }

    private async apply(file: string, updated: string): Promise<void> {
        // Every path out of this method logs. Silent returns here are indistinguishable from
        // "hot reload is broken" to anyone watching the app, and there are four reasons an
        // edit legitimately does nothing.
        const name = path.basename(file);
        const key = file.toLowerCase();
        const baseline = this.baselines.get(key);

        if (baseline === undefined) {
            this.log(
                `hot reload: ${name} saved, but it is not one of the ${this.baselines.size} file(s) `
                + `tracked under ${this.projectDir} — not part of this app?`
            );
            return;
        }
        if (this.applying) {
            this.log(`hot reload: ${name} saved while an apply was in flight; skipped`);
            return;
        }
        if (baseline === updated) {
            this.log(`hot reload: ${name} saved but matches the baseline; nothing to apply`);
            return;
        }

        const diff = diffXaml(baseline, updated);
        if (diff.unsupported) {
            this.log(`hot reload: ${path.basename(file)} needs a rebuild — ${diff.unsupported}`);
            void vscode.window.showInformationMessage(
                `XAML hot reload: ${diff.unsupported}. Re-run to see the change.`
            );
            return;
        }
        if (diff.edits.length === 0) {
            this.log(`hot reload: ${name} changed, but not in a way that maps to a property edit`);
            return;
        }
        this.log(
            `hot reload: ${name} — ${diff.edits.length} edit(s): `
            + diff.edits.map((e) => `${e.tag}:${e.line} ${e.property}`).join(', ')
        );

        const resolved = resolveEdits(diff.edits, this.tree, name);
        for (const problem of resolved.unresolved) {
            this.log(`hot reload: skipped ${problem.edit.property} — ${problem.reason}`);
        }
        if (resolved.commands.length === 0) {
            this.log(
                `hot reload: nothing could be aimed at a live element `
                + `(${this.tree.length} element(s) in the snapshot). If the app has navigated `
                + `since it started, run "UWP: Refresh XAML Hot Reload".`
            );
            return;
        }

        this.applying = true;
        try {
            const results = await sendCommands(this.workDir, resolved.commands);
            const failures = results.filter((r) => r.status !== 'OK');
            for (const failure of failures) {
                this.log(`hot reload: ${failure.property} failed — ${failure.status}`);
            }
            const applied = results.length - failures.length;
            this.log(`hot reload: applied ${applied}/${results.length} edit(s) to ${path.basename(file)}`);

            // The baseline moves whether or not every edit landed. Re-sending a failed edit on
            // the next save would replay it against a tree that may already have changed, and
            // the developer can see the failure in the log.
            this.baselines.set(key, updated);
        } catch (error) {
            this.log(`hot reload: ${String(error)}`);
        } finally {
            this.applying = false;
        }
    }

    /**
     * Re-reads the live tree after the app's UI has changed structurally.
     *
     * Handles are only valid for the objects that existed when the snapshot was taken, so
     * navigating to another page, or anything that rebuilds the tree, leaves every recorded
     * handle pointing at nothing. Re-injecting replays the tree as it is now.
     */
    async refresh(): Promise<void> {
        try {
            await injectTap(this.uwpLaunchPath, this.pid, this.workDir);
            await this.refreshTree();
            this.log(`hot reload: refreshed, ${this.tree.length} live element(s)`);
        } catch (error) {
            this.log(`hot reload: refresh failed: ${String(error)}`);
        }
    }

    dispose(): void {
        for (const watcher of this.watchers) {
            watcher.dispose();
        }
        this.watchers.length = 0;
    }
}
