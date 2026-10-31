/**
 * Benchmark-challenge formatting shared by the detailed card and the CLI status: the ranking
 * total's benchmark rows — the server sends `[{ benchmark: "1" | "10" | "100", score: "<votes>" }]`,
 * where `score` is the vote count AT that rank — parsed to integers, and the gap of votes still
 * needed to PASS it. Every field is read from a server payload, so each one is checked and a
 * malformed one shows nothing.
 */

/** One benchmark row of a ranking total, as the API types it. */
type BenchmarkRow = { benchmark?: string; score?: string };

/** The benchmark groups a ranking total carries, keyed by their rank; a group with no readable score is absent. */
type BenchmarkScores = { 1?: number; 10?: number; 100?: number };

/**
 * The benchmark scores of a ranking total as integers, keyed 1 / 10 / 100. A row the server left
 * blank or garbled — or a group nothing reads — drops out. Number('') is 0, so a blank score is
 * read as unreadable, not zero.
 */
const parseBenchmarkScores = (rows: BenchmarkRow[] | undefined): BenchmarkScores => {
    const scores: BenchmarkScores = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        const group = String(row?.benchmark ?? '').trim();
        if (group !== '1' && group !== '10' && group !== '100') continue;
        const scoreText = String(row?.score ?? '').trim();
        const score = scoreText === '' ? Number.NaN : Number(scoreText);
        if (!Number.isInteger(score)) continue;
        scores[Number(group) as 1 | 10 | 100] = score;
    }
    return scores;
};

/**
 * The benchmark group a rank sits under: the top 100 while the rank sits outside it, else the next
 * closer group (a rank of 10 or better chases "1", of 100 or better "10"). Rank 1 has none.
 */
const benchmarkTarget = (rank: number): 1 | 10 | 100 | null =>
    rank > 100 ? 100 : rank > 10 ? 10 : rank > 1 ? 1 : null;

/**
 * The gap under the benchmark scores: to the group `benchmarkTarget` names, where the score is the
 * vote count AT that rank — so the gap counts the votes needed to PASS it, `score − votes + 1`.
 * No gap at rank 1, none once the votes are already past the score, none when the row was unreadable.
 */
const benchmarkGap = (
    rank: number,
    votes: number,
    scores: BenchmarkScores,
): { target: 1 | 10 | 100; n: number } | null => {
    const target = benchmarkTarget(rank);
    if (target === null) return null;
    const score = scores[target];
    if (score === undefined) return null;
    const n = score - votes + 1;
    return n > 0 ? { target, n } : null;
};

export { benchmarkGap, benchmarkTarget, parseBenchmarkScores };
