/**
 * Oxlint JS plugin: keeps every send toward a window behind the Logs-channel filter.
 *
 * `no-unfiltered-frame-send` — restrictToLogsChannels (ipc/registerHandlers.ts) filters
 * only `webContents.send`. `postMessage`, a frame's `send`, an event's `reply` and a
 * `webFrameMain` handle reach a window unfiltered, so no source may obtain a frame
 * handle or send on anything but `webContents`. The rule reads the AST, so a binding
 * form (a destructuring default, a `for…of` pattern, `frame.send.call(…)`) is caught
 * and a string or comment that merely holds the word is not.
 *
 * Loaded through `jsPlugins` in .oxlintrc.json; the rule API is ESLint's.
 */

// The slice of the ESTree AST this rule reads.
interface Node {
    type: string;
    parent?: Node;
    name?: string;
    value?: unknown;
    computed?: boolean;
    object?: Node;
    property?: Node;
    callee?: Node;
    arguments?: Node[];
    expression?: Node;
    key?: Node;
    properties?: Node[];
    expressions?: Node[];
    quasis?: Quasi[];
}
interface Quasi {
    value: { cooked: string };
}
interface RuleContext {
    report(descriptor: { node: Node; message: string }): void;
}

// Properties that hand out a frame (or the window that opened this one).
const FRAME_HANDLE_PROPERTIES: ReadonlySet<string | null> = new Set([
    'frame',
    'initiator',
    'mainFrame',
    'senderFrame',
    'framesInSubtree',
    'focusedFrame',
    'opener',
]);
const SEND_METHODS: ReadonlySet<string | null> = new Set(['send', 'postMessage', 'sendToFrame', 'reply']);
// Names that must not be pulled out of an object by destructuring.
const FRAME_HANDLE_BINDINGS: ReadonlySet<string | null> = new Set(['frame', 'initiator', ...SEND_METHODS]);
// Global functions that post to a window without a receiver.
const BARE_SEND_FUNCTIONS: ReadonlySet<string | null> = new Set(['postMessage', 'sendToFrame']);
// `fn.call(…)`, `fn.apply(…)`, `fn.bind(…)` invoke or capture `fn` with another receiver.
const FUNCTION_METHODS: ReadonlySet<string | null> = new Set(['call', 'apply', 'bind']);
const LISTENER_METHODS: ReadonlySet<string | null> = new Set(['on', 'once']);

// A member or key name the source spells out: `x.name`, `x['name']`, `` x[`name`] ``.
// Typed to take a missing node: a lookup of one just misses.
const staticName = (node: Node | undefined, computed = false): string | null => {
    if (node === undefined) return null;
    if (node.type === 'Identifier' && !computed) return node.name as string;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    // Without a tag, a template's cooked text is always a string.
    if (node.type === 'TemplateLiteral' && (node.expressions as Node[]).length === 0) {
        return (node.quasis as Quasi[])[0].value.cooked;
    }
    return null;
};

const memberName = (node: Node): string | null => staticName(node.property, node.computed);

// Wrappers that evaluate to the expression inside: `a!`, `a as T`, `a satisfies T`, `<T>a`, `(a)`, a `?.` chain.
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
    'ChainExpression',
    'TSNonNullExpression',
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'ParenthesizedExpression',
]);

// The expression a node evaluates to: wrappers stripped, a sequence reduced to its last expression.
const unwrap = (node: Node): Node => {
    let current = node;
    for (;;) {
        if (TRANSPARENT_WRAPPERS.has(current.type)) current = current.expression as Node;
        else if (current.type === 'SequenceExpression') current = (current.expressions as Node[]).at(-1) as Node;
        else return current;
    }
};

// Whether `parent` passes `child`'s value through unchanged (the mirror of `unwrap`).
const passesThrough = (parent: Node, child: Node): boolean =>
    TRANSPARENT_WRAPPERS.has(parent.type) ||
    (parent.type === 'SequenceExpression' && (parent.expressions as Node[]).at(-1) === child);

// The outermost wrapper around `node` and the first real parent above it.
const enclosing = (node: Node): { top: Node; parent: Node | undefined } => {
    let top = node;
    while (top.parent !== undefined && passesThrough(top.parent, top)) top = top.parent;
    return { top, parent: top.parent };
};

const isWebContents = (receiver: Node): boolean => {
    const node = unwrap(receiver);
    if (node.type === 'Identifier') return node.name === 'webContents';
    return node.type === 'MemberExpression' && staticName(node.property, node.computed) === 'webContents';
};

// Whether two expressions are the same name or property path (`a.webContents` and `a['webContents']`).
const sameReference = (left: Node, right: Node): boolean => {
    const a = unwrap(left);
    const b = unwrap(right);
    if (a.type !== b.type) return false;
    if (a.type === 'Identifier') return a.name === b.name;
    if (a.type === 'ThisExpression') return true;
    if (a.type !== 'MemberExpression') return false;
    const name = memberName(a);
    return name !== null && name === memberName(b) && sameReference(a.object as Node, b.object as Node);
};

// Whether a `send` on a webContents stays on that webContents: `.call/.apply/.bind` on it must name the same
// webContents as the receiver (`a.webContents.send.call(a.webContents, …)`), or the filter on one window's `send`
// would carry a message to another window.
const keepsReceiver = (send: Node): boolean => {
    const first = enclosing(send);
    if (first.parent?.type !== 'MemberExpression' || first.parent.object !== first.top) return true;
    if (!FUNCTION_METHODS.has(memberName(first.parent))) return true;
    const second = enclosing(first.parent);
    if (second.parent?.type !== 'CallExpression' || second.parent.callee !== second.top) return true;
    const [receiver] = second.parent.arguments as Node[];
    return receiver !== undefined && sameReference(receiver, send.object as Node);
};

const noUnfilteredFrameSend = {
    meta: {
        type: 'problem',
        docs: { description: 'Forbid frame handles and sends that bypass restrictToLogsChannels' },
    },
    create(context: RuleContext) {
        return {
            MemberExpression(node: Node) {
                const name = memberName(node);
                // A non-computed `.webFrameMain` is an Identifier, reported below.
                if (FRAME_HANDLE_PROPERTIES.has(name) || (node.computed && name === 'webFrameMain')) {
                    context.report({ node, message: `Reading \`${name}\` hands out a frame handle.` });
                }
                if (!SEND_METHODS.has(name)) return;
                // The one send the filter covers is `send` on a webContents, invoked on that same webContents.
                if (name === 'send' && isWebContents(node.object as Node) && keepsReceiver(node)) return;
                context.report({
                    node,
                    message: isWebContents(node.object as Node)
                        ? `\`${name}\` on webContents is not filtered: only \`send\` is, and only called on that webContents.`
                        : `\`${name}\` off anything but webContents reaches a window unfiltered.`,
                });
            },
            ObjectPattern(node: Node) {
                for (const property of node.properties as Node[]) {
                    const name = staticName(property.key, property.computed);
                    if (FRAME_HANDLE_BINDINGS.has(name)) {
                        context.report({ node: property, message: `Destructuring \`${name}\` binds a frame handle.` });
                    }
                }
            },
            Identifier(node: Node) {
                if (node.name === 'webFrameMain') {
                    context.report({ node, message: '`webFrameMain` hands out a frame handle.' });
                }
            },
            CallExpression(node: Node) {
                const callee = unwrap(node.callee as Node);
                if (callee.type === 'Identifier') {
                    if (BARE_SEND_FUNCTIONS.has(callee.name as string)) {
                        context.report({ node, message: `\`${callee.name}\` reaches a window unfiltered.` });
                    }
                    return;
                }
                if (callee.type !== 'MemberExpression') return;
                const [event] = node.arguments as Node[];
                if (LISTENER_METHODS.has(memberName(callee)) && staticName(event) === 'frame-created') {
                    context.report({ node, message: 'The `frame-created` event hands out frame handles.' });
                }
            },
        };
    },
};

export default {
    meta: { name: 'frame-guard' },
    rules: { 'no-unfiltered-frame-send': noUnfilteredFrameSend },
};
