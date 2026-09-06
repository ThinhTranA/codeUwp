import * as vscode from 'vscode';

import type { UwpProject } from './core/projects';

export interface UwpTaskDefinition extends vscode.TaskDefinition {
    type: 'uwp';
    task: 'build' | 'rebuild' | 'clean';
    project?: string;
    configuration?: string;
    platform?: string;
}

const TARGETS: Record<UwpTaskDefinition['task'], string> = {
    build: 'Build',
    rebuild: 'Rebuild',
    clean: 'Clean'
};

/**
 * Builds the MSBuild command line for a UWP inner-loop build.
 *
 * `AppxBundle=Never` and `AppxPackageSigningEnabled=false` are not optimisations, they are
 * what keeps the loop fast: bundling and signing are for producing something to ship, and
 * neither is needed to run the app locally.
 */
export function buildArgs(
    project: UwpProject,
    task: UwpTaskDefinition['task'],
    verbosity: string
): string[] {
    return [
        project.projectPath,
        `-t:${TARGETS[task]}`,
        `-p:Configuration=${project.configuration}`,
        `-p:Platform=${project.platform}`,
        '-p:AppxBundle=Never',
        '-p:UapAppxPackageBuildMode=SideloadOnly',
        '-p:AppxPackageSigningEnabled=false',
        `-v:${verbosity}`,
        '-nologo'
    ];
}

export class UwpTaskProvider implements vscode.TaskProvider {
    static readonly type = 'uwp';

    constructor(
        private readonly resolveProject: () => UwpProject | undefined,
        private readonly resolveMsBuild: () => string | undefined
    ) { }

    provideTasks(): vscode.Task[] {
        const project = this.resolveProject();
        const msbuild = this.resolveMsBuild();
        if (!project || !msbuild) {
            return [];
        }
        return (['build', 'rebuild', 'clean'] as const).map((task) =>
            this.makeTask({ type: 'uwp', task }, project, msbuild)
        );
    }

    resolveTask(task: vscode.Task): vscode.Task | undefined {
        const definition = task.definition as UwpTaskDefinition;
        const project = this.resolveProject();
        const msbuild = this.resolveMsBuild();
        if (!definition.task || !project || !msbuild) {
            return undefined;
        }

        // A task in tasks.json may pin its own configuration; honour it over the active one.
        const effective: UwpProject = {
            ...project,
            configuration: definition.configuration ?? project.configuration,
            platform: definition.platform ?? project.platform,
            projectPath: definition.project ?? project.projectPath
        };
        return this.makeTask(definition, effective, msbuild);
    }

    private makeTask(
        definition: UwpTaskDefinition,
        project: UwpProject,
        msbuild: string
    ): vscode.Task {
        const verbosity = vscode.workspace
            .getConfiguration('uwp')
            .get<string>('buildVerbosity', 'minimal');

        const task = new vscode.Task(
            definition,
            vscode.TaskScope.Workspace,
            `${definition.task} ${project.name} (${project.configuration}|${project.platform})`,
            'uwp',
            new vscode.ProcessExecution(msbuild, buildArgs(project, definition.task, verbosity)),
            ['$uwp-msbuild', '$uwp-msbuild-noline']
        );
        task.group =
            definition.task === 'clean' ? vscode.TaskGroup.Clean : vscode.TaskGroup.Build;
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
            clear: true
        };
        return task;
    }
}
