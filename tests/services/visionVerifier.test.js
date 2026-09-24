const { selectVisualMatches, themePrompt } = require('../../src/js/services/visionVerifier');

test('a validated Banisters prompt rejects the real motorcycle and beach outliers', () => {
    // Measured on the user's live themed-search shortlist with bundled SigLIP.
    const scored = [
        { id: 'handrail', score: 0.0117948595 },
        { id: 'motorcycle', score: 0.00000001668 },
        { id: 'beach', score: 0.000004933 },
    ];
    expect(selectVisualMatches(scored, 3)).toEqual(['handrail']);
});

test('weak visual evidence stands down, and unvalidated themes keep tag ranking', () => {
    expect(
        selectVisualMatches(
            [
                { id: 'first', score: 0.0002 },
                { id: 'second', score: 0.0001 },
            ],
            1,
        ),
    ).toEqual([]);
    expect(themePrompt({ title: 'Banisters' })).toBe('a photo of a banister or handrail');
    expect(themePrompt({ title: 'Best Meals' })).toBeNull();
    expect(themePrompt({ title: 'Smoke-Filled Scenes' })).toBeNull();
});
