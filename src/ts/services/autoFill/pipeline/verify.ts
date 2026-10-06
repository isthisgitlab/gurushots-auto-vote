/**
 * Fill pipeline, pick checks: the visual re-rank and the uncertain-subject record.
 */

import { finalizePick, readChallengeTheme, buildThemeKeywords, scorePhoto, splitByChosen } from '../../photoPicker';
import { rankVisually } from '../../visionVerifier';
import type { Challenge } from '../../../types/gurushots';
import type { IgnoreWords, PickerPhoto, ScoredCandidate } from '../../../types/photoPicker';
import type { FillAttemptParams, RankDeps } from '../../../types/autoFill';
import { errorMessage } from '../../../errorMessage';
import { oneLine } from '../../../format/logSafe';

type VerifiedPick = { picked: string[]; visualEvidence: Set<string> | null };

// Visual re-rank of one ranked block (see services/visionVerifier.ts). The
// picked ids lead the shortlist so a model that abstains returns exactly them;
// the rest of the tag ranking follows as alternatives it may promote.
const rankBlock = async (
    challenge: Challenge,
    scored: ScoredCandidate[],
    eligible: PickerPhoto[],
    picked: string[],
    ignoreWords: IgnoreWords,
    deps: RankDeps,
): Promise<VerifiedPick> => {
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

/**
 * The visual re-rank of a pick. With the user's chosen block it reorders only
 * WITHIN a block — a chosen photo is never swapped for a top-up photo, nor the
 * reverse — and a chosen block no larger than the slots it fills has nothing to
 * choose between, so it is left alone and costs no model run. The rest block
 * keeps the usual re-rank, as does an empty chosen set (the same as no list).
 */
const verifyFillPick = async (
    challenge: Challenge,
    scored: ScoredCandidate[],
    eligible: PickerPhoto[],
    picked: string[],
    ignoreWords: IgnoreWords,
    deps: RankDeps,
    chosenIds: ReadonlySet<string> | null = null,
): Promise<VerifiedPick> => {
    if (!chosenIds || chosenIds.size === 0) return rankBlock(challenge, scored, eligible, picked, ignoreWords, deps);
    const blocks = splitByChosen(scored, chosenIds);
    const results: VerifiedPick[] = [];
    for (const [block, isChosen] of [
        [blocks.chosen, true],
        [blocks.rest, false],
    ] as const) {
        const blockPicked = picked.filter((id) => chosenIds.has(String(id)) === isChosen);
        results.push(
            blockPicked.length === 0 || (isChosen && block.length <= blockPicked.length)
                ? { picked: blockPicked, visualEvidence: null }
                : await rankBlock(challenge, block, eligible, blockPicked, ignoreWords, deps),
        );
    }
    const evidence = results.flatMap((result) => (result.visualEvidence ? [...result.visualEvidence] : []));
    return {
        picked: results.flatMap((result) => result.picked),
        visualEvidence: results.some((result) => result.visualEvidence) ? new Set(evidence) : null,
    };
};

/**
 * Persist weak subject evidence only after a photo was actually submitted.
 * A photo the user chose is never marked: they picked it on purpose, so
 * automatic Boost/Turbo must not skip it as a doubtful theme match.
 */
const recordUncertainSubmission = ({
    challenge,
    label,
    scored,
    picked,
    visualEvidence,
    ignoreWords,
    chosenIds,
    deps,
}: Pick<FillAttemptParams, 'challenge' | 'label' | 'deps'> & {
    scored: ScoredCandidate[];
    picked: string[];
    visualEvidence: Set<string> | null;
    ignoreWords: IgnoreWords;
    chosenIds: ReadonlySet<string> | null;
}) => {
    if (label === 'manualFill' || !deps.entryAges || readChallengeTheme(challenge, ignoreWords).kind === 'open') return;
    const subjectWords = visualEvidence ? [] : buildThemeKeywords(challenge, ignoreWords);
    for (const id of picked) {
        const entry = scored.find((candidate) => String(candidate.id) === String(id));
        // Should Include Tags are a user preference, not evidence that the
        // photo depicts the challenge subject.
        if (
            !entry ||
            chosenIds?.has(String(id)) ||
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
