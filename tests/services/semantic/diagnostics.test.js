const { createDiagnostics } = require('../../../src/js/services/semantic/diagnostics');

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
});
