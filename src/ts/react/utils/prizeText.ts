/**
 * Prize text for the challenge surfaces: the translated name of a prize's type
 * and a tier's prizes as one line. Pure display helpers over the wire shape
 * (the discoverCost.ts pattern), shared by the detailed card's prize tiers and
 * the Discover row's prize summary.
 */

import type { Translate } from '../../translations/translator';

import type { Prize } from '../../types/gurushots';

/** The translated name of a prize's type; a type GuruShots starts sending is never shown as its raw code. */
const prizeTypeName = (type: string | undefined, t: Translate): string => {
    switch (type) {
        case 'KEY':
            return t('app.prizeKey');
        case 'COINS':
            return t('app.prizeCoins');
        case 'PHOTO_SWAP':
            return t('app.prizePhotoSwap');
        case 'EXPOSURE_AUTOFILL':
            return t('app.prizeExposureAutofill');
        default:
            return t('app.prizeUnknown');
    }
};

/**
 * One tier's prizes as "Key × 1, Coins × 250". The name of a prize the server carries without an
 * amount stands alone.
 */
const prizeItemsText = (prizes: ReadonlyArray<Prize>, t: Translate): string =>
    prizes
        .map((prize) => {
            const name = prizeTypeName(prize.type, t);
            return typeof prize.amount === 'number' && Number.isFinite(prize.amount)
                ? t('app.prizeAmount', { name, amount: prize.amount.toLocaleString() })
                : name;
        })
        .filter(Boolean)
        .join(', ');

export { prizeItemsText, prizeTypeName };
