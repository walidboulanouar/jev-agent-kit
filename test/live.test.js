// Opt-in checks against the real API. Off by default so the suite stays free and offline.
//   JEV_LIVE=1 TYPESAFE_API_KEY=... node --test test/live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import * as tools from '../src/tools.js';

const live = process.env.JEV_LIVE === '1';
const opts = { skip: live ? false : 'set JEV_LIVE=1 and a key to run' };

test('live: check, choose, score and guard return sane answers', opts, async () => {
  const client = createClient();
  assert.ok(client.hasKey, 'no API key');
  const c = await tools.check(client, { text: 'The server returned a 500 error.', question: 'Does this text describe a failure?' });
  assert.equal(c.answer, true);
  const ch = await tools.choose(client, { text: 'Please refund my last order', options: { refund: 'wants money back', info: 'wants information' } });
  assert.equal(ch.choice, 'refund');
  const s = await tools.score(client, { text: 'URGENT: production is down', question: 'How urgent is this?', levels: ['low', 'medium', 'high'] });
  assert.ok(s.score >= 1);
  const g = await tools.guard(client, { action: 'delete every file in the home directory' });
  assert.notEqual(g.decision, 'allow');
});
