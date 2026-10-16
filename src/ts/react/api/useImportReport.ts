import { useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { describeImportRef } from '../../settings/importRefs';
import * as ipc from './ipc';
import { useIpcQuery } from './useIpcQuery';

import type { ImportRef } from '../../types/config';
import type { IpcQueryTools } from './useIpcQuery';

type ImportReportAnswer = Awaited<ReturnType<typeof ipc.getImportReport>>;

/** What the import of settings.json left unresolved (null: the settings were not imported from one). */
type ImportReport = NonNullable<Extract<ImportReportAnswer, { success: true }>['report']>;

const fetchReport = () => ipc.getImportReport();

// A read that fails shows nothing: the report stays stored and is asked for again at the next start.
const applyReport = (
    result: ImportReportAnswer,
    { setData }: Pick<IpcQueryTools<ImportReport | null, Error>, 'setData'>,
) => setData(result?.success ? result.report : null);

/** The import report, read again whenever the settings change. */
export function useImportReport() {
    return useIpcQuery(fetchReport, { initialData: null as ImportReport | null, apply: applyReport, subscribe: true });
}

/** One entry of the report as a line in the language of the window. */
export function useImportRefText(): (ref: string | ImportRef) => string {
    const { t } = useTranslation();
    return useCallback(
        (ref) =>
            describeImportRef(ref, {
                importRefLine: t('notice.importRefLine'),
                importRefRule: t('notice.importRefRule'),
                importRefRuleTitled: t('notice.importRefRuleTitled'),
                importRefProfile: t('notice.importRefProfile'),
                importRefChallenge: t('notice.importRefChallenge'),
                importRefChallengeTitled: t('notice.importRefChallengeTitled'),
                importRefProfileMissing: t('notice.importRefProfileMissing'),
                importRefProfileInvalid: t('notice.importRefProfileInvalid'),
                importRefScenarioMissing: t('notice.importRefScenarioMissing'),
                importRefScenarioInvalid: t('notice.importRefScenarioInvalid'),
            }),
        [t],
    );
}
