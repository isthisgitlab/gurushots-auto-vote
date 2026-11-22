import { useMemo } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

import type { IpcQueryTools } from './useIpcQuery';
import type { ScenarioCapabilityRow, ScenarioScope, ScenarioValueDescriptor } from '../../core/types/settings';

/**
 * The scenario capability catalogue (get-scenario-capabilities), as the builder uses it: which keys a phase of each
 * scope may write, which a live value may read, and each key's value descriptor. A read that fails (or a host that
 * answers nothing) leaves the catalogue empty: nothing is offered, never something the backend would refuse.
 */
export type ScenarioCapabilities = {
    rows: ScenarioCapabilityRow[];
    /** The keys a phase of `scope` may write (its settings overlay, bindings and setSetting steps). */
    writableKeys: (scope: ScenarioScope) => string[];
    /** The keys a live value may reference: read as a value with an expression form. */
    readableKeys: string[];
    /** Each catalogue key's value descriptor. */
    descriptors: Record<string, ScenarioValueDescriptor>;
};

const EMPTY: ScenarioCapabilities = {
    rows: [],
    writableKeys: () => [],
    readableKeys: [],
    descriptors: {},
};

type Result = Awaited<ReturnType<typeof ipc.getScenarioCapabilities>>;

const catalogueOf = (rows: ScenarioCapabilityRow[]): ScenarioCapabilities => ({
    rows,
    writableKeys: (scope) => rows.filter((row) => row.phaseWrite.includes(scope)).map((row) => row.key),
    readableKeys: rows.filter((row) => row.read === 'value' && row.value.kind !== 'other').map((row) => row.key),
    descriptors: Object.fromEntries(rows.map((row) => [row.key, row.value])),
});

/**
 * The capability catalogue, revalidating on every settings-changed broadcast.
 */
export function useScenarioCapabilities(): ScenarioCapabilities {
    const apply = useMemo(
        () =>
            (result: Result, { setData }: IpcQueryTools<ScenarioCapabilities, Error | string>) => {
                if (result?.success) setData(catalogueOf(result.capabilities.settings));
            },
        [],
    );
    const { data } = useIpcQuery(ipc.getScenarioCapabilities, {
        initialData: EMPTY,
        subscribe: true,
        apply,
    });
    return data;
}
