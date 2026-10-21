/**
 * greenhouse-boards.test.mjs — Greenhouse boards embedded in a company's own
 * site (`?gh_jid=`): the scanner stores the company page the board API gives,
 * and the ladder resolves it through the tracked boards. A fake client stands
 * in for the network.
 *
 * Run: node --test scripts/lib/greenhouse-boards.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from './http.mjs';
import { greenhouseBoardsFromPortals, greenhouseEmbedId, embedBoards } from './greenhouse-boards.mjs';
import { climbLadder } from './liveness-ladder.mjs';
import { parsePostingUrl } from './ats-url.mjs';
import { fetchPosting } from '../fetch-posting.mjs';

const PORTALS = {
  tracked_companies: [
    { name: 'Nimbus Robotics', careers_url: 'https://job-boards.greenhouse.io/nimbus', api: 'https://boards-api.greenhouse.io/v1/boards/nimbus/jobs' },
    { name: 'Harbor Light', careers_url: 'https://job-boards.eu.greenhouse.io/harborlightbank' },
    { name: 'Lumen Freight', careers_url: 'https://jobs.ashbyhq.com/lumen' },
    { name: 'Quiet Co', careers_url: 'https://job-boards.greenhouse.io/quietco', enabled: false },
  ],
};
const BOARDS = greenhouseBoardsFromPortals(PORTALS);

const EMBED = 'https://nimbus.example/careers/positions/4417?gh_jid=4417';

function fakeHttp(table) {
  const calls = [];
  const find = (url) => {
    calls.push(url);
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    if (!hit) throw new HttpError('connect ECONNREFUSED', { code: 'ECONNREFUSED', retryable: true });
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { calls, getJson: async (u) => find(u), getText: async (u) => find(u) };
}
const notFound = () => new HttpError('HTTP 404', { code: 'ESTATUS', status: 404 });
const JOB = { id: 4417, title: 'Operations Analyst', content: '&lt;p&gt;' + 'Run the weekly supply review. '.repeat(30) + '&lt;/p&gt;', location: { name: 'Lyon' } };

test('boards come from enabled Greenhouse entries, by api or careers_url', () => {
  assert.deepEqual(BOARDS, [
    { company: 'Nimbus Robotics', slug: 'nimbus', eu: false },
    { company: 'Harbor Light', slug: 'harborlightbank', eu: true },
  ]);
});

test('an embed id is a numeric gh_jid on a non-Greenhouse https host', () => {
  assert.equal(greenhouseEmbedId(EMBED), '4417');
  assert.equal(greenhouseEmbedId('https://harborlight.example/about?jobId=99&gh_jid=99001'), '99001');
  assert.equal(greenhouseEmbedId('https://job-boards.greenhouse.io/nimbus/jobs/4417?gh_jid=4417'), null);
  assert.equal(greenhouseEmbedId('http://nimbus.example/x?gh_jid=4417'), null);
  assert.equal(greenhouseEmbedId('https://nimbus.example/x?gh_jid=abc'), null);
  assert.equal(parsePostingUrl(EMBED), null, 'the URL alone still names no board');
});

test('the board is matched on the domain label: company name, slug, or a slug that extends it', () => {
  assert.deepEqual(embedBoards(EMBED, BOARDS).map((b) => b.slug), ['nimbus']);
  assert.deepEqual(embedBoards('https://www.harborlight.example/about?gh_jid=99001', BOARDS).map((b) => b.slug), ['harborlightbank']);
  assert.deepEqual(embedBoards('https://careers.other.example/x?gh_jid=99001', BOARDS), []);
});

test('the ladder confirms an embedded posting through the matched board', async () => {
  const http = fakeHttp({ 'boards-api.greenhouse.io/v1/boards/nimbus/jobs/4417': JOB });
  const r = await climbLadder(EMBED, { http, greenhouseBoards: BOARDS });
  assert.equal(r.verdict.result, 'active');
  assert.equal(r.verdict.via, 'api-job');
  assert.equal(r.ats, 'greenhouse');
  assert.match(r.verdict.jd.description, /weekly supply review/);
});

test('a 404 on a guessed board is not proof of closure', async () => {
  const http = fakeHttp({ 'boards-api.greenhouse.io/v1/boards/nimbus/jobs/4417': notFound() });
  const r = await climbLadder(EMBED, { http, greenhouseBoards: BOARDS });
  assert.equal(r.verdict, null);
  assert.equal(r.errors[0].status, 404);
});

test('no matching board: no request, and a hint that says what to add', async () => {
  const http = fakeHttp({});
  const r = await climbLadder('https://other.example/x?gh_jid=4417', { http, greenhouseBoards: BOARDS });
  assert.equal(r.verdict, null);
  assert.equal(http.calls.length, 0);
  assert.match(r.hint, /portals\.yml/);
});

test('fetch-posting prints the JD of an embedded posting (exit 0)', async () => {
  const http = fakeHttp({ 'boards-api.greenhouse.io/v1/boards/nimbus/jobs/4417': JOB });
  const r = await fetchPosting(EMBED, { http, workdaySites: {}, greenhouseBoards: BOARDS });
  assert.equal(r.exitCode, 0);
  assert.equal(r.title, 'Operations Analyst');
});
