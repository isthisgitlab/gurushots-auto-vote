import { logMessages as englishLogMessages } from '../../../translations/logEnglish';
import { logMessages as latvianLogMessages } from '../../../translations/logLatvian';
import { sentenceCaseLogMessage } from '../../../format/logSafe';

const placeholders = /\{(\d+)\}/g;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const logLabels: Record<string, string> = {
    Fill: 'Iesniegšana',
    autoFill: 'Automātiskā iesniegšana',
    AutoFill: 'Automātiskā iesniegšana',
    join: 'Pievienošanās',
    Join: 'Pievienošanās',
};

function localizeValue(value: string, isLabel: boolean): string {
    if (isLabel) return logLabels[value] ?? value;
    if (value === 'the entry was') return '1';
    const entries = /^(\d+) entries were$/.exec(value);
    if (entries) return entries[1];
    return value
        .replace(/\[Challenge ([^:\]]+): ([^\]]+)\]/g, '[Izaicinājums $1: $2]')
        .replace(/\((\d+) votes, (\d+) achievements, (\d+) views\)/g, '(balsis: $1, sasniegumi: $2, skatījumi: $3)')
        .replace(
            /past performance not looked up yet — ranked below any photo that was/g,
            'iepriekšējie rezultāti vēl nav pārbaudīti — sarindots aiz visiem foto, kuru rezultāti ir pārbaudīti',
        )
        .replace(
            /; past-performance figures have been looked up for (\d+) of (\d+) of them so far, and the rest are looked up a batch per fill/g,
            '; līdz šim iepriekšējie rezultāti pārbaudīti $1 no $2 foto, pārējos pārbauda pa daļai katrā iesniegšanas reizē',
        );
}

const exact = new Map<string, string>();
const patterns: { key: string; prefix: string; length: number; positions: number[]; label: boolean; regex: RegExp }[] = [];

for (const [key, source] of Object.entries(englishLogMessages)) {
    const original = source.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
    for (const template of new Set([original, sentenceCaseLogMessage(original)])) {
        const slots = [...template.matchAll(placeholders)];
        if (slots.length === 0) {
            exact.set(template, key);
            continue;
        }
        if (!/[a-z]/i.test(template.replace(placeholders, ''))) continue;

        let expression = '^';
        let cursor = 0;
        for (const slot of slots) {
            expression += escapeRegex(template.slice(cursor, slot.index)) + '(.*?)';
            cursor = slot.index + slot[0].length;
        }
        expression += escapeRegex(template.slice(cursor)) + '$';
        const prefix = template.slice(0, slots[0].index);
        patterns.push({
            key,
            prefix,
            length: template.replace(placeholders, '').length,
            positions: slots.map((slot) => Number(slot[1])),
            label: template.startsWith('{0}:'),
            regex: new RegExp(expression, 's'),
        });
    }
}

patterns.sort((a, b) => b.length - a.length);

function translateBody(message: string): string | null {
    const key = exact.get(message);
    if (key) return latvianLogMessages[key as keyof typeof latvianLogMessages];

    for (const pattern of patterns) {
        if (!message.startsWith(pattern.prefix)) continue;
        const match = pattern.regex.exec(message);
        if (!match) continue;
        const values = new Map(
            pattern.positions.map((position, index) => [
                position,
                localizeValue(match[index + 1], pattern.label && position === 0),
            ]),
        );
        return latvianLogMessages[pattern.key as keyof typeof latvianLogMessages].replace(
            placeholders,
            // Catalog parity tests ensure each translated slot exists in the matched source.
            (_, index: string) => values.get(Number(index))!,
        );
    }
    const oldChallengeCase = message.replace(
        /^(\[Challenge [^\]]+\]\s+)(\p{Lu})/u,
        (_, tag: string, first: string) => tag + first.toLowerCase(),
    );
    if (oldChallengeCase !== message) return translateBody(oldChallengeCase);
    return null;
}

export function localizeLogMessage(message: string): string {
    if (exact.has(message)) return translateBody(message)!;

    for (const icon of ['🔍 ', 'ℹ️ ', '⚠️ ', '❌ ', '✅ ']) {
        if (!message.startsWith(icon)) continue;
        const body = translateBody(message.slice(icon.length));
        if (body !== null) return icon + body;
    }
    const translated = translateBody(message);
    if (translated !== null) return translated;
    if (message.startsWith('🔄 ') && message.endsWith('...')) {
        const body = translateBody(message.slice(3, -3));
        if (body !== null) return `🔄 ${body}...`;
    }
    const completed = /^✅ (.+) \((\d+)ms\)$/.exec(message);
    if (completed) {
        const body = translateBody(completed[1]);
        if (body !== null) return `✅ ${body} (${completed[2]} ms)`;
        if (completed[1].endsWith(' completed')) {
            const operation = translateBody(completed[1].slice(0, -10));
            if (operation !== null) return `✅ ${operation} pabeigts (${completed[2]} ms)`;
        }
    }
    const failed = /^❌ (.+) failed: (.+)$/.exec(message);
    if (failed) {
        const operation = translateBody(failed[1]);
        if (operation !== null) return `❌ ${operation} neizdevās: ${translateBody(failed[2]) ?? failed[2]}`;
    }
    return message;
}
