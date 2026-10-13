/**
 * scripts/lint/frame-guard.mts — the Oxlint JS plugin rule that keeps every send toward a window behind
 * restrictToLogsChannels. Each snippet is parsed into an ESTree (Prettier's TypeScript parser) and the rule's visitors
 * run over it in-process; one more test hands the same snippets to the real Oxlint, so the AST shapes the rule assumes
 * are the ones Oxlint produces.
 */
import type frameGuardPlugin from '../../scripts/lint/frame-guard.mts';
import { isPlainObject } from '../../src/ts/plainObject';
import { invalid } from '../helpers/invalid';

const plugin: typeof frameGuardPlugin = (
    require('../../scripts/lint/frame-guard') as { default: typeof frameGuardPlugin }
).default;
const typescript = require('prettier/plugins/typescript') as typeof import('prettier/plugins/typescript');
const rule = plugin.rules['no-unfiltered-frame-send'];

type Visitors = ReturnType<typeof rule.create>;
type Node = Parameters<Visitors['Identifier']>[0];
interface Report {
    message: string;
    line: number;
}

const parse = (code: string): unknown => typescript.parsers.typescript.parse(code, invalid({}));

// Every node of the tree, in document order, under the visitor that matches its type. Each node gets a `parent`
// link, as the AST Oxlint hands the rule has.
const walk = (
    value: unknown,
    visitors: Readonly<Record<string, ((node: Node) => void) | undefined>>,
    parent?: unknown,
): void => {
    if (Array.isArray(value)) {
        for (const child of value) walk(child, visitors, parent);
        return;
    }
    if (!isPlainObject(value)) return;
    const isNode = typeof value.type === 'string';
    if (isNode) {
        Object.defineProperty(value, 'parent', { value: parent, enumerable: false });
        visitors[value.type as string]?.(invalid<Node>(value));
    }
    for (const [key, child] of Object.entries(value)) {
        if (key !== 'loc' && key !== 'range') walk(child, visitors, isNode ? value : parent);
    }
};

const reportsFor = (code: string): Report[] => {
    const reports: Report[] = [];
    const context = {
        report: ({ node, message }: { node: Node; message: string }) => {
            reports.push({ message, line: invalid<{ loc: { start: { line: number } } }>(node).loc.start.line });
        },
    };
    walk(parse(code), rule.create(context));
    return reports;
};

// Each distinct message, once, sorted: the same text can be reached through more than one node (a shorthand key and
// its value, an import's imported and local names).
const messagesFor = (code: string): string[] => [...new Set(reportsFor(code).map(({ message }) => message))].sort();

const read = (name: string) => `Reading \`${name}\` hands out a frame handle.`;
const destructure = (name: string) => `Destructuring \`${name}\` binds a frame handle.`;
const bindsSend = (name: string) =>
    `Destructuring \`${name}\` binds a send method that bypasses the Logs-window filter.`;
const send = (method: string) => `\`${method}\` off anything but webContents reaches a window unfiltered.`;
const unfiltered = (method: string) =>
    `\`${method}\` on webContents is not filtered: only \`send\` is, and only called on that webContents.`;
const bare = (name: string) => `\`${name}\` reaches a window unfiltered.`;
const REWRITES_SEND = '`send` on webContents is replaced or removed: that undoes the Logs-channel filter.';
const WEB_FRAME_MAIN = '`webFrameMain` hands out a frame handle.';
const FRAME_CREATED = 'The `frame-created` event hands out frame handles.';

// Words that only look like a frame handle, the filtered path, and calls that are not sends.
const VALID: readonly string[] = [
    "const o = { reason: 'frame gone' };",
    "const o = ok ? { label: 'frame' } : null;",
    "const keys = ['frame'];",
    'const s = `${x} frame`;',
    'const s = `frame`;',
    'const id = details.frameId;',
    'const o = event.initiatorOrigin;',
    'const s = "iframe-created";',
    'const o = { frame: 1, initiator: 2, send: 3 };',
    'const frame = 1; log(frame);',
    '// const { frame } = details; frame.send(x); mainFrame',
    '/* webFrameMain senderFrame */ const a = 1;',
    "window.open(url, '_blank', 'noopener');",
    'const openerCount = 1;',
    'const postMessageCount = 1;',
    'const { a, ...rest } = x;',
    'const { [key]: value } = x;',
    'const { [`a${b}`]: value } = x;',
    'const { [`other`]: value } = x;',
    'const { [4]: value } = x;',
    'const { a = { frame } } = x;',
    'win.webContents.send("c", x);',
    'win.webContents?.send("c", x);',
    'wc?.webContents?.send("c", x);',
    'webContents.send("c", x);',
    'win!.webContents!.send("c", x);',
    'win["webContents"].send("c", x);',
    'win.webContents.send.call(win.webContents, "c", x);',
    'win.webContents.send.bind(win.webContents);',
    'a.webContents.send.call(a.webContents, "c", x);',
    'a.webContents.send.apply(a.webContents, ["c"]);',
    'a.webContents?.send?.call(a.webContents, "c");',
    'a["webContents"].send.call(a.webContents, "c");',
    'this.webContents.send.call(this.webContents, "c");',
    '(win.webContents.send as Send)("c", x);',
    '(0, win.webContents.send)("c", x);',
    '(win.webContents as WC).send("c", x);',
    'const send = win.webContents.send;',
    'a.webContents.send.name;',
    'const send = webContents.send;',
    'delete win.webContents.other;',
    'typeof win.webContents.send;',
    'win.webContents.other = 1;',
    "Object.defineProperty(win.webContents, 'other', { value: 1 });",
    "Object.defineProperty(win.other, 'send', { value: 1 });",
    'Object.defineProperty(win.webContents);',
    'Object.assign(win.other, { send: 1 });',
    'Object.assign(win.webContents);',
    'Object.assign(win.webContents, source);',
    'Object.assign(win.webContents, { other: 1 }, { ...rest });',
    'Object.assign(win.webContents, { [key]: 1 });',
    'Object.defineProperties(win.other, { send: { value: 1 } });',
    'Object.defineProperties(win.webContents, { other: { value: 1 } });',
    'Object.defineProperties(win.webContents, descriptors);',
    'const { a: mainFrame2, b: senderFrameCount } = x;',
    "Reflect.has(win.webContents, 'send');",
    "Other.defineProperty(win.webContents, 'send', x);",
    "obj[name](win.webContents, 'send');",
    "(Object.defineProperty)(win.webContents, 'other', x);",
    'a.webContents.send.call;',
    'const o = { send: 1, reply: 2, postMessage: 3 };',
    'const sendCount = x.sendCount; const replyTo = x.replyTo;',
    '(wc?.webContents)?.send("c", x);',
    'list.push(x);',
    'fn.call(this, x);',
    'a.b.call(this, x);',
    'a.on("did-finish-load", cb);',
    'a.on();',
    'a.once(name, cb);',
    'a.on("frame-created" + suffix, cb);',
    'a.emit("frame-created", x);',
    'a[name](x);',
    'a[`name`](x);',
    'class A extends B { constructor() { super(x); } }',
    'make()();',
];

// Each way a frame handle is read or a send skips the filter, with the messages the rule gives for it.
const INVALID: ReadonlyArray<readonly [string, ...string[]]> = [
    // Frame-handle reads, any receiver, optional chaining and computed access included.
    ['const frame = win.webContents.mainFrame;', read('mainFrame')],
    ['const frame = event.senderFrame;', read('senderFrame')],
    ['const all = frame.framesInSubtree;', read('framesInSubtree')],
    ['const frame = win.webContents.focusedFrame;', read('focusedFrame')],
    ['const parent = window.opener;', read('opener')],
    ['const f = details?.frame;', read('frame')],
    ['const f = details.initiator;', read('initiator')],
    ['const h = (e) => e.frame;', read('frame')],
    ["const f = details['frame'];", read('frame')],
    ['const i = details?.["initiator"];', read('initiator')],
    ['const f = details[`frame`];', read('frame')],
    ['const f = details!.frame;', read('frame')],
    ['const f = event.sender?.mainFrame;', read('mainFrame')],
    // Destructuring: every position a pattern can sit in, every spelling of the key.
    ['const { frame } = details;', destructure('frame')],
    ['const { frame = null } = details;', destructure('frame')],
    ['const { frame: f } = details;', destructure('frame')],
    ['const { initiator, ...rest } = details;', destructure('initiator')],
    ["const { 'frame': f } = details;", destructure('frame')],
    ["const { ['frame']: f } = details;", destructure('frame')],
    ['const { send } = frame;', bindsSend('send')],
    ['const {\n    a,\n    frame = null,\n} = d;', destructure('frame')],
    ['const {\n    a,\n    initiator,\n}: D = d;', destructure('initiator')],
    ['const { a: { frame } } = x;', destructure('frame')],
    ['for (const { frame } of list) use(frame);', destructure('frame')],
    ['for (const { frame } in list) use(frame);', destructure('frame')],
    ['try { go(); } catch ({ initiator }) { use(initiator); }', destructure('initiator')],
    ['({ frame } = details);', destructure('frame')],
    ['const g = ({ frame, initiator }) => 1;', destructure('frame'), destructure('initiator')],
    ['function f({ initiator }) {}', destructure('initiator')],
    ['on(({ frame }, x) => x);', destructure('frame')],
    ['function h(e: Event, { frame }: Details) {}', destructure('frame')],
    ['(event, { frame }: Details) => 1;', destructure('frame')],
    ['function f(a, { frame }, b) {}', destructure('frame')],
    ['function f(a, [{ frame }]) {}', destructure('frame')],
    ['const g = async ({ frame }: D = {}) => 1;', destructure('frame')],
    // Every frame property, renamed on the way out of its object.
    ['const { mainFrame: webContents } = w.webContents;', destructure('mainFrame')],
    ['const { senderFrame: webContents } = event;', destructure('senderFrame')],
    ['const { focusedFrame: wc } = w.webContents;', destructure('focusedFrame')],
    ['const { framesInSubtree: all } = frame;', destructure('framesInSubtree')],
    ['const { opener: parent } = window;', destructure('opener')],
    ['const { frame: webContents } = details;', destructure('frame')],
    ['const { initiator: webContents } = details;', destructure('initiator')],
    ['const { mainFrame } = w.webContents;', destructure('mainFrame')],
    ["const { 'senderFrame': wc } = event;", destructure('senderFrame')],
    ['const { opener = null, ...rest } = window;', destructure('opener')],
    ['({ senderFrame: webContents }) => webContents.send("c", x);', destructure('senderFrame')],
    ['function f({ mainFrame: wc }) {}', destructure('mainFrame')],
    ['({ focusedFrame: wc } = w.webContents);', destructure('focusedFrame')],
    // webFrameMain, however it is brought in.
    ["import { webFrameMain } from 'electron';", WEB_FRAME_MAIN],
    ["const { webFrameMain: wfm } = require('electron');", WEB_FRAME_MAIN],
    ['webFrameMain.fromId(1, 2);', WEB_FRAME_MAIN],
    ["const w = electron['webFrameMain'];", read('webFrameMain')],
    // Sends off anything but webContents.
    ['win.webContents.mainFrame.send("c", x);', send('send'), read('mainFrame')],
    ['frame.send("c", x);', send('send')],
    ['port?.send("c", x);', send('send')],
    ['frames[i]?.send("c", x);', send('send')],
    ['window.postMessage(data, "*");', send('postMessage')],
    ['window.opener.postMessage(x);', send('postMessage'), read('opener')],
    ['target.sendToFrame(id, "c", x);', send('sendToFrame')],
    ['event.reply("c", x);', send('reply')],
    ['ipcRenderer.send("c");', send('send')],
    ['x["send"]("c");', send('send')],
    ['x.webContentsList.send("c");', send('send')],
    ['getWebContents().send("c");', send('send')],
    ['webContents.owner.send("c");', send('send')],
    ['(x as WebContents).send("c");', send('send')],
    ['postMessage(data);', bare('postMessage')],
    ['sendToFrame(frameId, "c", x);', bare('sendToFrame')],
    // A snippet shaped like ipc/registerHandlers.ts, with no disable comment: the file is not exempt.
    [
        'const restrict = (event, webContents) => {\n    event.sender.mainFrame.send("c", x);\n    event.senderFrame.postMessage("c", x);\n    webContents.send("c", x);\n};',
        send('send'),
        read('mainFrame'),
        send('postMessage'),
        read('senderFrame'),
    ],
    // `.send` reached through call/apply/bind keeps its original receiver, and on a webContents it is accepted
    // only when called on that same webContents.
    ['frame.send.call(frame, "c", x);', send('send')],
    ['port.send.apply(port, ["c"]);', send('send')],
    ['const s = ports[0].send.bind(ports[0]);', send('send')],
    ['frame?.send?.call(frame, "c");', send('send')],
    ['win.postMessage.call(win, x);', send('postMessage')],
    ['other.webContents.send.call(logsWin.webContents, "c", x);', unfiltered('send')],
    ['a.webContents.send.apply(b.webContents, ["c"]);', unfiltered('send')],
    ['const s = a.webContents.send.bind(b.webContents);', unfiltered('send')],
    ['a.webContents.send.call(x, "c");', unfiltered('send')],
    ['a.webContents.send.call();', unfiltered('send')],
    ['a.webContents.send.call(f(), "c");', unfiltered('send')],
    ['a.webContents.send.call(a.webContents.foo, "c");', unfiltered('send')],
    ['a.webContents.send.call(a[b], "c");', unfiltered('send')],
    ['f().webContents.send.call(f().webContents, "c");', unfiltered('send')],
    ['a[k].webContents.send.call(a[k].webContents, "c");', unfiltered('send')],
    ['(win.webContents as WC).send.call(other, "c");', unfiltered('send')],
    // The instance filter replaces only `send`: every other send on a webContents is unfiltered.
    ['win.webContents.postMessage("c", x);', unfiltered('postMessage')],
    ['webContents.sendToFrame(id, "c", x);', unfiltered('sendToFrame')],
    ['win.webContents.reply("c", x);', unfiltered('reply')],
    ['win.webContents?.postMessage("c", x);', unfiltered('postMessage')],
    // Replacing or removing the instance `send` undoes the Logs-channel filter.
    ['win.webContents.send = (channel, ...args) => 1;', REWRITES_SEND],
    ['logsWin.webContents.send = otherWin.webContents.send;', REWRITES_SEND],
    ['webContents.send ||= other;', REWRITES_SEND],
    ['(win.webContents as WC).send = other;', REWRITES_SEND],
    ['win.webContents["send"] = other;', REWRITES_SEND],
    ['delete logsWin.webContents.send;', REWRITES_SEND],
    ['delete (win.webContents as WC).send;', REWRITES_SEND],
    ["Object.defineProperty(win.webContents, 'send', { value: other });", REWRITES_SEND],
    ["Reflect.deleteProperty(win.webContents, 'send');", REWRITES_SEND],
    ["Reflect.set(win.webContents, 'send', other);", REWRITES_SEND],
    ['Object.assign(win.webContents, { send: other });', REWRITES_SEND],
    ['Object.assign(win.webContents, { send });', REWRITES_SEND],
    ["Object.assign(win.webContents, extra, { 'send': other });", REWRITES_SEND],
    ["Object.assign(win.webContents, { ['send']: other });", REWRITES_SEND],
    ['Object.assign(win.webContents, { send() {} });', REWRITES_SEND],
    ['Object.assign(webContents, { ...rest, send: other } as Partial<WC>);', REWRITES_SEND],
    ['Object.defineProperties(win.webContents, { send: { value: other } });', REWRITES_SEND],
    ['Object.defineProperties(webContents, { send: desc } as const);', REWRITES_SEND],
    // Binding or aliasing a send method, by destructuring or a member read.
    ["ipcMain.on('x', ({ reply }) => reply('c', s));", bindsSend('reply')],
    ['const { postMessage: post } = port;', bindsSend('postMessage')],
    ['const { sendToFrame } = target;', bindsSend('sendToFrame')],
    ['const r = event.reply;', send('reply')],
    ['const s = window.postMessage;', send('postMessage')],
    ['const s = frame.send;', send('send')],
    ['const t = target["sendToFrame"];', send('sendToFrame')],
    ['register(event.reply);', send('reply')],
    // A cast, a parenthesis or a sequence around the callee does not hide the send.
    ['(window.postMessage as F)(x);', send('postMessage')],
    ['(frame.send satisfies F)("c");', send('send')],
    ['(<F>frame.send)("c");', send('send')],
    ['(0, frame.send)("c");', send('send')],
    ['(frame.send)("c");', send('send')],
    ['(postMessage as F)(x);', bare('postMessage')],
    ['(0, postMessage)(x);', bare('postMessage')],
    ['(sendToFrame!)(id);', bare('sendToFrame')],
    // The frame-created event, `.on` or `.once`, however the name is spelled.
    ["win.webContents.on('frame-created', cb);", FRAME_CREATED],
    ['win.webContents.once("frame-created", cb);', FRAME_CREATED],
    ['win.webContents.on(`frame-created`, cb);', FRAME_CREATED],
    ["win.webContents.on('frame-created', (_event, details) => details.frame);", FRAME_CREATED, read('frame')],
];

test('is registered under its plugin name', () => {
    expect(plugin.meta.name).toBe('frame-guard');
    expect(rule.meta.type).toBe('problem');
});

test.each(VALID)('passes: %s', (code) => {
    expect(messagesFor(code)).toEqual([]);
});

test.each(INVALID)('reports: %s', (code, ...messages) => {
    expect(messagesFor(code)).toEqual([...messages].sort());
});

test('a report sits on the line of the offending binding', () => {
    expect(reportsFor('ok;\nconst {\n    a,\n    frame = null,\n} = d;')).toEqual([
        { message: destructure('frame'), line: 4 },
    ]);
    expect(reportsFor('ok;\n\nfoo.send(x);')).toEqual([{ message: send('send'), line: 3 }]);
});

// The real Oxlint, on the same snippets: it must read the AST it gives the rule the way the in-process walk does.
describe('under Oxlint', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const os = jest.requireActual<typeof import('node:os')>('node:os');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const { spawnSync } = jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const root = path.join(__dirname, '..', '..');

    test('reports exactly what the in-process walk reports', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-guard-'));
        try {
            const cases: Array<readonly [string, readonly string[]]> = [
                ...VALID.map((code) => [code, []] as const),
                ...INVALID.map(([code, ...messages]) => [code, messages] as const),
            ];
            const config = path.join(dir, 'oxlintrc.json');
            fs.writeFileSync(
                config,
                JSON.stringify({
                    jsPlugins: [path.join(root, 'scripts/lint/frame-guard.mts')],
                    categories: { correctness: 'off' },
                    rules: { 'frame-guard/no-unfiltered-frame-send': 'error' },
                }),
            );
            for (const [index, [code]] of cases.entries()) fs.writeFileSync(path.join(dir, `case-${index}.ts`), code);
            const result = spawnSync(
                process.execPath,
                [path.join(root, 'node_modules/oxlint/bin/oxlint'), '-c', config, '--format=json', dir],
                { encoding: 'utf8', cwd: dir, timeout: 30_000 },
            );
            let output: unknown;
            try {
                output = JSON.parse(result.stdout);
            } catch {
                throw new Error(
                    `oxlint printed no JSON: status ${result.status}, signal ${result.signal}, stderr: ${result.stderr}`,
                );
            }
            const found = new Map<string, Set<string>>();
            const diagnostics = isPlainObject(output) && Array.isArray(output.diagnostics) ? output.diagnostics : [];
            for (const diagnostic of diagnostics) {
                const { filename, message } = invalid<{ filename: string; message: string }>(diagnostic);
                const name = path.basename(filename);
                found.set(name, (found.get(name) ?? new Set<string>()).add(message));
            }
            const actual = cases.map((_case, index) => [...(found.get(`case-${index}.ts`) ?? [])].sort());
            expect(actual).toEqual(cases.map(([, messages]) => [...messages].sort()));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
