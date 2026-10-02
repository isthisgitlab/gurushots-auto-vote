/**
 * Fill pipeline, pick checks: the visual re-rank and the uncertain-subject record.
 */

import { finalizePick, readChallengeTheme, buildThemeKeywords, scorePhoto } from '../../photoPicker';
import { rankVisually } from '../../visionVerifier';
import type { Challenge } from '../../../types/gurushots';
import type { IgnoreWords, PickerPhoto, ScoredCandidate } from '../../../types/photoPicker';
import type { FillAttemptParams, RankDeps } from '../../../types/autoFill';
import { errorMessage } from '../../../errorMessage';
import { oneLine } from '../../../format/logSafe';

// Visual re-rank of the tag pick (see services/visionVerifier.ts). The picked
// ids lead the shortlist so a model that abstains returns exactly them; the
// rest of the tag ranking follows as alternatives it may promote.
const verifyFillPick = async (
    challenge: Challenge,
    scored: ScoredCandidate[],
    eligible: PickerPhoto[],
    picked: string[],
    ignoreWords: IgnoreWords,
    deps: RankDeps,
): Promise<{ picked: string[]; visualEvidence: Set<string> | null }> => {
    const ranked = finalizePick(scored, Math.max(12, picked.length));
    const selected = new Set(picked.map(String));
    const preferred = [...picked, ...ranked.filter((id) => !selected.has(String(id)))];
    try {
        const rank = deps.rankVisually || rankVisually;
        let visualEvidence: Set<string> | null = null;
        const result = await rank(challenge, preferred, eligible, picked.length, {
            logger: deps.logger,
            ignoreWords,
            onVisualEvidence: (acceptedIds) => {
                visualEvidence = acceptedIds;
            },
        });
        return Array.isArray(result) && result.length === picked.length
            ? { picked: result, visualEvidence }
            : { picked, visualEvidence: null };
    } catch (error) {
        deps.logger
            .withCategory('autoFill')
            .warning(
                `Visual check failed for ${deps.logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
                null,
            );
        return { picked, visualEvidence: null };
    }
};

/** Persist weak subject evidence only after a photo was actually submitted. */
const recordUncertainSubmission = ({
    challenge,
    label,
    scored,
    picked,
    visualEvidence,
    ignoreWords,
    deps,
}: Pick<FillAttemptParams, 'challenge' | 'label' | 'deps'> & {
    scored: ScoredCandidate[];
    picked: string[];
    visualEvidence: Set<string> | null;
    ignoreWords: IgnoreWords;
}) => {
    if (label === 'manualFill' || !deps.entryAges || readChallengeTheme(challenge, ignoreWords).kind === 'open') return;
    const subjectWords = visualEvidence ? [] : buildThemeKeywords(challenge, ignoreWords);
    for (const id of picked) {
        const entry = scored.find((candidate) => String(candidate.id) === String(id));
        // Should Include Tags are a user preference, not evidence that the
        // photo depicts the challenge subject.
        if (
            !entry ||
            (visualEvidence
                ? visualEvidence.has(id)
                : entry.semantic !== 0 || scorePhoto(entry.photo, subjectWords) !== 0)
        )
            continue;
        const reason = visualEvidence ? 'visual check did not confirm the subject' : 'no subject match';
        try {
            deps.entryAges.markUncertain(challenge, id, Math.floor(Date.now() / 1000));
            deps.logger
                .withCategory('autoFill')
                .warning(
                    `${label}: photo ${oneLine(id)} ${reason} for ${deps.logger.challengeTag(challenge)}; automatic Boost/Turbo may be skipped`,
                    null,
                );
        } catch (error) {
            deps.logger
                .withCategory('autoFill')
                .warning(
                    `${label}: could not record theme uncertainty for submitted photo ${oneLine(id)}: ${errorMessage(error)}`,
                    null,
                );
        }
    }
};

export { verifyFillPick, recordUncertainSubmission };
