/**
 * Photo picker — the people, animal and food label-stem sets: the concepts
 * spelled out stem by stem because the vision labels on a photo rarely say
 * "human" or "animal", plus the guard variants the description-conflict check
 * reads.
 */

import { stem } from './stemming';

// "No People" / "No Humans" is by far the commonest negated brief, and the
// vision labels on a photo of a person rarely say "human": they say "Man",
// "Girl", "Portrait", "Crowd". The word-vector lexicon cannot stand in here —
// measured against "humans" it rates "Animal" (0.54) and "Nature" (0.50) above
// the match floor while "Man" (0.44), "Woman" (0.41) and "Crowd" (0.10) fall
// under it — so the people concept is spelled out. Compared by EXACT stem, not
// matches(): the prefix branch would let "man" catch "mango"/"mane".
const PEOPLE_LABEL_STEMS = new Set(
    [
        'human',
        'person',
        'people',
        'man',
        'men',
        'woman',
        'women',
        'child',
        'children',
        'kid',
        'boy',
        'girl',
        'baby',
        'toddler',
        'teen',
        'teenager',
        'adult',
        'face',
        'portrait',
        'selfie',
        'crowd',
        'bride',
        'groom',
        'family',
        'couple',
        'lady',
        'gentleman',
        'pedestrian',
        'tourist',
    ].map((w) => stem(w)),
);
// The conflict guard's people set. The photo-type words "portrait", "face" and
// "selfie" name how a photo is framed, not that a person is in it — a photo of
// a pet can be a portrait — so a title holding one is not asking for people and
// must not cancel a description's "no people".
const PHOTO_TYPE_STEMS = new Set(['portrait', 'face', 'selfie'].map((w) => stem(w)));
const PEOPLE_GUARD_STEMS = new Set([...PEOPLE_LABEL_STEMS].filter((s) => !PHOTO_TYPE_STEMS.has(s)));

// The animal concept, spelled out for the same reason as the people one: the
// vision labels on a photo of an animal rarely say "animal" — they say "Dog",
// "Wildlife". Compared by EXACT stem, not matches(): "cat" must not catch
// "catamaran". Deliberately left out are the words that name an object as often
// as an animal — "bear" (teddy bear), "duck" (rubber duck), "mouse" (computer
// mouse), "seal" (wax seal), "feather", "fur", "fin" (quill, coat, surfboard),
// "wing" (aircraft) — dropping them would keep those photos out of still-life
// and machine challenges. The generic taxonomy labels "mammal" and "vertebrate"
// are left out too: some vision labellers put them on photos of people, so
// "no animals" could drop a portrait.
//
// SCOPE: these sets only drop photos from automatic picks, by the photo's
// existing labels. They must never grow into attributes of people (age,
// gender, ethnicity).
const ANIMAL_LABEL_STEMS = new Set(
    [
        'animal',
        'pet',
        'dog',
        'puppy',
        'cat',
        'kitten',
        'bird',
        'fish',
        'horse',
        'pony',
        'cow',
        'cattle',
        'sheep',
        'goat',
        'pig',
        'chicken',
        'insect',
        'butterfly',
        'bee',
        'spider',
        'snake',
        'reptile',
        'lizard',
        'turtle',
        'frog',
        'amphibian',
        'wildlife',
        'fauna',
        'deer',
        'rabbit',
        'squirrel',
        'monkey',
        'elephant',
        'lion',
        'tiger',
        'wolf',
        'fox',
        'whale',
        'dolphin',
        'shark',
        'owl',
        'eagle',
        'parrot',
        'pigeon',
        'gull',
        'seagull',
        'swan',
        'beak',
        'snout',
        'paw',
        'whiskers',
    ].map((w) => stem(w)),
);
// The conflict guard's animal set: the label set above plus the taxonomy words
// it left out, which a title may legitimately ask for ("Wild Mammals") even
// though they must not match a photo's labels.
const ANIMAL_GUARD_STEMS = new Set([...ANIMAL_LABEL_STEMS, ...['mammal', 'vertebrate'].map((w) => stem(w))]);
// A photo labelled as food does not count as showing an animal: fish, poultry
// or game on a table is classic still life. The exemption applies to the
// animal concept only, never to people.
const FOOD_LABEL_STEMS = new Set(
    ['food', 'dish', 'seafood', 'cuisine', 'ingredient', 'meat', 'meal', 'recipe'].map((w) => stem(w)),
);
// The head nouns that turn a negated TITLE ("No Animals", "No Pets") into the
// whole animal concept, the way any people word turns a negated title into the
// people concept. A specific animal ("Cats: No Dogs") stays stems-only, so the
// cats keep their challenge.
const ANIMAL_HEAD_NOUNS = new Set(['animal', 'pet'].map((w) => stem(w)));

export {
    PEOPLE_LABEL_STEMS,
    PEOPLE_GUARD_STEMS,
    ANIMAL_LABEL_STEMS,
    ANIMAL_GUARD_STEMS,
    FOOD_LABEL_STEMS,
    ANIMAL_HEAD_NOUNS,
};
