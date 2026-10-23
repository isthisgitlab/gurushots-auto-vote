/**
 * Photo picker — the photography stopword list and the fixed subject phrases:
 * the boilerplate words tokenise() strips from challenge text, and "Still
 * Life", which survives the strip whole.
 */

const STOPWORDS = new Set([
    // Articles, prepositions, conjunctions, copulas
    'in',
    'of',
    'the',
    'a',
    'an',
    'and',
    'or',
    'vs',
    'versus',
    'with',
    'on',
    'for',
    'to',
    'at',
    'from',
    'by',
    'about',
    'as',
    'if',
    'so',
    'no',
    'not',
    'is',
    'it',
    'this',
    'that',
    'these',
    'those',
    // Pronouns
    'my',
    'me',
    'mine',
    'we',
    'us',
    'our',
    'ours',
    'you',
    'your',
    'yours',
    'he',
    'she',
    'they',
    'them',
    'their',
    // Auxiliary verbs
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'should',
    'could',
    'can',
    // Quantifiers
    'all',
    'any',
    'some',
    'more',
    'most',
    'less',
    'few',
    'many',
    'much',
    // Photography / GuruShots vocabulary that doesn't help match labels
    'shots',
    'shot',
    'photo',
    'photos',
    'photography',
    'photographer',
    'image',
    'images',
    'picture',
    'pictures',
    'pic',
    'pics',
    'gurushots',
    'challenge',
    'challenges',
    'contest',
    'contests',
    // Reward / level copy from welcome messages
    'reward',
    'rewards',
    'prize',
    'prizes',
    'win',
    'wins',
    'winner',
    'winners',
    'level',
    'levels',
    'badge',
    'badges',
    'point',
    'points',
    'coin',
    'coins',
    'allstar',
    'elite',
    'premier',
    'popular',
    'skilled',
    'guru',
    'gurus',
    'earn',
    'earns',
    'earned',
    'earning',
    'participation',
    'participate',
    // Recurring-award / cadence words. "Photographer of the Week", "Guru of The
    // Week" name a CONTEST PERIOD, never a visual subject, and left in they are
    // the whole theme — a challenge whose only keyword is "week" scores random
    // photos at 0.48 purely on vector noise, which then outranks the user's own
    // best photo on a challenge nothing can legitimately match.
    'week',
    'weekly',
    'month',
    'monthly',
    'year',
    'yearly',
    'daily',
    // Welcome-message boilerplate verbs
    'capture',
    'captured',
    'capturing',
    'submit',
    'submitted',
    'submission',
    'enter',
    'entered',
    'entering',
    'entry',
    'entries',
    'join',
    'joined',
    'joining',
    // Title-imperative verbs ("Let's See Hats", "Show us your...",
    // "Share your best..."). These carry no subject signal and would
    // otherwise leak into the keyword scorer and the derived search terms.
    'let',
    'lets',
    'see',
    'seen',
    'show',
    'shows',
    'showing',
    'shown',
    'share',
    'shares',
    'sharing',
    'shared',
    // "Using Reflections" is about reflections; the description repeating
    // "using" must not confirm it as the subject (see readChallengeTheme).
    'using',
    // Welcome-message boilerplate adjectives / fillers
    'good',
    'luck',
    'great',
    'best',
    'better',
    'nice',
    // Abstract head-nouns. These are real nouns, but they name no visual
    // subject — in a title the MODIFIER carries all the signal and the head
    // noun carries none ("The Farm Life" is about farms; "Sea Life" is about
    // the sea). Left in, "life" would both drive a server-side search that
    // pulls in sea-life photos for a Farm Life challenge AND score those photos
    // as a keyword match. "Still Life" is the one exception: the pair names a
    // genre, and FIXED_PHRASES below merges it back into one term before this
    // filter runs.
    //
    // Only the challenge side strips these (tokenise filters before it stems,
    // so entries are raw words). A user who TYPES "sea life" as a tag means it
    // literally, and tokeniseTagList / label tokenisation both pass
    // keepStopwords:true to honour that.
    //
    // NOT included: "mood", "style", "vibe". They are weaker cases than the
    // above and stripping them would break the legitimate niche challenge
    // whose entire subject is that word (see the "Mood" case in
    // tests/services/photoPicker.test.ts).
    'life',
    'lives',
    'living',
    'world',
    'worlds',
    'time',
    'times',
    'moment',
    'moments',
    'thing',
    'things',
    'day',
    'days',
    'story',
    'stories',
    'tale',
    'tales',
]);

// Phrases that are ONE subject term even though their head noun is a stopword
// above: "Still Life" names a genre, and stripping "life" leaves "still" to
// stand for the whole thing. Merging keeps the "Farm Life" / "Sea Life" strip
// intact for every other title while the phrase survives whole — into
// the keywords, the theme, the search terms and the vision prompt. The merged
// token has no lexicon vector and no longer matches a bare "Still" label or
// tag, which is the point.
//
// The pair is merged across punctuation too ("hold it still. Life is…"), and
// prose like that does falsely merge — accepted: challenge text rarely quotes
// prose, and the cost there is one extra keyword, not a flipped subject.
//
// Single-word ignore words ("still" or "life" in a user's ignore list) keep
// the pair from merging — see the ignore rules in the walk below. Lookups are
// exact Map.get hits against this list, never a regex built from it: the text
// is untrusted API data, and the walk runs on input already cut to
// MAX_TOKENISE_CHARS.
const FIXED_PHRASES: Map<string, string> = new Map([
    ['still life', 'still life'],
    ['still lifes', 'still life'],
    ['still lives', 'still life'],
    ['stilllife', 'still life'],
]);

export { STOPWORDS, FIXED_PHRASES };
