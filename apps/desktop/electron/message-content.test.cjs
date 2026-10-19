const test = require('node:test');
const assert = require('node:assert/strict');

test('leading provider reasoning stays separate from Markdown, including partial streamed tags and literal code', async () => {
  const { splitLeadingThinking } = await import('../src/message-content.ts');
  assert.deepEqual(splitLeadingThinking('<think>First</think>\n<think>Second</think>\n## Answer'), {
    thoughts: [
      { text: 'First', incomplete: false },
      { text: 'Second', incomplete: false },
    ],
    body: '## Answer',
  });
  assert.deepEqual(splitLeadingThinking('<think>Still streaming'), {
    thoughts: [{ text: 'Still streaming', incomplete: true }],
    body: '',
  });
  for (const text of ['```xml\n<think>literal</think>\n```', '正文中提及 <think> 标签'])
    assert.deepEqual(splitLeadingThinking(text), { thoughts: [], body: text });
});

test('closing a streamed reasoning tag releases the answer without consuming its Markdown', async () => {
  const { splitLeadingThinking } = await import('../src/message-content.ts');
  const snapshots = [
    ['<thi', { thoughts: [], body: '<thi' }],
    ['<think>Plan', { thoughts: [{ text: 'Plan', incomplete: true }], body: '' }],
    ['<think>Plan</think>', { thoughts: [{ text: 'Plan', incomplete: false }], body: '' }],
    [
      '<think>Plan</think>\n\n```xml\n<think>literal</think>\n```',
      {
        thoughts: [{ text: 'Plan', incomplete: false }],
        body: '```xml\n<think>literal</think>\n```',
      },
    ],
  ];
  for (const [text, expected] of snapshots) assert.deepEqual(splitLeadingThinking(text), expected);
});

test('only consecutive leading thoughts are extracted, including an unfinished second thought', async () => {
  const { splitLeadingThinking } = await import('../src/message-content.ts');
  assert.deepEqual(splitLeadingThinking(' \n<think>  first \n</think> \n<think> second'), {
    thoughts: [
      { text: 'first', incomplete: false },
      { text: 'second', incomplete: true },
    ],
    body: '',
  });
  assert.deepEqual(splitLeadingThinking('<think></think>\nAnswer\n<think>quoted later</think>'), {
    thoughts: [{ text: '', incomplete: false }],
    body: 'Answer\n<think>quoted later</think>',
  });
});

test('ordinary empty, whitespace and literal-tag messages preserve their body exactly', async () => {
  const { splitLeadingThinking } = await import('../src/message-content.ts');
  for (const text of [
    '',
    '  \n\t',
    '\n  Answer  \n',
    '`<think>literal</think>`',
    '> <think>quoted</think>',
    '&lt;think&gt;escaped',
  ]) {
    assert.deepEqual(splitLeadingThinking(text), { thoughts: [], body: text });
  }
});
