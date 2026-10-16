import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE,
  blockedWordsIn,
  blocklistHash,
  boardProblems,
  buildBoards,
  buildLexicon,
  cleanDefinition,
  collapseDoubles,
  compoundParts,
  definitionGivesAway,
  glossProblem,
  inflections,
  inflectionBases,
  IRREGULAR_FORMS,
  latinRoot,
  leaksMorpheme,
  lemmaMorphemes,
  longestCommonSubstring,
  mentionsWord,
  morphemeLeak,
  namesLatinForm,
  namesOwnWord,
  nearDuplicateDefinitions,
  pastForms,
  sensesTouch,
  sharedContentWords,
  sharedPrefixLength,
  sharesCompoundForm,
  sharesCompoundPart,
  sharesPrefix,
  stem,
  tokenize,
  truncatedDefinition,
  WORD_SOURCES,
  wordRoots,
  type BuildOptions,
  type CluesBoard,
  type CluesExcludeList,
  type OewnData,
  type OewnEntry,
  type OewnSynset,
} from '../../../src/games/clues/data-build.js';
import { BLOCKED_WORD_HASHES } from '../../../src/games/clues/blocklist.js';

describe('tokenize', () => {
  it('lower-cases and splits on anything that is not a-z', () => {
    expect(tokenize('A dog-like (Canis) animal; 2 legs')).toEqual([
      'a',
      'dog',
      'like',
      'canis',
      'animal',
      'legs',
    ]);
  });
});

describe('stem', () => {
  it.each([
    ['dance', 'dancing', 'danced', 'dancer', 'dances'],
    ['happy', 'happily', 'happiness', 'happier', 'happiest'],
    ['run', 'running', 'runs', 'runner'],
    ['stop', 'stopped', 'stopping', 'stops'],
    ['try', 'tries', 'tried'],
    ['box', 'boxes'],
    ['glass', 'glasses'],
    ['play', 'played', 'plays'],
  ])('gives %s and its inflections one stem', (base, ...others) => {
    for (const other of others) expect(stem(other), other).toBe(stem(base));
  });

  it('leaves short words and non-plural -s endings alone', () => {
    expect(stem('sing')).toBe('sing');
    expect(stem('bus')).toBe('bus');
    expect(stem('cactus')).toBe('cactus');
    expect(stem('iris')).toBe('iris');
    expect(stem('forest')).toBe('forest');
  });

  it('keeps doubled finals that belong to the root', () => {
    expect(stem('falling')).toBe('fall');
    expect(stem('buzzing')).toBe('buzz');
  });
});

describe('inflections', () => {
  it('lists regular forms, including e-drop, y-to-i and doubled consonants', () => {
    expect(inflections('dance')).toContain('dancing');
    expect(inflections('cry')).toContain('cried');
    expect(inflections('cry')).toContain('cries');
    expect(inflections('stop')).toContain('stopped');
    expect(inflections('stop')).toContain('stopping');
    expect(inflections('dog')).toContain('dogs');
  });
});

describe('mentionsWord', () => {
  it('finds the word and its inflections at word boundaries', () => {
    expect(mentionsWord('a large dog', 'dog')).toBe(true);
    expect(mentionsWord('kept as dogs', 'dog')).toBe(true);
    expect(mentionsWord('the act of dancing', 'dance')).toBe(true);
    expect(mentionsWord('one who runs', 'runner')).toBe(true);
    expect(mentionsWord('worse than a tried plan', 'try')).toBe(true);
  });

  it('finds hyphen-split and compound words built on the lemma', () => {
    expect(mentionsWord('a dog-like animal', 'dog')).toBe(true);
    expect(mentionsWord('a small boathouse', 'boat')).toBe(true);
    expect(mentionsWord('a small steamboat', 'boat')).toBe(true);
  });

  it('uses listed forms for irregular inflections', () => {
    expect(mentionsWord('the man ran away', 'run')).toBe(false);
    expect(mentionsWord('the man ran away', 'run', ['ran'])).toBe(true);
    expect(mentionsWord('a flock of geese', 'goose', ['geese'])).toBe(true);
  });

  it('does not match inside unrelated words', () => {
    expect(mentionsWord('a cathedral in the city', 'cat')).toBe(false);
    expect(mentionsWord('a scattered crowd', 'cat')).toBe(false);
    expect(mentionsWord('a long story', 'tor')).toBe(false);
    expect(mentionsWord('a tree of the forest', 'for')).toBe(false);
  });
});

describe('sharesCompoundPart', () => {
  it('flags a definition that holds half of a compound answer', () => {
    expect(sharesCompoundPart('a bill shaped like a spoon', 'spoonbill')).toBe(true);
    expect(sharesCompoundPart('a shop where books are sold', 'bookstore')).toBe(true);
  });

  it('ignores short pieces and unrelated words', () => {
    expect(sharesCompoundPart('a pot for tea', 'teapot')).toBe(false);
    expect(sharesCompoundPart('a large wading bird', 'flamingo')).toBe(false);
  });
});

describe('sharesCompoundForm', () => {
  it('finds compound parts the stemmer cuts short or respells', () => {
    // stem("fires") is "fir", but "fires" shares "fire" with the start of "fireman".
    expect(sharesCompoundPart('a laborer who tends fires', 'fireman')).toBe(false);
    expect(sharesCompoundForm('a laborer who tends fires', 'fireman')).toBe(true);
    expect(sharesCompoundForm('as on a coal-fired train', 'fireman')).toBe(true);
    expect(sharesCompoundForm('red or black edible berries', 'raspberry')).toBe(true);
    expect(sharesCompoundForm('a fabric with very thin stripes', 'pinstripe')).toBe(true);
    expect(sharesCompoundForm('free from clouds', 'unclouded')).toBe(true);
  });

  it('keeps three-letter parts and unrelated words out', () => {
    expect(sharesCompoundForm('a pot for tea', 'teapot')).toBe(false);
    expect(sharesCompoundForm('a stand of firs on a hill', 'fireman')).toBe(false);
    expect(sharesCompoundForm('a large wading bird', 'flamingo')).toBe(false);
  });
});

describe('sharesPrefix', () => {
  it('needs five shared letters, four for lemmas of five letters or fewer', () => {
    expect(sharedPrefixLength('architecture')).toBe(5);
    expect(sharedPrefixLength('shaker')).toBe(5);
    expect(sharedPrefixLength('viola')).toBe(4);
    expect(sharedPrefixLength('wren')).toBe(4);
    expect(sharedPrefixLength('eel')).toBe(4);
  });

  it('catches derived forms that start like the word', () => {
    expect(sharesPrefix('an architectural product or work', 'architecture')).toBe(true);
    expect(sharesPrefix('a container in which something can be shaken', 'shaker')).toBe(true);
    expect(sharesPrefix('removes dust by electrostatic precipitation', 'precipitator')).toBe(true);
    expect(sharesPrefix('a terrestrial orchid with fleshy tubers', 'orchis')).toBe(true);
    expect(sharesPrefix('a stringed instrument slightly larger than a violin', 'viola')).toBe(true);
  });

  it('catches Latin genus and family forms, comparing with doubled letters collapsed', () => {
    expect(collapseDoubles('albizzia')).toBe('albizia');
    expect(sharesPrefix('any of numerous plants of the family Geraniaceae', 'geranium')).toBe(true);
    expect(sharesPrefix('any of numerous trees of the genus Albizia', 'albizzia')).toBe(true);
    expect(sharesPrefix('any plant of the genus Lupinus', 'lupine')).toBe(true);
    expect(sharesPrefix('a vine of the genus Bryonia', 'bryony')).toBe(true);
    // As written, "cassava" and "Casava" share only "cas"; collapsed, they match.
    expect(sharesPrefix('a plant of the genus Casava', 'cassava')).toBe(true);
    expect(sharesPrefix('a plant sold at the casino', 'cassava')).toBe(false);
  });

  it('leaves words that only share a short start alone', () => {
    expect(sharesPrefix('a small swift bird', 'wren')).toBe(false);
    expect(sharesPrefix('a bird that wades in shallow water', 'shaker')).toBe(false);
    expect(sharesPrefix('the art of designing buildings', 'architecture')).toBe(false);
    expect(sharesPrefix('a tree of the forest', 'for')).toBe(false);
  });
});

describe('namesLatinForm', () => {
  it('matches a capitalised genus or family name, or an -aceous adjective, by its root', () => {
    expect(latinRoot('Thymus')).toBe('thym');
    expect(latinRoot('thyme')).toBe('thym');
    expect(latinRoot('Geraniaceae')).toBe('gerani');
    expect(namesLatinForm('any of various mints of the genus Thymus', 'thyme')).toBe(true);
    expect(namesLatinForm('a shrub of the genus Rosa', 'rose')).toBe(true);
    expect(namesLatinForm('any liliaceous plant', 'lily')).toBe(true);
    expect(namesLatinForm('any plant of the genus Lilium', 'lily')).toBe(true);
    expect(namesLatinForm('any of numerous plants of the family Geraniaceae', 'geranium')).toBe(
      true,
    );
    expect(namesLatinForm('any of numerous trees of the genus Albizia', 'albizzia')).toBe(true);
  });

  it('ignores lower-case words and unrelated names', () => {
    expect(namesLatinForm('a thymus gland', 'thyme')).toBe(false);
    expect(namesLatinForm('a shrub of the genus Berberis', 'thyme')).toBe(false);
    expect(namesLatinForm('a small bird of North America', 'wren')).toBe(false);
  });
});

describe('definitionGivesAway', () => {
  it('combines the word, its forms and compound parts', () => {
    expect(definitionGivesAway('not washed', 'unwashed')).toBe(true);
    expect(definitionGivesAway('that stimulates', 'stimulant', ['stimulate'])).toBe(true);
    expect(definitionGivesAway('a small swift bird', 'wren')).toBe(false);
  });

  it.each([
    ['architecture', 'an architectural product or work'],
    ['shaker', 'a container in which something can be shaken'],
    ['fireman', 'a male laborer who tends fires (as on a coal-fired train or steamship)'],
    ['precipitator', 'removes dust particles from gases by electrostatic precipitation'],
    ['geranium', 'any of numerous plants of the family Geraniaceae'],
    ['albizzia', 'any of numerous trees of the genus Albizia'],
    ['lupine', 'any plant of the genus Lupinus; bearing erect spikes of flowers'],
    ['bryony', 'a vine of the genus Bryonia having large leaves and small flowers'],
    ['orchis', 'any of various deciduous terrestrial orchids having fleshy tubers'],
    ['thyme', 'any of various mints of the genus Thymus'],
    ['viola', 'a bowed stringed instrument slightly larger than a violin'],
  ])('rejects %s defined as "%s"', (lemma, definition) => {
    expect(definitionGivesAway(definition, lemma)).toBe(true);
  });

  it('is wider than namesOwnWord, the test the draft applies', () => {
    expect(namesOwnWord('an architectural product or work', 'architecture')).toBe(false);
    expect(namesOwnWord('a male laborer who tends fires', 'fireman')).toBe(false);
    expect(namesOwnWord('not washed', 'unwashed')).toBe(true);
  });

  it('lets clean definitions through', () => {
    expect(definitionGivesAway('the art of designing buildings', 'architecture')).toBe(false);
    expect(definitionGivesAway('a garden plant with showy flowers', 'geranium')).toBe(false);
    expect(definitionGivesAway('a member of a crew that puts out blazes', 'fireman')).toBe(false);
  });
});

describe('give-away rule v3: morphemes', () => {
  /** A stand-in for OEWN's single-word lemmas, the dictionary compound parts come from. */
  const WORDS = new Set(
    (
      'a b f re bar tender room bay berry rum wind fall dew black blue cotton wood bass beef hard ' +
      'pot herb tin plate mover move type writer lea pro rig flea brig huckleberry bur dock ' +
      'script manus character man kind bell fry chill blain'
    ).split(' '),
  );
  const context = { isWord: (w: string) => WORDS.has(w) };
  /** The give-away test before v3: what the round-3 boards passed. */
  const v2 = (definition: string, lemma: string) =>
    namesOwnWord(definition, lemma) ||
    sharesCompoundForm(definition, lemma) ||
    sharesPrefix(definition, lemma) ||
    namesLatinForm(definition, lemma);

  it.each([
    ['tin', 'a vessel (box, can, pan, etc.) made of tinplate and used mainly in baking'],
    ['pub', 'tavern consisting of a building with a bar and public rooms'],
    ['bartender', 'an employee who mixes and serves alcoholic drinks at a bar'],
    ['bayberry', 'West Indian tree; source of bay rum'],
    ['windfall', 'fruit that has fallen from the tree'],
    ['dewberry', 'blackberry-like fruits of any of several trailing blackberry bushes'],
    ['huckleberry', 'any of various dark-fruited as distinguished from blue-fruited blueberries'],
    ['cottonwood', 'American basswood of the Allegheny region'],
    ['beefwood', 'a tropical hardwood tree yielding balata gum and heavy red timber'],
    ['melon', 'any of various fruit of cucurbitaceous vines including: muskmelons, watermelons'],
    ['sociology', 'the study and classification of human societies'],
    ['cosmography', 'maps the universe (but without encroaching on geography or astronomy)'],
    ['splatter', 'the noise of something spattering or sputtering explosively'],
    ['potherb', 'any of various herbaceous plants whose leaves are cooked and used for food'],
    ['trefoil', 'herbs of the genus Medicago having small flowers and trifoliate compound leaves'],
    ['japonica', 'deciduous thorny shrub native to Japan having red blossoms'],
    ['sang', 'North American woodland herb used as substitute for the Chinese ginseng'],
    ['bionics', 'application of biological principles to the study of engineering systems'],
    ['bionics', 'the design of engineering systems (especially electronic systems)'],
    ['avionics', 'science and technology of electronic systems and devices for aeronautics'],
    ['tectonics', 'the science of architecture'],
    ['teaching', 'a doctrine that is taught'],
    ['typist', 'someone paid to operate a typewriter', ['type']],
    ['remover', 'someone who works for a company that moves furniture'],
    ['embassy', 'a diplomatic building where ambassadors live or work'],
    ['primrose', 'any of numerous short-stemmed plants of the genus Primula'],
    [
      'naturalism',
      'the doctrine that the world can be understood without supernatural explanations',
    ],
    ['caper', 'any of numerous plants of the genus Capparis'],
    ['lit', 'the humanistic study of a body of literature'],
    [
      'burdock',
      'any of several erect biennial herbs of temperate Eurasia having stout taproots and ' +
        'producing burs',
    ],
    // Found by the audit of the v3 rebuild: a root with a doubled letter (lott: lot), a -th
    // noun's root plus one letter (slo: slow) and a compound part of a definition word that
    // starts like the word (manu + script: scribe).
    ['lottery', 'players buy (or are given) chances and prizes are distributed by casting lots'],
    ['sloth', 'any of several slow-moving arboreal mammals of South America and Central America'],
    ['scribe', 'someone employed to make written copies of documents and manuscripts'],
    // A 3-letter compound part at the end of a word (hu + man), and a compound that drops a
    // doubled letter at the joint (bel(l) + fry).
    ['mankind', 'all of the living human inhabitants of the earth'],
    ['belfry', 'a room (often at the top of a tower) where bells are hung'],
  ])(
    'catches %s defined as "%s", which the earlier test let through',
    (lemma, definition, forms = []) => {
      expect(v2(definition, lemma)).toBe(false);
      expect(definitionGivesAway(definition, lemma, forms, context)).toBe(true);
    },
  );

  it('splits a compound into dictionary words, only where it is a real compound', () => {
    expect(compoundParts('bayberry', context.isWord)).toEqual(['bay', 'berry']);
    expect(compoundParts('windfall', context.isWord)).toEqual(['fall', 'wind']);
    expect(compoundParts('bartender', context.isWord)).toEqual(['bar', 'tender']);
    // "huckle" isn't a word, but a 5-letter part counts whatever is left; "re" + "mover".
    expect(compoundParts('huckleberry', context.isWord)).toEqual(['berry']);
    expect(compoundParts('remover', context.isWord)).toEqual(['mover']);
    // Short parts need a word on the other side: not "lea" in flea, "rig" in brig, "pro" alone.
    expect(compoundParts('flea', context.isWord)).toEqual([]);
    expect(compoundParts('brig', context.isWord)).toEqual([]);
    expect(compoundParts('projectile', context.isWord)).toEqual([]);
    // A start piece that drops a doubled letter at the joint gives the whole word.
    expect(compoundParts('belfry', context.isWord)).toEqual(['bell', 'fry']);
    expect(compoundParts('chilblain', context.isWord)).toEqual(['blain', 'chill']);
  });

  it('strips common suffixes to roots, inflections only once', () => {
    expect(wordRoots('teaching')).toEqual(['teach']);
    expect(wordRoots('sociology')).toEqual(expect.arrayContaining(['soci', 'socio']));
    expect(wordRoots('cosmography')).toEqual(expect.arrayContaining(['cosm', 'cosmo']));
    expect(wordRoots('tectonics')).toEqual(['tect', 'tecton', 'tectonic']);
    expect(wordRoots('naturalism')).toEqual(['natur', 'natural']);
    expect(wordRoots('chess')).toEqual(['ches']);
    expect(wordRoots('typist')).toEqual(['typ']);
  });

  it('undoes a doubled final letter on a root, and strips the -th of a noun', () => {
    expect(wordRoots('lottery')).toEqual(expect.arrayContaining(['lot', 'lott', 'lotter']));
    expect(wordRoots('swimmer')).toEqual(['swim', 'swimm']);
    // Not where the double belongs to the root, as in the stemmer (sell, not sel).
    expect(wordRoots('seller')).toEqual(['sell']);
    expect(wordRoots('sloth')).toEqual(['slo']);
    expect(wordRoots('growth')).toEqual(['grow']);
  });

  it('gathers the lemma, its sources, compound parts and roots as morphemes', () => {
    expect(lemmaMorphemes('bartender', context.isWord)).toEqual(
      expect.arrayContaining(['bar', 'bartend', 'bartender', 'tend', 'tender']),
    );
    expect(lemmaMorphemes('sang')).toEqual(expect.arrayContaining(['ginseng', 'sang']));
    expect(WORD_SOURCES.avionics).toEqual(['aviation', 'electronics']);
    // No stopwords: "over" in remover.
    expect(
      lemmaMorphemes('remover', (w) => ['rem', 'over', 'mover', 're'].includes(w)),
    ).not.toContain('over');
  });

  it('applies tests (a) to (e) to a definition word and a morpheme', () => {
    expect(morphemeLeak('herbaceous', 'herb')).toBe('a');
    expect(morphemeLeak('wind', 'windfall')).toBe('b');
    expect(morphemeLeak('societies', 'socio')).toBe('c');
    expect(morphemeLeak('spattering', 'splatter')).toBe('d');
    expect(morphemeLeak('trifoliate', 'trefoil')).toBe('e');
    expect(morphemeLeak('japan', 'japonica')).toBe('e');
    expect(longestCommonSubstring('spattering', 'splatter')).toBe(5);
  });

  it('applies test (f) to the compound parts of a definition word, given the dictionary', () => {
    // manuscript: manu + script, and script starts like scribe.
    expect(morphemeLeak('manuscript', 'scribe', context.isWord)).toBe('f');
    expect(morphemeLeak('manuscript', 'scribe')).toBeNull();
    // "arac" sits inside characterized, but no part of it starts that way.
    expect(morphemeLeak('characterized', 'arachnid', context.isWord)).toBeNull();
  });

  it('matches a 3-letter morpheme only as a whole word, a form of it or a compound start', () => {
    expect(morphemeLeak('bar', 'bar', context.isWord)).toBe('a');
    expect(morphemeLeak('bars', 'bar', context.isWord)).toBe('a');
    // The word plus one letter: a root that lost a letter (slow: sloth, type: typist).
    expect(morphemeLeak('slow', 'slo', context.isWord)).toBe('a');
    expect(morphemeLeak('type', 'typ', context.isWord)).toBe('a');
    expect(morphemeLeak('barred', 'bar', context.isWord)).toBe('a');
    expect(morphemeLeak('barroom', 'bar', context.isWord)).toBe('a');
    expect(morphemeLeak('barely', 'bar', context.isWord)).toBeNull();
    expect(morphemeLeak('embark', 'bar', context.isWord)).toBeNull();
    expect(definitionGivesAway('a drink served in a barroom', 'bartender', [], context)).toBe(true);
    // A 3-letter compound part counts at the end of a word too, never inside one.
    expect(definitionGivesAway('a bent tool like a crowbar', 'bartender', [], context)).toBe(true);
    expect(definitionGivesAway('the human race', 'mankind', [], context)).toBe(true);
    expect(definitionGivesAway('a humane people', 'mankind', [], context)).toBe(false);
    expect(definitionGivesAway('one who barely speaks', 'bartender', [], context)).toBe(false);
    expect(definitionGivesAway('passengers who embark at a port', 'bartender', [], context)).toBe(
      false,
    );
  });

  it('finds irregular forms of a root, from the hand list or the dictionary', () => {
    expect(IRREGULAR_FORMS.teach).toEqual(['taught']);
    expect(leaksMorpheme('a doctrine that is taught', 'teaching')).toBe(true);
    expect(leaksMorpheme('a person who wrote books', 'writer')).toBe(true);
    expect(leaksMorpheme('one who swam the channel', 'swimmer')).toBe(true);
    // A form only OEWN lists ("cleft" for cleave) counts through `formsOf`. ("clove" starts like
    // cleaver once vowels count as one letter, test (e).)
    expect(leaksMorpheme('a tool that cleft the meat', 'cleaver')).toBe(false);
    expect(
      leaksMorpheme('a tool that cleft the meat', 'cleaver', [], {
        formsOf: (w) => (w === 'cleave' ? ['clove', 'cleft'] : []),
      }),
    ).toBe(true);
    expect(morphemeLeak('clove', 'cleaver')).toBe('e');
  });

  it('counts derived forms by tests (a) to (c) only, so shared suffixes do not trip', () => {
    // "ethical" and "philosophical" share "hical", a suffix, not a root.
    expect(leaksMorpheme('the philosophical study of moral values', 'ethics', ['ethical'])).toBe(
      false,
    );
    expect(leaksMorpheme('rules of ethical conduct', 'ethics', ['ethical'])).toBe(true);
  });

  it.each([
    ['bartender', 'an employee who mixes and serves drinks; barely a profession'],
    ['bartender', 'someone who must embark on a long shift'],
    ['cottonwood', 'a tall tree of the eastern United States with heart-shaped leaves'],
    ['windfall', 'a sudden piece of good luck'],
    ['sociology', 'the study of how people live together in groups'],
    ['flea', 'any wingless bloodsucking parasitic insect noted for ability to leap'],
    ['brig', 'two-masted sailing vessel square-rigged on both masts'],
    ['projectile', 'any vehicle self-propelled by a rocket engine'],
    ['tin', 'a metal container with a lid for spices'],
    ['pub', 'a tavern that serves beer and other drinks to the people of a town'],
    [
      'melon',
      'any of numerous fruits of the gourd family having a hard rind and sweet juicy flesh',
    ],
    ['huckleberry', 'blue-black fruit of any of several American shrubs'],
    // Board glosses that share letters, not a root, with their word.
    [
      'caltrop',
      'tropical annual procumbent poisonous subshrub having fruit that splits into five spiny ' +
        'nutlets; serious pasture weed',
    ],
    ['arachnid', 'air-breathing arthropods characterized by simple eyes and four pairs of legs'],
    ['sallow', 'any of several Old World shrubby broad-leaved willows having large catkins'],
    ['worsted', 'a tightly twisted woolen yarn spun from long-staple wool'],
    ['tenement', 'a run-down apartment house barely meeting minimal standards'],
    ['undercut', 'the tender meat of the loin muscle on each side of the vertebral column'],
    [
      'eagle',
      'any of various large keen-sighted diurnal birds of prey noted for their broad wings and ' +
        'strong soaring flight',
    ],
  ])('lets %s defined as "%s" through: common words do not trip it', (lemma, definition) => {
    expect(definitionGivesAway(definition, lemma, [], context)).toBe(false);
  });

  it('ignores stopwords in the definition', () => {
    for (const lemma of ['other', 'thermos', 'andiron', 'withers', 'theory']) {
      expect(leaksMorpheme('used with the other and from', lemma, [], context), lemma).toBe(false);
    }
  });

  it('looks up words that name built-in object properties as plain words', () => {
    // A plain-object lookup on "constructor" returned Object's own function and threw.
    for (const lemma of ['constructor', 'toString']) {
      expect(() => lemmaMorphemes(lemma, context.isWord), lemma).not.toThrow();
      expect(leaksMorpheme('a person who builds things', lemma, [], context), lemma).toBe(false);
      expect(definitionGivesAway('a person who builds things', lemma, [], context), lemma).toBe(
        false,
      );
    }
    expect(leaksMorpheme('a large building', 'construction', ['constructor'], context)).toBe(false);
    expect(leaksMorpheme('a large building', 'construction', ['toString'], context)).toBe(false);
  });

  it('tries the stem of a gloss word for a related form when the word itself matched loosely', () => {
    // "gametes" shares a run of six letters with agamete (d, not enough for a related form), but
    // its stem "gamet" is inside it (b).
    expect(morphemeLeak('gametes', 'agamete')).toBe('d');
    expect(morphemeLeak('gamet', 'agamete')).toBe('b');
    const gloss =
      '(of reproduction) not involving the fusion of male and female gametes in reproduction';
    expect(leaksMorpheme(gloss, 'agamic', [])).toBe(false);
    expect(leaksMorpheme(gloss, 'agamic', ['agamete'])).toBe(true);
  });

  it('also reads a run of vowels as one letter in test (e), so "ea" and "a" meet', () => {
    expect(morphemeLeak('phasianidae', 'pheasant')).toBe('e');
    expect(definitionGivesAway('a game bird of the family Phasianidae', 'pheasant')).toBe(true);
    // Not only: "visaal" and "visaan" share five letters, "visal" and "visan" four.
    expect(morphemeLeak('visual', 'vision')).toBe('e');
  });
});

describe('nearDuplicateDefinitions', () => {
  it('catches definitions with nearly the same content words', () => {
    expect(nearDuplicateDefinitions('a small round fruit', 'a round small fruit')).toBe(true);
    expect(nearDuplicateDefinitions('a breed of dog', 'a large breed of hunting dog')).toBe(true);
  });

  it('lets clearly different definitions through', () => {
    expect(nearDuplicateDefinitions('a wind from the east', 'a wind from the west')).toBe(false);
    expect(nearDuplicateDefinitions('a hand tool with a heavy head', 'a seat for one person')).toBe(
      false,
    );
  });
});

describe('truncatedDefinition', () => {
  it('flags a gloss that ends at an example marker', () => {
    expect(truncatedDefinition('of metal e.g.')).toBe(true);
    expect(truncatedDefinition('of metal e.g')).toBe(true);
    expect(truncatedDefinition('as of a surface; i.e.')).toBe(true);
    expect(truncatedDefinition('E.G.')).toBe(true);
  });

  it('lets complete glosses through, including ones with an example marker inside', () => {
    expect(truncatedDefinition('make mention of')).toBe(false);
    expect(truncatedDefinition('a fruit, e.g. an apple')).toBe(false);
    expect(truncatedDefinition('a large wading bird')).toBe(false);
  });
});

describe('cleanDefinition', () => {
  it('tidies spaces and trailing punctuation', () => {
    expect(cleanDefinition('  a  small   bird; ')).toBe('a small bird');
  });
});

describe('boardProblems', () => {
  const board = (defs: [string, string][]): CluesBoard => ({
    id: 'b999',
    pos: 'noun',
    words: defs.map(([lemma, definition], i) => ({
      id: `w${String(i + 1).padStart(2, '0')}`,
      lemma,
      synset: `0000000${String(i)}-n`,
      definition,
    })),
  });

  it('accepts a clean 16-word board', () => {
    const words =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(
        ' ',
      );
    expect(
      boardProblems(board(words.map((w, i) => [w, `definition number ${String(i)}`]))),
    ).toEqual([]);
  });

  it('reports size, duplicates, self-mentions and other-word mentions', () => {
    const problems = boardProblems(
      board([
        ['dog', 'a dog that barks'],
        ['cat', 'chases the dog'],
        ['cat', 'a small animal'],
      ]),
    );
    expect(problems).toContain('b999: 3 words');
    expect(problems).toContain('b999: duplicate lemmas');
    expect(problems).toContain('b999/w01: definition gives away "dog"');
    expect(problems).toContain('b999/w02: definition contains board word "dog"');
  });
});

describe('blocklist', () => {
  it('stores 16-hex-digit hashes, and hashes ignore case', () => {
    for (const h of BLOCKED_WORD_HASHES) expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(blocklistHash('Word')).toBe(blocklistHash('word'));
  });
});

describe('blockedWordsIn', () => {
  const blocked = (w: string) => BLOCKED_WORD_HASHES.has(blocklistHash(w));
  /** Made-up blocked words, so the mechanics can be shown without spelling real ones. */
  const fake = new Set(['kblorp', 'kbluy', 'kbloke', 'louse', 'cow'].map(blocklistHash));
  const fakeBlocked = (w: string) => fake.has(blocklistHash(w));

  it('lists the words a gloss word may be an inflection of', () => {
    expect(inflectionBases('spices')).toEqual(['spic', 'spice']);
    expect(inflectionBases('ponies')).toEqual(['poni', 'ponie', 'pony']);
    expect(inflectionBases('spiced')).toEqual(['spic', 'spice']);
    expect(inflectionBases('spicing')).toEqual(['spic', 'spice']);
    expect(inflectionBases('lice')).toEqual(['louse']);
    expect(inflectionBases('kine', (f) => (f === 'kine' ? ['cow'] : []))).toEqual(['cow']);
  });

  it('flags a blocked word and its inflected forms', () => {
    expect(blockedWordsIn('a band of Gypsies', blocked)).toEqual(['gypsies']);
    expect(blockedWordsIn('kblorp, kblorps and kblorpes', fakeBlocked)).toEqual([
      'kblorp',
      'kblorps',
      'kblorpes',
    ]);
    expect(blockedWordsIn('kbluies, kblorped, kblorping', fakeBlocked)).toEqual([
      'kbluies',
      'kblorped',
      'kblorping',
    ]);
    expect(blockedWordsIn('kbloked and kbloking', fakeBlocked)).toEqual(['kbloked', 'kbloking']);
    // Irregular forms: the hand list always, Wordnet's own lists through `baseOf`.
    expect(blockedWordsIn('covered in lice', fakeBlocked)).toEqual(['lice']);
    expect(blockedWordsIn('a herd of kine', fakeBlocked)).toEqual([]);
    expect(
      blockedWordsIn('a herd of kine', fakeBlocked, {
        baseOf: (f) => (f === 'kine' ? ['cow'] : []),
      }),
    ).toEqual(['kine']);
  });

  it('lets a word through when it or a word it may come from is a dictionary word not blocked', () => {
    // -es leaves a blocked word, but "spices" is a form of spice.
    const isWord = (w: string) => ['spice', 'kblorpe'].includes(w);
    expect(blockedWordsIn('dried spices, spiced and spicing', blocked, { isWord })).toEqual([]);
    expect(blockedWordsIn('dried spices', blocked)).toEqual(['spices']);
    expect(blockedWordsIn('kblorpes', fakeBlocked, { isWord })).toEqual([]);
    // A blocked word itself is always flagged.
    expect(blockedWordsIn('kblorp', fakeBlocked, { isWord: () => true })).toEqual(['kblorp']);
    expect(blockedWordsIn('a clean gloss with plain words', blocked)).toEqual([]);
  });
});

describe('glossProblem', () => {
  /** Stands in for the past forms of OEWN's verbs. */
  const participle = (w: string) => ['cultivated', 'caught', 'considered', 'grown'].includes(w);

  it('rejects the fragments OEWN keeps from Princeton: the differentia without its hypernym', () => {
    expect(glossProblem('cultivated in temperate regions', 'noun', participle)).toBe(
      'gloss: fragment',
    );
    expect(glossProblem('considered best for fruit', 'noun', participle)).toBe('gloss: fragment');
    expect(
      glossProblem('caught along the Atlantic coast of the United States', 'noun', participle),
    ).toBe('gloss: fragment');
    expect(glossProblem('often grown as a house plant', 'noun', participle)).toBe(
      'gloss: fragment',
    );
    expect(glossProblem('native to the hills of southern Spain', 'noun')).toBe('gloss: fragment');
    expect(glossProblem('similar to the giraffe but smaller', 'noun')).toBe('gloss: fragment');
    expect(glossProblem('having a long tail and short legs', 'noun')).toBe('gloss: fragment');
    expect(glossProblem('of flowing waters in the south', 'noun')).toBe('gloss: fragment');
  });

  it('rejects usage notes, register notes and glosses under four words', () => {
    expect(glossProblem('used especially of persons', 'adjective')).toBe('gloss: usage note');
    expect(glossProblem('used of a height or viewpoint', 'adjective')).toBe('gloss: usage note');
    expect(glossProblem('a Scottish word', 'adjective')).toBe('gloss: too short to stand alone');
    expect(glossProblem('an archaic term for a parrot', 'noun')).toBe('gloss: register note');
    expect(glossProblem('informal terms for small dogs', 'noun')).toBe('gloss: register note');
    expect(glossProblem('very small', 'adjective')).toBe('gloss: too short to stand alone');
    expect(glossProblem('take by theft', 'verb')).toBe('gloss: too short to stand alone');
  });

  it('sets a leading qualifier in parentheses aside before judging the rest', () => {
    expect(glossProblem('(of persons) lacking in refinement or grace', 'adjective')).toBeNull();
    expect(glossProblem('(of behavior) rustic and uncouth', 'adjective')).toBe(
      'gloss: too short to stand alone',
    );
    expect(glossProblem('(used of royalty and high nobility) gracious', 'adjective')).toBe(
      'gloss: too short to stand alone',
    );
    expect(glossProblem('(used of boats) inclined to heel over easily', 'adjective')).toBeNull();
  });

  it('accepts ordinary glosses, including ones that only look like fragments', () => {
    expect(glossProblem('native Eurasian tree widely cultivated for its fruit', 'noun')).toBeNull();
    expect(
      glossProblem('widely cultivated American plant with yellow flowers', 'noun', participle),
    ).toBeNull();
    expect(glossProblem('in chess, a move that protects the king', 'noun')).toBeNull();
    expect(glossProblem('a small fish found in still water', 'noun')).toBeNull();
    expect(glossProblem('similar things placed in order', 'noun')).toBeNull();
    // Adjective glosses often open with a participle.
    expect(glossProblem('marked by refinement in taste and manners', 'adjective')).toBeNull();
    expect(glossProblem('move forward by leaps and bounds', 'verb')).toBeNull();
    // Without a participle list, "cultivated in ..." can't be told from "dried fruit of ...".
    expect(glossProblem('cultivated in temperate regions', 'noun')).toBeNull();
  });
});

describe('pastForms', () => {
  it('gives regular past forms and the listed irregular ones', () => {
    expect(pastForms('bake')).toEqual(new Set(['baked']));
    expect(pastForms('try')).toEqual(new Set(['tried']));
    expect(pastForms('stop')).toEqual(new Set(['stoped', 'stopped']));
    expect(pastForms('catch', ['caught'])).toEqual(new Set(['caught', 'catched']));
  });
});

describe('sharedContentWords', () => {
  it('counts shared content-word stems, ignoring stopwords', () => {
    expect(sharedContentWords('a small breed of dog with long ears', 'a large breed of dogs')).toBe(
      2,
    );
    expect(sharedContentWords('a wind from the east', 'a wind from the west')).toBe(1);
    expect(sharedContentWords('the one with a hat', 'a one in the hat')).toBe(1);
  });
});

/** A tiny OEWN: synsets with their lexicographer file set, and one sense per listed lemma. */
function wordnet(
  synsets: Record<string, Omit<OewnSynset, 'partOfSpeech'>>,
  extraSenses: Record<string, string[]> = {},
): OewnData {
  const out: Record<string, OewnSynset> = {};
  const entries: Record<string, OewnEntry> = {};
  for (const [id, synset] of Object.entries(synsets)) {
    const partOfSpeech = id.slice(-1);
    out[id] = { ...synset, partOfSpeech };
    for (const member of synset.members) {
      const key = partOfSpeech === 's' ? 'a' : partOfSpeech;
      const entry = (entries[member] ??= {});
      const pe = (entry[key] ??= { sense: [] });
      pe.sense.push({ id: `${member}-${id}`, synset: id });
    }
  }
  for (const [lemma, ids] of Object.entries(extraSenses)) {
    for (const id of ids) {
      const entry = (entries[lemma] ??= {});
      const pe = (entry[id.slice(-1)] ??= { sense: [] });
      pe.sense.push({ id: `${lemma}-${id}`, synset: id });
    }
  }
  return { synsets: out, entries };
}

describe('sensesTouch', () => {
  const lex = buildLexicon(
    wordnet({
      '00000001-a': { definition: ['showing courage'], members: ['bold'], similar: ['00000002-s'] },
      '00000002-s': {
        definition: ['firm and sturdy'],
        members: ['stout'],
        similar: ['00000001-a'],
      },
      '00000003-v': { definition: ['go across'], members: ['cross', 'traverse'] },
      '00000004-n': { definition: ['a mark'], members: ['cross'] },
      '00000005-n': { definition: ['a hill'], members: ['knoll'] },
    }),
    new Set(),
  );

  it('links lemmas that share a synset in any part of speech, or a "similar to" pair', () => {
    expect(sensesTouch(lex, 'stout', 'bold')).toBe(true);
    expect(sensesTouch(lex, 'bold', 'stout')).toBe(true);
    expect(sensesTouch(lex, 'traverse', 'cross')).toBe(true);
    expect(sensesTouch(lex, 'knoll', 'cross')).toBe(false);
    expect(sensesTouch(lex, 'bold', 'knoll')).toBe(false);
  });
});

describe('buildBoards repair: exclusions, refills, the near-synonym guard', () => {
  const ANCHOR = '90000005-n';
  const LETTERS = 'abcdefghijklmnopqrstuv';
  /** 22 made-up lemmas, alphabetical in index order, sharing no stems. */
  const lemma = (i: number) => `k${LETTERS.charAt(i)}ravo`;
  /** Made-up content words that never touch a lemma: no stems or compounds in common. */
  const word = (i: number, k: number) => `x${LETTERS.charAt(i)}z${'abc'.charAt(k)}q`;
  const gloss = (i: number) => `a ${word(i, 0)} ${word(i, 1)} with ${word(i, 2)}`;

  /**
   * One noun anchor five levels deep with 22 leaves. All lemmas score alike, so the draft takes
   * the first 16 alphabetically; 16 to 21 are spares. Spare 16's gloss shares two content words
   * with word 0's (when passed as `glosses[16]`); spare 17 shares a verb synset with word 1.
   * `glosses` overrides a leaf's gloss; `dictionary` adds lemmas with a sense on the tree's root,
   * so they are dictionary words but never board words.
   */
  function data(glosses: Record<number, string> = {}, dictionary: string[] = []): OewnData {
    const synsets: Record<string, Omit<OewnSynset, 'partOfSpeech'>> = {};
    for (let d = 0; d <= 5; d++) {
      synsets[`9000000${String(d)}-n`] = {
        definition: [`level ${String(d)} of the tree`],
        members: [d === 5 ? 'gizmo' : `level${'abcde'.charAt(d)}`],
        lexfile: 'noun.artifact',
        ...(d === 0 ? {} : { hypernym: [`9000000${String(d - 1)}-n`] }),
      };
    }
    for (let i = 0; i < 22; i++) {
      synsets[`910000${String(i).padStart(2, '0')}-n`] = {
        definition: [glosses[i] ?? gloss(i)],
        members: [lemma(i)],
        hypernym: [ANCHOR],
        lexfile: 'noun.artifact',
      };
    }
    // Every leaf lemma is also a verb, so all score alike; spare 17's verb is word 1's.
    for (let i = 0; i < 22; i++) {
      if (i === 17) continue;
      synsets[`920000${String(i).padStart(2, '0')}-v`] = {
        definition: ['do a thing with care'],
        members: [lemma(i)],
      };
    }
    const extra = Object.fromEntries(dictionary.map((w) => [w, ['90000000-n']]));
    return wordnet(synsets, { [lemma(17)]: ['92000001-v'], ...extra });
  }
  const spare16 = `a ${word(16, 0)} ${word(0, 1)} with ${word(0, 2)}`;
  const options = (exclude: CluesExcludeList = {}): BuildOptions => ({
    seed: 7,
    quota: { noun: 1, verb: 0, adjective: 0 },
    minScore: 0,
    exclude,
  });

  it('builds one board on the anchor and records it', () => {
    const { boards, repair } = buildBoards(data({ 16: spare16 }), options());
    expect(boards).toHaveLength(1);
    const [board] = boards;
    expect(board?.anchor).toBe(ANCHOR);
    expect(board?.hypernym).toBe('gizmo');
    expect(new Set(board?.words.map((w) => w.lemma))).toEqual(
      new Set(Array.from({ length: BOARD_SIZE }, (_, i) => lemma(i))),
    );
    expect(repair.refilled).toBe(0);
    expect(repair.dropped).toEqual([]);
  });

  it('swaps excluded words for spares in the same slots, skipping near-synonyms', () => {
    const before = buildBoards(data({ 16: spare16 }), options()).boards[0];
    const exclude = { [ANCHOR]: [lemma(2), lemma(5)] };
    const { boards, repairs, repair } = buildBoards(data({ 16: spare16 }), options(exclude));
    const after = boards[0];
    if (before === undefined || after === undefined) throw new Error('no board');
    // Spare 16 shares gloss words with word 0 and spare 17 a synset with word 1: 18, 19 go in.
    expect(repair.guard).toEqual({ sharedSense: 1, sharedGlossWords: 1 });
    expect(repairs.b001).toEqual({
      drawId: 'b001',
      removed: [
        expect.objectContaining({ reason: 'excluded for its anchor' }),
        expect.objectContaining({ reason: 'excluded for its anchor' }),
      ],
      added: [lemma(18), lemma(19)],
    });
    const gaps: number[] = [];
    before.words.forEach((w, j) => {
      if (w.lemma === lemma(2) || w.lemma === lemma(5)) gaps.push(j);
      else expect(after.words[j]).toEqual(w);
    });
    expect(gaps.map((j) => after.words[j]?.lemma)).toEqual([lemma(18), lemma(19)]);
    expect(after.words.map((w) => w.id)).toEqual(before.words.map((w) => w.id));
  });

  it('takes off a word whose gloss is only a usage note and refills its slot', () => {
    const usage = `used of ${word(3, 0)} ${word(3, 1)}`;
    const { boards, repairs } = buildBoards(data({ 3: usage, 16: spare16 }), options());
    expect(boards[0]?.words.map((w) => w.lemma)).not.toContain(lemma(3));
    expect(repairs.b001?.removed).toEqual([{ lemma: lemma(3), reason: 'gloss: usage note' }]);
    expect(repairs.b001?.added).toEqual([lemma(18)]);
  });

  it('takes off a word whose definition gives it away by the full test, though the draft let it in', () => {
    // "kdravian" starts like "kdravo" (word 3): no inflection or compound part, a shared prefix.
    const leak = `a kdravian ${word(3, 0)} with ${word(3, 1)}`;
    const { boards, repairs, repair } = buildBoards(data({ 3: leak, 16: spare16 }), options());
    expect(boards[0]?.words.map((w) => w.lemma)).not.toContain(lemma(3));
    expect(repairs.b001?.removed).toEqual([
      { lemma: lemma(3), reason: 'definition gives its word away' },
    ]);
    expect(repairs.b001?.added).toEqual([lemma(18)]);
    expect(repair.removed).toEqual([['definition gives its word away', 1]]);
  });

  it('skips a refill whose definition gives it away', () => {
    const leak = `a ${word(18, 0)} ksravian with ${word(18, 1)}`;
    const exclude = { [ANCHOR]: [lemma(2)] };
    const { repairs, repair } = buildBoards(data({ 16: spare16, 18: leak }), options(exclude));
    expect(repairs.b001?.added).toEqual([lemma(19)]);
    expect(repair.skipped).toContainEqual(['definition gives its word away', 1]);
  });

  it("gives the full test Wordnet's lemmas as its dictionary and Wordnet's forms", () => {
    // kdravo (word 3) is kdr + avo only when both are dictionary words. Then "kdrs" (kdr + s)
    // gives it away, and so does "avi" when Wordnet lists it as a form of avo.
    const part = `a kdrs ${word(3, 0)} with ${word(3, 1)}`;
    const form = `a avi ${word(3, 0)} with ${word(3, 1)}`;
    for (const leak of [part, form]) {
      const without = buildBoards(data({ 3: leak, 16: spare16 }), options());
      expect(
        without.boards[0]?.words.map((w) => w.lemma),
        leak,
      ).toContain(lemma(3));
      expect(without.repairs.b001?.removed, leak).toEqual([]);
    }
    const withParts = buildBoards(data({ 3: part, 16: spare16 }, ['kdr', 'avo']), options());
    expect(withParts.repairs.b001?.removed).toEqual([
      { lemma: lemma(3), reason: 'definition gives its word away' },
    ]);
    expect(withParts.repairs.b001?.added).toEqual([lemma(18)]);
    const noForm = buildBoards(data({ 3: form, 16: spare16 }, ['kdr', 'avo']), options());
    expect(noForm.repairs.b001?.removed).toEqual([]);
    const listed = data({ 3: form, 16: spare16 }, ['kdr', 'avo']);
    const avo = listed.entries.avo?.n;
    if (avo === undefined) throw new Error('no entry for avo');
    avo.form = ['avi'];
    expect(buildBoards(listed, options()).repairs.b001?.removed).toEqual([
      { lemma: lemma(3), reason: 'definition gives its word away' },
    ]);
  });

  it('takes off a word whose gloss holds an inflected blocked word, and skips such a refill', () => {
    const blockedWordHashes = new Set([blocklistHash('kblorp')]);
    // The draft only checks whole words, so "kblorps" gets word 3 onto the board.
    const leak3 = `a kblorps ${word(3, 0)} with ${word(3, 1)}`;
    const leak18 = `a ${word(18, 0)} kblorped with ${word(18, 1)}`;
    const glosses = { 3: leak3, 16: spare16, 18: leak18 };
    const { boards, repairs, repair } = buildBoards(data(glosses), {
      ...options(),
      blockedWordHashes,
    });
    expect(boards[0]?.words.map((w) => w.lemma)).not.toContain(lemma(3));
    expect(repairs.b001?.removed).toEqual([
      { lemma: lemma(3), reason: 'blocklisted word in the definition' },
    ]);
    expect(repairs.b001?.added).toEqual([lemma(19)]);
    expect(repair.removed).toEqual([['blocklisted word in the definition', 1]]);
    // Word 3 comes up again as a refill candidate, then spare 18.
    expect(repair.skipped).toContainEqual(['blocklisted word in the definition', 2]);
    // "kblorpes" may be a form of kblorpe, a dictionary word that isn't blocked: it stays.
    const plain = `a kblorpes ${word(3, 0)} with ${word(3, 1)}`;
    const kept = buildBoards(data({ 3: plain, 16: spare16 }, ['kblorpe']), {
      ...options(),
      blockedWordHashes,
    });
    expect(kept.repairs.b001?.removed).toEqual([]);
    const notKept = buildBoards(data({ 3: plain, 16: spare16 }), {
      ...options(),
      blockedWordHashes,
    });
    expect(notKept.repairs.b001?.removed).toEqual([
      { lemma: lemma(3), reason: 'blocklisted word in the definition' },
    ]);
  });

  it('reports a listed board that the repair step dropped anyway, without throwing', () => {
    const exclude = { [ANCHOR]: [2, 3, 6, 9, 12].map(lemma) };
    const { boards, listDropped } = buildBoards(data({ 16: spare16 }), {
      ...options(exclude),
      drop: [{ anchor: ANCHOR, lemma: lemma(0) }],
    });
    expect(boards).toEqual([]);
    expect(listDropped).toEqual([
      { drawId: 'b001', anchor: ANCHOR, pos: 'noun', lemma: lemma(0), repairDropped: true },
    ]);
  });

  it('drops a board that cannot be refilled to 16 and reports unused exclusions', () => {
    // Five gaps, but spares 16 and 17 are near-synonyms of words 0 and 1: only four fit.
    const exclude = { [ANCHOR]: [2, 3, 6, 9, 12].map(lemma), '12345678-n': ['nothing'] };
    const { boards, repair } = buildBoards(data({ 16: spare16 }), options(exclude));
    expect(boards).toEqual([]);
    expect(repair.dropped).toEqual([
      { drawId: 'b001', anchor: ANCHOR, pos: 'noun', reason: 'refilled to 15 of 16 words' },
    ]);
    expect(repair.unusedExclusions).toEqual(['12345678-n']);
  });
});

describe('buildBoards drop list', () => {
  const ANCHOR = '90000005-n';
  /** Two letters per index, so 32 made-up lemmas share no stems. */
  const tag = (i: number) =>
    `${'abcdefghijklmnopqrstuvwxyz'.charAt(i % 26)}${'ab'.charAt(Math.floor(i / 26))}`;
  /** 32 leaves: enough for two boards on one anchor. */
  const lemma = (i: number) => `k${tag(i)}ravo`;
  const word = (i: number, k: number) => `x${tag(i)}z${'abc'.charAt(k)}q`;

  function data(): OewnData {
    const synsets: Record<string, Omit<OewnSynset, 'partOfSpeech'>> = {};
    for (let d = 0; d <= 5; d++) {
      synsets[`9000000${String(d)}-n`] = {
        definition: [`level ${String(d)} of the tree`],
        members: [d === 5 ? 'gizmo' : `level${'abcde'.charAt(d)}`],
        lexfile: 'noun.artifact',
        ...(d === 0 ? {} : { hypernym: [`9000000${String(d - 1)}-n`] }),
      };
    }
    for (let i = 0; i < 32; i++) {
      synsets[`910000${String(i).padStart(2, '0')}-n`] = {
        definition: [`a ${word(i, 0)} ${word(i, 1)} with ${word(i, 2)}`],
        members: [lemma(i)],
        hypernym: [ANCHOR],
        lexfile: 'noun.artifact',
      };
      synsets[`920000${String(i).padStart(2, '0')}-v`] = {
        definition: ['do a thing with care'],
        members: [lemma(i)],
      };
    }
    return wordnet(synsets);
  }
  const options = (drop: BuildOptions['drop'] = []): BuildOptions => ({
    seed: 7,
    quota: { noun: 2, verb: 0, adjective: 0 },
    minScore: 0,
    drop,
  });

  it('leaves out the named board, renumbers the rest and changes no other board', () => {
    const before = buildBoards(data(), options()).boards;
    expect(before).toHaveLength(2);
    expect(before.map((b) => b.anchor)).toEqual([ANCHOR, ANCHOR]);
    const [first, second] = before;
    const named = first?.words[3]?.lemma;
    if (second === undefined || named === undefined) throw new Error('no boards');
    const { boards, listDropped, repairs } = buildBoards(
      data(),
      options([{ anchor: ANCHOR, lemma: named }]),
    );
    expect(boards).toEqual([{ ...second, id: 'b001' }]);
    expect(listDropped).toEqual([{ drawId: 'b001', anchor: ANCHOR, pos: 'noun', lemma: named }]);
    expect(repairs.b001?.drawId).toBe('b002');
  });

  it('names a board by its draw id once its listed word is gone, and checks the anchor', () => {
    const before = buildBoards(data(), options()).boards;
    const second = before[1];
    if (second === undefined) throw new Error('no boards');
    const { boards, listDropped } = buildBoards(
      data(),
      options([{ anchor: ANCHOR, lemma: 'gone', drawId: 'b001' }]),
    );
    expect(boards).toEqual([{ ...second, id: 'b001' }]);
    expect(listDropped).toEqual([{ drawId: 'b001', anchor: ANCHOR, pos: 'noun', lemma: 'gone' }]);
    expect(() =>
      buildBoards(data(), options([{ anchor: '12345678-n', lemma: 'gone', drawId: 'b001' }])),
    ).toThrow(/draw id b001 names 0 boards/);
  });

  it('throws when an entry names no board', () => {
    expect(() => buildBoards(data(), options([{ anchor: ANCHOR, lemma: 'nothing' }]))).toThrow(
      /names 0 boards/,
    );
    expect(() => buildBoards(data(), options([{ anchor: '12345678-n', lemma: lemma(0) }]))).toThrow(
      /names 0 boards/,
    );
  });
});
