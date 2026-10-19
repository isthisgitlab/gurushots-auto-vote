import { useEffect, useState } from 'react';

/**
 * The state of a dialog whose confirming button makes a call that takes a moment: whether it is out, and the
 * problem (a translation key) its last answer left. A problem from an earlier opening never shows in a later one: it
 * goes whenever `openedFor` changes, and whenever a new attempt starts.
 *
 * @param openedFor - what the dialog is open for (null while closed)
 */
export function useConfirmedAction(openedFor: unknown) {
    const [working, setWorking] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    useEffect(() => setProblem(null), [openedFor]);

    /**
     * @param call - makes the call; answers the problem it left, or null when it went through
     */
    const run = async (call: () => Promise<string | null>) => {
        setWorking(true);
        setProblem(null);
        try {
            setProblem(await call());
        } finally {
            setWorking(false);
        }
    };

    return { working, problem, run };
}
