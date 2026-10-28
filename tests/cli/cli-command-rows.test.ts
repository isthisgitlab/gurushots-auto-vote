/**
 * The command rows are the one home for a command's metadata: these assertions pin what the dispatch
 * table and the help rendering are built on — no two rows claim a name, every dispatch key traces to
 * a row, aliases ride their row's handler and markerless flag, and a row's usage text is readable.
 */

import type * as commandTableModule from '../../src/ts/cli/commandTable';
import type * as commandRowsModule from '../../src/ts/cli/commandRows';

const { COMMANDS, holdsSessionMarker } = require('../../src/ts/cli/commandTable') as typeof commandTableModule;
const { COMMAND_ROWS, usageOf } = require('../../src/ts/cli/commandRows') as typeof commandRowsModule;

describe('command rows', () => {
    test('every row name and alias is unique across the table', () => {
        const names = COMMAND_ROWS.flatMap((row) => [row.name, ...(row.aliases ?? [])]);
        expect(new Set(names).size).toBe(names.length);
    });

    test('every COMMANDS key traces to a row name or alias', () => {
        const names = new Set(COMMAND_ROWS.flatMap((row) => [row.name, ...(row.aliases ?? [])]));
        expect(Object.keys(COMMANDS).sort()).toEqual([...names].sort());
    });

    test('aliases dispatch to their row handler and inherit its markerless flag', () => {
        expect(COMMANDS.coins).toBe(COMMANDS.bankroll);
        expect(COMMANDS['-h']).toBe(COMMANDS.help);
        expect(holdsSessionMarker('coins')).toBe(true);
        expect(holdsSessionMarker('-h')).toBe(false);
    });

    test('usageOf reads a row usage text back, and refuses a row without one', () => {
        expect(usageOf('join')).toBe('Usage: join <id> [--yes [--max-coins=<coins>]]');
        expect(() => usageOf('status')).toThrow('Command "status" carries no usage text in its row');
    });
});
