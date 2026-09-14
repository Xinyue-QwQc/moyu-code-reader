#!/usr/bin/env node
'use strict';
// The reader extension owns the API, session credentials and context. No Codex/MCP setup needed.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

async function main(args) {
  const action = args.shift() || 'context';
  if (action === '--help' || action === 'help') {
    console.log('Fanqie reader (read-only)\n' +
      'context [--scope visible|selection|page] [--offset N --limit N]\n' +
      'search --query "book name" [--page N --page-size N]\n' +
      'directory [--book-id ID] [--offset N --limit N]\n' +
      'read [--book-id ID] [--start-chapter N --count N | --item-ids ID,ID] [--offset N --limit N]\n' +
      'Use nextOffset while hasMore=true. The plugin must be running. No writes or account access.');
    return;
  }
  const input = {};
  const numeric = new Set(['offset', 'limit', 'page', 'pageSize', 'startChapter', 'count']);
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || args[index + 1] === undefined) throw new Error('Options require --name value; use --help.');
    const key = args[index].slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    input[key] = key === 'itemIds' ? args[index + 1].split(',') : numeric.has(key) ? Number(args[index + 1]) : args[index + 1];
  }
  const descriptor = JSON.parse(fs.readFileSync(path.join(__dirname, 'bridge.json'), 'utf8'));
  const url = new URL(descriptor.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') throw new Error('Invalid local reader endpoint.');
  const body = JSON.stringify({ action, input });
  const result = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { const result = JSON.parse(text); if (!result.ok) throw new Error(result.error); resolve(result.result); }
        catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error('Fanqie reader: ' + error.message + '\nKeep the VS Code reader running. Reattach fresh AI context after restarting it.');
  process.exitCode = 1;
});
module.exports = { main };
