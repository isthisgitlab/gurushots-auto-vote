/**
 * Pure decision layer behind the deadline-action OS notifications. No facade,
 * no platform I/O — these tests pin the review-mandated behaviour: lead-time
 * boundary (incl. null/NaN dueAt and past-due exclusion), per-action gating,
 * the dedupe fire-once/re-fire/prune lifecycle, coalescing of simultaneous due
 * entries, and that a server-supplied title is sanitized before it leaves the
 * module (newline / control-char / RTL / leading-dash / over-length).
 */

const {
    sanitizeNotificationText,
    interpolate,
    computeDueNotifications,
    createDedupe,
    formatNotification,
    readNotificationConfig,
    ACTION_LABEL_KEY,
} = require('../../src/js/services/deadlineNotifications');

const NOW = 1_000_000;
const ALL_ON = { autoFill: true, boost: true, turbo: true, emergencyFill: true };

const challenge = (id, title, actions) => ({ id, title, actions });
const action = (name, secondsUntil) => ({ action: name, dueAt: NOW + secondsUntil });

describe('computeDueNotifications — lead-time boundary', () => {
    const opts = { leadSec: 300, enabled: ALL_ON };

    test('fires for an action strictly inside the lead window', () => {
        const due = computeDueNotifications([challenge('1', 'Sunset', [action('boost', 120)])], NOW, opts);
        expect(due).toHaveLength(1);
        expect(due[0]).toMatchObject({ challengeId: '1', action: 'boost', secondsUntil: 120 });
        expect(due[0].fireKey).toBe(`1:boost:${NOW + 120}`);
    });

    test('excludes an action beyond the lead window', () => {
        const due = computeDueNotifications([challenge('1', 'Sunset', [action('boost', 301)])], NOW, opts);
        expect(due).toHaveLength(0);
    });

    test('includes exactly at the lead boundary, excludes just past it', () => {
        expect(computeDueNotifications([challenge('1', 'x', [action('boost', 300)])], NOW, opts)).toHaveLength(1);
        expect(computeDueNotifications([challenge('1', 'x', [action('boost', 301)])], NOW, opts)).toHaveLength(0);
    });

    test('excludes past-due (secondsUntil <= 0)', () => {
        expect(computeDueNotifications([challenge('1', 'x', [action('boost', 0)])], NOW, opts)).toHaveLength(0);
        expect(computeDueNotifications([challenge('1', 'x', [action('boost', -30)])], NOW, opts)).toHaveLength(0);
    });

    test('excludes null / NaN dueAt without throwing', () => {
        const acts = [
            { action: 'boost', dueAt: null },
            { action: 'turbo', dueAt: undefined },
            { action: 'autoFill', dueAt: NaN },
        ];
        expect(computeDueNotifications([challenge('1', 'x', acts)], NOW, opts)).toEqual([]);
    });
});

describe('computeDueNotifications — gating & robustness', () => {
    test('only enabled action types are due', () => {
        const c = challenge('1', 'x', [action('boost', 60), action('turbo', 60), action('autoFill', 60)]);
        const due = computeDueNotifications([c], NOW, { leadSec: 300, enabled: { boost: true } });
        expect(due.map((d) => d.action)).toEqual(['boost']);
    });

    test('nothing enabled → empty', () => {
        const c = challenge('1', 'x', [action('boost', 60)]);
        expect(computeDueNotifications([c], NOW, { leadSec: 300, enabled: {} })).toEqual([]);
    });

    test('non-positive lead window → empty', () => {
        const c = challenge('1', 'x', [action('boost', 60)]);
        expect(computeDueNotifications([c], NOW, { leadSec: 0, enabled: ALL_ON })).toEqual([]);
    });

    test('malformed input is skipped, never throws', () => {
        const inputs = [
            null,
            undefined,
            42,
            { id: null, title: 'x', actions: [action('boost', 60)] },
            { id: '1', title: 'x', actions: 'nope' },
            { id: '2', title: 'x', actions: [null, 7, action('boost', 60)] },
        ];
        const due = computeDueNotifications(inputs, NOW, { leadSec: 300, enabled: ALL_ON });
        // Only the well-formed action on challenge id '2' survives.
        expect(due.map((d) => d.challengeId)).toEqual(['2']);
    });

    test('non-array top-level input → empty', () => {
        expect(computeDueNotifications(null, NOW, { leadSec: 300, enabled: ALL_ON })).toEqual([]);
    });
});

describe('createDedupe — fire-once / re-fire / prune', () => {
    test('fires once then suppresses the same key', () => {
        const gate = createDedupe();
        const due = [{ fireKey: 'a' }, { fireKey: 'b' }];
        expect(gate.filterNew(due).map((d) => d.fireKey)).toEqual(['a', 'b']);
        expect(gate.filterNew(due)).toEqual([]);
    });

    test('a new dueAt (new key) fires again', () => {
        const gate = createDedupe();
        gate.filterNew([{ fireKey: '1:boost:100' }]);
        // window re-armed → different dueAt → different key
        expect(gate.filterNew([{ fireKey: '1:boost:200' }]).map((d) => d.fireKey)).toEqual(['1:boost:200']);
    });

    test('a key that drops out and returns re-fires (pruned)', () => {
        const gate = createDedupe();
        gate.filterNew([{ fireKey: 'a' }]); // fired
        gate.filterNew([]); // 'a' no longer due → pruned
        expect(gate.filterNew([{ fireKey: 'a' }]).map((d) => d.fireKey)).toEqual(['a']);
    });

    test('set stays bounded across many cycles for a persistently-due key', () => {
        const gate = createDedupe();
        for (let i = 0; i < 100; i++) gate.filterNew([{ fireKey: 'stable' }]);
        // still-due key is only ever emitted once, and pruning keeps it bounded
        expect(gate.filterNew([{ fireKey: 'stable' }])).toEqual([]);
        gate.filterNew([]); // prune
        expect(gate.filterNew([{ fireKey: 'stable' }]).map((d) => d.fireKey)).toEqual(['stable']);
    });
});

describe('sanitizeNotificationText', () => {
    test('collapses newlines/tabs so a title cannot forge extra lines', () => {
        expect(sanitizeNotificationText('Line1\nLine2\tX')).toBe('Line1 Line2 X');
    });

    test('strips leading dashes so it cannot look like a CLI flag', () => {
        expect(sanitizeNotificationText('--rm -rf title')).toBe('rm -rf title');
    });

    test('removes zero-width / RTL-override spoofing chars', () => {
        expect(sanitizeNotificationText('a​b‮c')).toBe('abc');
    });

    test('caps length', () => {
        expect(sanitizeNotificationText('x'.repeat(500)).length).toBe(120);
    });

    test('no double space when a control char sits between two spaces', () => {
        // 'a' SPACE CONTROL SPACE 'b' — the control strip must not leave 'a  b'.
        const input = `a ${String.fromCharCode(1)} b`;
        expect(sanitizeNotificationText(input)).toBe('a b');
    });

    test('nullish → empty string', () => {
        expect(sanitizeNotificationText(null)).toBe('');
        expect(sanitizeNotificationText(undefined)).toBe('');
    });
});

describe('interpolate', () => {
    test('fills known tokens, leaves unknown intact', () => {
        expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    });
});

describe('formatNotification — single & coalesced', () => {
    // Minimal translator: echoes back a template carrying placeholders so the
    // interpolation + label reuse is exercised without loading the i18n bundle.
    const translate = (key) => {
        const table = {
            'app.notifyTitle': '{action} coming up',
            'app.notifyBody': '{action} for "{title}" in {minutes} min — keep the app open',
            'app.notifyGroupTitle': 'Actions coming up',
            'app.notifyGroupBody': '{count} actions in the next {minutes} min — keep the app open',
            ...Object.fromEntries(
                Object.values(ACTION_LABEL_KEY).map((k, i) => [
                    k,
                    ['Auto-fill', 'Boost', 'Turbo', 'Emergency fill'][i],
                ]),
            ),
        };
        return table[key] ?? key;
    };

    test('null / empty entries → null', () => {
        expect(formatNotification([], translate)).toBeNull();
        expect(formatNotification(null, translate)).toBeNull();
    });

    test('single entry names the action and challenge with rounded minutes', () => {
        const out = formatNotification([{ title: 'Sunset', action: 'boost', secondsUntil: 150 }], translate);
        expect(out.title).toBe('Boost coming up');
        expect(out.body).toBe('Boost for "Sunset" in 3 min — keep the app open');
    });

    test.each([
        ['autoFill', 'Auto-fill'],
        ['boost', 'Boost'],
        ['turbo', 'Turbo'],
        ['emergencyFill', 'Emergency fill'],
    ])('single-entry English fallback labels %s → %s', (name, label) => {
        const out = formatNotification([{ title: 'T', action: name, secondsUntil: 60 }], translate);
        expect(out.title).toContain(label);
    });

    test('multiple simultaneous entries coalesce into one grouped toast', () => {
        const out = formatNotification(
            [
                { title: 'A', action: 'boost', secondsUntil: 120 },
                { title: 'B', action: 'turbo', secondsUntil: 240 },
            ],
            translate,
        );
        expect(out.title).toBe('Actions coming up');
        expect(out.body).toBe('2 actions in the next 2 min — keep the app open');
    });

    test('unknown action label falls back to the raw action key (defensive)', () => {
        // Unreachable while enabled[] gates to the four known actions, but pins
        // the fallback so a future added action type does not crash formatting.
        const out = formatNotification([{ title: 'T', action: 'mystery', secondsUntil: 60 }], translate);
        expect(out.body).toContain('mystery');
    });
});

describe('readNotificationConfig', () => {
    test('anyEnabled false when all toggles off (default) → host early-exit', () => {
        const cfg = readNotificationConfig(() => false);
        expect(cfg.anyEnabled).toBe(false);
        expect(cfg.enabled).toEqual({ autoFill: false, boost: false, turbo: false, emergencyFill: false });
    });

    test('reads lead time in minutes → seconds and the enabled map', () => {
        const store = { notifyOnBoost: true, notifyLeadTime: 5 };
        const cfg = readNotificationConfig((k) => store[k]);
        expect(cfg.anyEnabled).toBe(true);
        expect(cfg.enabled.boost).toBe(true);
        expect(cfg.leadSec).toBe(300);
    });

    test('invalid/zero lead time → 0 seconds (nothing ever due)', () => {
        expect(readNotificationConfig((k) => ({ notifyLeadTime: 0 })[k]).leadSec).toBe(0);
        expect(readNotificationConfig((k) => ({ notifyLeadTime: 'x' })[k]).leadSec).toBe(0);
    });
});
