const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startAgentServer } = require('../out/agent/server');

test('agent bridge only accepts authenticated same-host loopback requests', async () => {
  const received = [];
  const server = await startAgentServer(async (action, input) => { received.push({ action, input }); return { action, input }; });
  try {
    const post = async (headers = {}, body = { action: 'context', input: {} }) => fetch(server.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await post()).status, 403);
    assert.equal((await post({ Authorization: 'Bearer ' + 'a'.repeat(64) })).status, 403);
    assert.equal((await post({ Authorization: 'Bearer ' + server.token, Origin: 'https://untrusted.example' })).status, 403);
    const result = await post({ Authorization: 'Bearer ' + server.token });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, result: { action: 'context', input: {} } });
    assert.equal(received.length, 1);
    assert.equal((await post({ Authorization: 'Bearer ' + server.token }, { action: 'read', input: { text: 'x'.repeat(70000) } })).status, 413);
    const get = await fetch(server.url, { headers: { Authorization: 'Bearer ' + server.token } });
    assert.equal(get.status, 404);
  } finally { await server.close(); }
});

test('agent bridge correctly decodes multibyte Chinese query data split across TCP chunks', async () => {
  const server = await startAgentServer(async (_action, input) => input);
  try {
    const body = Buffer.from(JSON.stringify({ action: 'search', input: { query: '山河与😀' } }));
    const bytes = Buffer.from('山');
    const split = body.indexOf(bytes) + 1;
    const result = await new Promise((resolve, reject) => {
      const request = http.request(server.url, { method: 'POST', headers: { Authorization: 'Bearer ' + server.token } }, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(JSON.parse(text))); response.on('error', reject);
      });
      request.on('error', reject);
      request.write(body.subarray(0, split));
      setImmediate(() => request.end(body.subarray(split)));
    });
    assert.deepEqual(result, { ok: true, result: { query: '山河与😀' } });
  } finally { await server.close(); }
});
