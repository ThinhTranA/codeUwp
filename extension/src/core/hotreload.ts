import type { TapCommand, VisualTreeNode } from './tap';
import { isApplicationMarkup } from './tap';

/**
 * One element as it appears in a XAML source file. Lines are 1-based.
 *
 * Both ends of the opening tag are kept, because the live tree's `SourceInfo.LineNumber` is
 * neither reliably one nor the other — see `containsSourceLine`.
 */
export interface XamlElement {
    tag: string;
    /** Line the opening tag starts on. */
    line: number;
    /** Line the opening tag ends on. */
    endLine: number;
    attributes: Map<string, string>;
}

/**
 * Whether a live element's reported source line belongs to this element.
 *
 * `SourceInfo.LineNumber` points into the element's *opening tag*, and measurement shows it is
 * the last line of that tag as the XAML compiler saw it — which is not always the last line in
 * the file. `CounterText` in the sample spans lines 46-49 and reports 48, because its final
 * attribute is an `x:Bind` and compiled bindings are stripped before they reach the runtime.
 *
 * Matching by containment rather than by either endpoint absorbs all of that. Opening tags
 * cannot nest, so the spans are disjoint and a line belongs to at most one element.
 */
export function containsSourceLine(element: XamlElement, sourceLine: number): boolean {
    return sourceLine >= element.line && sourceLine <= element.endLine;
}

const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;

/**
 * Finds the element tags in a XAML document, with the line each starts on.
 *
 * A regex scanner rather than an XML parser, deliberately: this runs on every save, it must
 * tolerate the half-typed markup an editor produces between keystrokes, and it needs *line
 * numbers*, which most XML parsers discard. It only has to be right about well-formed opening
 * tags — anything it cannot make sense of simply yields no edit, and the loop falls back to a
 * rebuild.
 *
 * Comments and processing instructions are skipped so that markup inside them cannot be
 * mistaken for an element.
 */
export function parseXamlElements(text: string): XamlElement[] {
    const elements: XamlElement[] = [];
    // Line starts, so a character offset can be turned into a line number without rescanning.
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            lineStarts.push(i + 1);
        }
    }
    const lineOf = (offset: number): number => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (lineStarts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return low + 1;
    };

    let i = 0;
    while (i < text.length) {
        if (text.startsWith('<!--', i)) {
            const end = text.indexOf('-->', i);
            i = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text[i] !== '<' || text[i + 1] === '/' || text[i + 1] === '?' || text[i + 1] === '!') {
            i++;
            continue;
        }

        const tagMatch = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 200));
        if (!tagMatch) {
            i++;
            continue;
        }

        // The tag ends at the first '>' that is not inside an attribute value.
        let end = i + tagMatch[0].length;
        let inQuotes = false;
        while (end < text.length) {
            const ch = text[end];
            if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === '>' && !inQuotes) {
                break;
            }
            end++;
        }

        const body = text.slice(i, end);
        const attributes = new Map<string, string>();
        ATTRIBUTE.lastIndex = 0;
        let attribute: RegExpExecArray | null;
        while ((attribute = ATTRIBUTE.exec(body)) !== null) {
            attributes.set(attribute[1], attribute[2]);
        }

        elements.push({ tag: tagMatch[1], line: lineOf(i), endLine: lineOf(end), attributes });
        i = end + 1;
    }

    return elements;
}

/** A property change located by the element that declares it, in the baseline text. */
export interface XamlPropertyEdit {
    /** The baseline element's opening-tag span, used to find the live object. */
    line: number;
    endLine: number;
    tag: string;
    property: string;
    value: string;
}

export interface XamlDiff {
    edits: XamlPropertyEdit[];
    /**
     * Why the diff could not be reduced to edits, when it could not. A structural change needs
     * a rebuild, and saying so is better than applying a partial set and leaving the running
     * app in a state that matches neither version.
     */
    unsupported?: string;
}

/**
 * Reduces two versions of a XAML file to property edits.
 *
 * Deliberately conservative. Elements are matched by position, so if the two versions do not
 * have the same shape the diff gives up rather than guessing — adding or removing an element
 * shifts every subsequent match, and a confident wrong answer would write values into the
 * wrong objects.
 *
 * Line numbers come from the *baseline*, because that is what the running app was loaded from
 * and therefore what its `SourceInfo` reports. Using the new text's lines would miss by
 * however much the edit shifted them.
 */
export function diffXaml(baseline: string, updated: string): XamlDiff {
    const before = parseXamlElements(baseline);
    const after = parseXamlElements(updated);

    if (before.length !== after.length) {
        return {
            edits: [],
            unsupported: `element count changed (${before.length} -> ${after.length}); adding or removing elements needs a rebuild`
        };
    }

    const edits: XamlPropertyEdit[] = [];
    for (let i = 0; i < before.length; i++) {
        if (before[i].tag !== after[i].tag) {
            return {
                edits: [],
                unsupported: `element ${i} changed from ${before[i].tag} to ${after[i].tag}; a retyped element needs a rebuild`
            };
        }
        for (const [name, value] of after[i].attributes) {
            if (before[i].attributes.get(name) !== value) {
                edits.push({
                    line: before[i].line,
                    endLine: before[i].endLine,
                    tag: before[i].tag,
                    property: name,
                    value
                });
            }
        }
    }

    return { edits };
}

/** An edit that could not be aimed at a live element, and why. */
export interface UnresolvedEdit {
    edit: XamlPropertyEdit;
    reason: string;
}

export interface ResolvedEdits {
    commands: TapCommand[];
    unresolved: UnresolvedEdit[];
}

/**
 * Aims edits at live elements, using the source line each element reports.
 *
 * This is what `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1` is for. It works for unnamed elements
 * as well as named ones, which matters because most elements in real markup have no `x:Name`.
 */
export function resolveEdits(
    edits: XamlPropertyEdit[],
    tree: VisualTreeNode[],
    sourceFileName: string
): ResolvedEdits {
    const commands: TapCommand[] = [];
    const unresolved: UnresolvedEdit[] = [];

    const candidates = tree.filter(
        (node) =>
            isApplicationMarkup(node) &&
            node.sourceFile.toLowerCase().endsWith('/' + sourceFileName.toLowerCase())
    );

    for (const edit of edits) {
        // Containment, not equality: the reported line lands somewhere inside the opening tag,
        // and exactly where depends on what the XAML compiler kept.
        const matches = candidates.filter((node) =>
            containsSourceLine({ tag: edit.tag, line: edit.line, endLine: edit.endLine, attributes: new Map() }, node.sourceLine)
        );
        if (matches.length === 0) {
            unresolved.push({
                edit,
                reason: `no live element declared at ${sourceFileName}:${edit.line}-${edit.endLine}`
            });
            continue;
        }
        if (matches.length > 1) {
            // Two elements inside one opening-tag span should be impossible, so this means an
            // assumption has broken rather than an ambiguity to resolve by guessing.
            unresolved.push({
                edit,
                reason: `${matches.length} live elements fall in ${sourceFileName}:${edit.line}-${edit.endLine}`
            });
            continue;
        }

        // Attached and namespaced properties (Grid.Row, x:Name) are not settable this way:
        // the property chain names plain properties, and x:* are markup directives rather than
        // properties at all.
        if (edit.property.includes(':')) {
            unresolved.push({ edit, reason: `${edit.property} is a markup directive, not a property` });
            continue;
        }

        commands.push({
            op: 'SetProperty',
            handle: matches[0].handle,
            property: edit.property,
            // Left empty so the tap uses the property's current type, which it can read from
            // the live object and the source text cannot tell us.
            valueType: '',
            value: edit.value
        });
    }

    return { commands, unresolved };
}
