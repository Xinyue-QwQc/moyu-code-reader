import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Narrow, authenticated loopback RPC for file/shell-based agents. Not an exposed web service. */
export async function startAgentServer(invoke: (action: string, input: unknown) => Promise<unknown>) {
  const token = randomBytes(32).toString('hex');
  let port = 0;
  let active = 0;
  const server = http.createServer((request, response) => {
    const reply = (status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const authorized = /^[0-9a-f]{64}$/.test(bearer) && timingSafeEqual(Buffer.from(bearer), Buffer.from(token));
    if (!authorized || request.headers.origin || request.headers.host !== '127.0.0.1:' + port
      || request.socket.remoteAddress !== '127.0.0.1') { reply(403, { ok: false, error: 'Local reader access denied.' }); return; }
    if (request.method !== 'POST' || request.url !== '/rpc') { reply(404, { ok: false, error: 'Only the reader RPC endpoint is available.' }); return; }
    if (active >= 4) { reply(429, { ok: false, error: 'Too many reader requests; retry after an earlier call finishes.' }); return; }
    active++;
    response.once('close', () => { active--; });
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 65536) { reply(413, { ok: false, error: 'Request is too large.' }); return; }
      chunks.push(chunk);
    });
    request.on('error', () => reply(400, { ok: false, error: 'Incomplete request.' }));
    request.on('end', () => {
      if (size > 65536) return;
      void (async () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!input || typeof input.action !== 'string') throw new Error('action is required.');
          const result = await invoke(input.action, input.input ?? {});
          reply(200, { ok: true, result });
        } catch (error) { reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; server.removeListener('error', reject); resolve(); });
  });
  server.on('error', error => console.warn('[fanqie agent bridge]', error.message));
  server.unref();
  return { url: 'http://127.0.0.1:' + port + '/rpc', token,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
