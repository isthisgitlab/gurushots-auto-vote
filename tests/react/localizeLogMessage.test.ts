import { logMessages as englishLogMessages } from '../../src/js/translations/logEnglish';
import { logMessages as latvianLogMessages } from '../../src/js/translations/logLatvian';
import { localizeLogMessage } from '../../src/js/react/components/logs/localizeLogMessage';

const slots = /\{(\d+)\}/g;

describe('Latvian log messages', () => {
    test('every catalog entry preserves its values and can be matched', () => {
        const failures: string[] = [];
        expect(Object.keys(englishLogMessages).sort()).toEqual(Object.keys(latvianLogMessages).sort());
        for (const [key, english] of Object.entries(englishLogMessages)) {
            const latvian = latvianLogMessages[key as keyof typeof latvianLogMessages];
            const values = (index: string) => `VALUE_${index}`;
            const message = english
                .replace(slots, (_, index: string) => values(index))
                .replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
            const expected = latvian.replace(slots, (_, index: string) => values(index));
            if (/[a-z]/i.test(english.replace(slots, '')) && localizeLogMessage(message) !== expected)
                failures.push(english.slice(0, 120));

            const englishSlots = [...english.matchAll(slots)].map((match) => match[1]).sort();
            const latvianSlots = [...latvian.matchAll(slots)].map((match) => match[1]).sort();
            if (englishSlots.join(',') !== latvianSlots.join(',')) failures.push(`${english}: lost values`);
        }
        expect(failures).toEqual([]);
    });

    test('translates the exclusion explanation and an automatically added icon', () => {
        const message =
            '[Challenge 42: No Humans] only names what to leave out (human); ranking your whole library with photos showing it excluded';
        expect(localizeLogMessage(`ℹ️ Fill: ${message}`)).toBe(
            'ℹ️ Fill: [Challenge 42: No Humans] norāda tikai to, ko neiekļaut (human); izvērtē visu fotoattēlu bibliotēku un izslēdz attēlus, kuros tas redzams',
        );
        expect(localizeLogMessage('ℹ️ Invalid timestamp provided')).toBe('ℹ️ Norādīts nepareizs laika zīmogs');
    });

    test('translates logger operation wrappers and collapsed multiline messages', () => {
        expect(localizeLogMessage('🔄 CLI Manual Voting Process...')).toBe('🔄 CLI manuālais balsošanas process...');
        expect(localizeLogMessage('✅ CLI Manual Voting Process completed (123ms)')).toBe(
            '✅ CLI manuālais balsošanas process pabeigts (123 ms)',
        );
        expect(localizeLogMessage('❌ CLI Manual Voting Process failed: failed to fetch challenges')).toBe(
            '❌ CLI manuālais balsošanas process neizdevās: neizdevās ielādēt izaicinājumus',
        );
        expect(localizeLogMessage('✅ Boost not available (123ms)')).toBe('✅ Pastiprinājums nav pieejams (123 ms)');
        expect(localizeLogMessage('❌ CLI Manual Voting Process failed: upstream-specific-error')).toBe(
            '❌ CLI manuālais balsošanas process neizdevās: upstream-specific-error',
        );
        expect(localizeLogMessage(' Settings:')).toBe('\nIestatījumi:');
    });

    test('leaves unknown technical text intact and handles unmatched icons', () => {
        expect(localizeLogMessage('upstream-specific-error')).toBe('upstream-specific-error');
        expect(localizeLogMessage('ℹ️ upstream-specific-error')).toBe('ℹ️ upstream-specific-error');
        expect(localizeLogMessage('🔍 upstream-specific-error')).toBe('🔍 upstream-specific-error');
        expect(localizeLogMessage('🔄 upstream-specific-error...')).toBe('🔄 upstream-specific-error...');
        expect(localizeLogMessage('✅ upstream-specific-error (123ms)')).toBe('✅ upstream-specific-error (123ms)');
        expect(localizeLogMessage('✅ upstream-specific-operation completed (123ms)')).toBe(
            '✅ upstream-specific-operation completed (123ms)',
        );
        expect(localizeLogMessage('❌ upstream-specific-operation failed: upstream-specific-error')).toBe(
            '❌ upstream-specific-operation failed: upstream-specific-error',
        );
    });
});
