import { useState, useCallback } from 'react';

/**
 * Hook for voting operations via IPC
 * @returns {{ voteOnChallenge: function, voteAllChallenges: function, runVotingCycle: function, loading: boolean, error: string|null }}
 */
export function useVoting() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    /**
     * Vote on a single challenge manually
     */
    const voteOnChallenge = useCallback(async (challengeId, challengeTitle) => {
        setLoading(true);
        setError(null);

        try {
            const result = await window.api.voteOnChallengeManual(challengeId, challengeTitle);

            if (!result?.success) {
                setError(result?.error || 'Vote failed');
            }

            return result;
        } catch (err) {
            const message = err.message || 'Vote error';
            setError(message);
            return { success: false, error: message };
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Vote on all challenges below 100% exposure
     */
    const voteAllChallenges = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const result = await window.api.voteAllChallengesManual();

            if (!result?.success) {
                setError(result?.error || 'Vote all failed');
            }

            return result;
        } catch (err) {
            const message = err.message || 'Vote all error';
            setError(message);
            return { success: false, error: message };
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Run automated voting cycle
     */
    const runVotingCycle = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const result = await window.api.runVotingCycle();

            if (!result?.success) {
                setError(result?.error || 'Voting cycle failed');
            }

            return result;
        } catch (err) {
            const message = err.message || 'Voting cycle error';
            setError(message);
            return { success: false, error: message };
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Clear error
     */
    const clearError = useCallback(() => {
        setError(null);
    }, []);

    return {
        voteOnChallenge,
        voteAllChallenges,
        runVotingCycle,
        loading,
        error,
        clearError,
    };
}
