const { createDiagnostics, shouldCollect } = require('../../../src/js/services/semantic/diagnostics');
const runtime = require('../../../src/js/runtime');
const settings = require('../../../src/js/settings');

const memoryStore = () => {
    let raw = null;
    return {
        readRaw: () => raw,
        writeRaw: (value) => {
            raw = value;
        },
        raw: () => raw,
    };
};

describe('lexicon diagnostics', () => {
    test('counts one challenge per day and stores only bounded word stems', () => {
        const store = memoryStore();
        const collector = createDiagnostics(store);
        collector.record('private-challenge-id', {
            themeWords: ['unseen', 'unseen'],
            labelWords: ['unseenlabel', 'unseenlabel'],
            noOnThemeScore: true,
        });
        collector.record('private-challenge-id', { themeWords: ['another'] });
        createDiagnostics(store).record('private-challenge-id', { themeWords: ['another'] });
        const report = collector.read();
        expect(report.challenges).toBe(1);
        expect(report.noOnThemeScore).toBe(1);
        expect(report.themeWords).toEqual({ unseen: 1 });
        expect(report.labelWords).toEqual({ unseenlabel: 1 });
        expect(store.raw()).not.toContain('private-challenge-id');

        collector.record('another-challenge', {
            themeWords: Array.from({ length: 250 }, (_, i) =>
                String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26)),
            ),
        });
        expect(Object.keys(collector.read().themeWords).length).toBeLessThanOrEqual(200);
    });

    test('unreadable storage does not interrupt scoring and a later write can retry', () => {
        let fail = true;
        let raw = null;
        const collector = createDiagnostics({
            readRaw: () => raw,
            writeRaw: (value) => {
                if (fail) throw new Error('storage unavailable');
                raw = value;
            },
        });
        expect(() => collector.record('challenge', { noThemeVector: true })).not.toThrow();
        fail = false;
        collector.record('challenge', { noThemeVector: true });
        expect(collector.read()).toMatchObject({ challenges: 1, noThemeVector: 1 });
    });

    test('rejects empty keys and invalid word stems, and counts repeated misses across challenges', () => {
        const collector = createDiagnostics(memoryStore());
        collector.record(null, { themeWords: ['lost'] });
        collector.record('first', { themeWords: ['lost', 'bad1'], noLabelVectors: true });
        collector.record('second', { themeWords: ['lost'], noLabelVectors: true });
        expect(collector.read()).toMatchObject({
            challenges: 2,
            noLabelVectors: 2,
            themeWords: { lost: 2 },
        });
    });

    test('retains a bounded set of challenge fingerprints across restarts', () => {
        const store = memoryStore();
        const collector = createDiagnostics(store);
        for (let i = 0; i < 513; i++) collector.record(`challenge-${i}`, {});
        const report = createDiagnostics(store).read();
        expect(report.challenges).toBe(513);
        expect(report.seenChallenges).toHaveLength(512);
        expect(store.raw()).not.toContain('challenge-0');
    });

    test('evicts a rare word before a frequently observed word', () => {
        const store = memoryStore();
        const collector = createDiagnostics(store);
        collector.record('first', { themeWords: ['aa'] });
        collector.record('second', { themeWords: ['aa'] });
        collector.record('third', {
            themeWords: Array.from({ length: 200 }, (_, i) =>
                String.fromCharCode(98 + Math.floor(i / 26), 97 + (i % 26)),
            ),
        });
        expect(collector.read().themeWords.aa).toBe(2);
        expect(Object.keys(collector.read().themeWords)).toHaveLength(200);
    });

    test('collects only in real mode and fails closed when settings are unavailable', () => {
        const testMode = jest.spyOn(runtime, 'isTest').mockReturnValue(false);
        const getSetting = jest.spyOn(settings, 'getSetting');
        try {
            getSetting.mockReturnValue(false);
            expect(shouldCollect()).toBe(true);
            getSetting.mockReturnValue(true);
            expect(shouldCollect()).toBe(false);
            getSetting.mockImplementation(() => {
                throw new Error('settings unavailable');
            });
            expect(shouldCollect()).toBe(false);
        } finally {
            getSetting.mockRestore();
            testMode.mockRestore();
        }
    });
});
