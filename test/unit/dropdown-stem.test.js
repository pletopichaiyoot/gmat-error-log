/* global require */
const test = require('node:test');
const assert = require('node:assert');

let buildDropdownStatement;
let splitDropdownAnswers;
test.before(async () => {
  ({ buildDropdownStatement, splitDropdownAnswers } = await import('../../client/src/lib/dropdownStem.mjs'));
});

// Shape taken verbatim from question_attempts.id 21572 (q_code 35043, OG Main GI).
const BLANKS = [
  {
    label: 'Blank 1',
    text: 'directly affirms',
    options: [
      { text: 'Select...' },
      { text: 'directly affirms' },
      { text: 'directly contradicts' },
      { text: 'neither directly affirms nor directly contradicts' },
    ],
  },
  {
    label: 'Blank 2',
    text: '1995–2005',
    options: [
      { text: 'Select...' },
      { text: '1980–1985' },
      { text: '1980–1995' },
      { text: '1995–2005' },
    ],
  },
];

const STEM = [
  'Select from each drop-down menu the option that completes the statement so that it is accurate.',
  '',
  'The information in the graph',
  'Select...',
  'directly affirms',
  'directly contradicts',
  'neither directly affirms nor directly contradicts',
  ' the statement that the number of immigrants did not change significantly.',
  '',
  'During the interval',
  'Select...',
  '1980–1985',
  '1980–1995',
  '1995–2005',
  ' , the growth rate was lower.',
].join('\n');

test('replaces each flattened option run with its blank', () => {
  const tokens = buildDropdownStatement(STEM, BLANKS);
  assert.deepEqual(tokens.map((t) => (t.type === 'blank' ? `[${t.index}]` : t.type)), [
    'text', '[0]', 'text', '[1]', 'text',
  ]);
  assert.match(tokens[0].text, /The information in the graph$/);
  assert.match(tokens[2].text, /During the interval$/);
  assert.equal(tokens[4].text, ' , the growth rate was lower.');
  // No option text survives anywhere in the rebuilt statement.
  const rebuilt = tokens.filter((t) => t.type === 'text').map((t) => t.text).join(' ');
  assert.ok(!rebuilt.includes('directly contradicts'));
  assert.ok(!rebuilt.includes('1980–1995'));
});

test('returns null when a marker is not followed by that blank options', () => {
  const stem = 'The graph shows\nSelect...\nsomething else entirely\n rest of sentence.';
  assert.equal(buildDropdownStatement(stem, BLANKS), null);
});

test('returns null when the stem has fewer runs than blanks', () => {
  const stem = ['The information in the graph', 'Select...', 'directly affirms', ' the statement.'].join('\n');
  assert.equal(buildDropdownStatement(stem, BLANKS), null);
});

test('returns null for an empty stem or no blanks', () => {
  assert.equal(buildDropdownStatement('', BLANKS), null);
  assert.equal(buildDropdownStatement(STEM, []), null);
  assert.equal(buildDropdownStatement(STEM, null), null);
});

test('a trailing marker run with no text after it still resolves', () => {
  const stem = ['Pick one:', 'Select...', 'directly affirms', 'Select...', '1995–2005'].join('\n');
  const tokens = buildDropdownStatement(stem, BLANKS);
  assert.deepEqual(tokens.map((t) => t.type), ['text', 'blank', 'blank']);
});

test('splits a comma-joined key by matching the stored options', () => {
  const blanks = [
    { options: [{ text: 'Select...' }, { text: '600,000' }, { text: '4' }] },
    { options: [{ text: 'Select...' }, { text: '1,200,000' }, { text: '1' }] },
  ];
  assert.deepEqual(splitDropdownAnswers('600,000,1,200,000', blanks), ['600,000', '1,200,000']);
});

test('a key without embedded commas still splits naively', () => {
  const blanks = [{ options: [{ text: 'end' }] }, { options: [{ text: 'a steep decrease' }] }];
  assert.deepEqual(splitDropdownAnswers('end, a steep decrease', blanks), ['end', 'a steep decrease']);
});

test('falls back to the naive split when the options are gone or do not match', () => {
  const flattened = [{ label: 'Blank 1', text: 'x' }, { label: 'Blank 2', text: 'y' }];
  assert.deepEqual(splitDropdownAnswers('600,000,1,200,000', flattened), ['600', '000', '1', '200', '000']);
  assert.deepEqual(splitDropdownAnswers('', flattened), []);
});
