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
// Names that must not be pulled out of an object by destructuring.
const FRAME_HANDLE_BINDINGS: ReadonlySet<string | null> = new Set(['frame', 'initiator', 'send']);
const SEND_METHODS: ReadonlySet<string | null> = new Set(['send', 'postMessage', 'sendToFrame', 'reply']);
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

// `a!` and the `?.` chain around a call or member evaluate to what they wrap.
const unwrap = (node: Node): Node => {
    let current = node;
    while (current.type === 'ChainExpression' || current.type === 'TSNonNullExpression') {
        current = current.expression as Node;
    }
    return current;
};

const isWebContents = (receiver: Node): boolean => {
    const node = unwrap(receiver);
    if (node.type === 'Identifier') return node.name === 'webContents';
    return node.type === 'MemberExpression' && staticName(node.property, node.computed) === 'webContents';
};

const memberName = (node: Node): string | null => staticName(node.property, node.computed);

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
                let sender = callee;
                // `x.send.call(y, …)` sends on `y`, but is still a send off `x`.
                const inner = unwrap(callee.object as Node);
                if (FUNCTION_METHODS.has(memberName(callee)) && inner.type === 'MemberExpression') sender = inner;
                const method = memberName(sender);
                if (SEND_METHODS.has(method) && !isWebContents(sender.object as Node)) {
                    context.report({
                        node,
                        message: `\`${method}\` off anything but webContents reaches a window unfiltered.`,
                    });
                }
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
