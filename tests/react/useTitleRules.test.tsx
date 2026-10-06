/**
 * useTitleRules — what the rule editor's draft does when every saved chosen-photos list is removed
 * while it is open: a rule that held a list and has nothing else goes, a half-written rule stays.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { useTitleRules } from '@/hooks/useTitleRules';
import { announceChosenPhotosCleared } from '@/api/chosenPhotosCleared';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

test('a rule whose only content was its list is dropped; a half-written rule (list still empty text) is kept', async () => {
    const PHOTO = `00000001${'a'.repeat(24)}`;
    mockApi.getTitleRules.mockResolvedValueOnce(
        invalid([
            { title: 'Lonely', chosenPhotos: [PHOTO] },
            { title: 'Draft', chosenPhotos: '' },
            { title: 'Tagged', mustIncludeTags: ['hat'], chosenPhotos: [PHOTO] },
            { title: 'Plain', mustIncludeTags: ['sea'] },
        ]),
    );
    const { result } = renderHook(() => useTitleRules(true));
    await waitFor(() => expect(result.current.rules).toHaveLength(4));

    act(() => announceChosenPhotosCleared());

    expect(result.current.rules).toEqual([
        { title: 'Draft' },
        { title: 'Tagged', mustIncludeTags: ['hat'] },
        { title: 'Plain', mustIncludeTags: ['sea'] },
    ]);
});
