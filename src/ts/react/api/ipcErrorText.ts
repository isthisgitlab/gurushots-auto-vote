/**
 * Display text for an IPC failure's `error`: the handlers answer invalid
 * arguments with the machine code 'invalid-args', everything else is already
 * a message.
 *
 * @param t - the translation function (useTranslation().t)
 */
export const ipcErrorText = <E extends string | null | undefined>(error: E, t: (key: string) => string) =>
    error === 'invalid-args' ? t('errors.actionInvalidArgs') : error;
