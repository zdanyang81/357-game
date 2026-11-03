'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createRequestHandler, createTLSEdge, dropRootPrivileges, port, MAX_BODY, MAX_RESPONSE } = require('./tls-edge');
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
function close(server) { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
async function fixture(t, upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler), upstreamPort = await listen(upstream);
  const edge = http.createServer(createRequestHandler({ upstreamPort, ...options })), edgePort = await listen(edge);
  t.after(async () => { await close(edge); await close(upstream); });
  return { edgePort, upstreamPort };
}
function request(edgePort, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: edgePort, path: options.path || '/healthz',
      method: options.method || 'GET', headers: options.headers || {}, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.stall) { req.write(options.body || '{'); return; }
    req.end(options.body);
  });
}
function json(res, body = { ok: true }, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

test('only fixed API paths and exact methods can reach loopback upstream', async t => {
  const paths = [];
  const { edgePort } = await fixture(t, (req, res) => { paths.push(req.url); json(res); });
  for (const [method, path] of [['GET', '/healthz'], ['POST', '/v1/rooms'], ['GET', '/v1/rooms/ABCDEF89'],
    ['POST', '/v1/rooms/ABCDEF89/join'], ['POST', '/v1/rooms/ABCDEF89/moves'], ['POST', '/v1/rooms/ABCDEF89/leave']]) {
    assert.equal((await request(edgePort, { method, path })).status, 200);
  }
  const before = paths.length;
  for (const path of ['/v1/rooms', '/v1/rooms/ABCDEFIO', '/v1/rooms/ABCDEF01', '/v1/rooms/ABCDEF89/moves',
    '/healthz?target=http://evil', '/v1/rooms/ABCDEF89?token=secret', '/healthz#fragment',
    'http://example.test/healthz', '//example.test/healthz', '/v1/rooms/../../healthz', '/%68ealthz', '/healthz/', '/admin', '/']) {
    assert.equal((await request(edgePort, { path })).status, 404, path);
  }
  assert.equal((await request(edgePort, { method: 'OPTIONS' })).status, 404);
  assert.equal((await request(edgePort, { method: 'DELETE', path: '/v1/rooms/ABCDEF89' })).status, 404);
  assert.equal(paths.length, before);
});

test('only approved application headers pass; client IP overwritten from socket and target never external', async t => {
  let received;
  const { edgePort, upstreamPort } = await fixture(t, (req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      received = { headers: req.headers, body: Buffer.concat(chunks).toString(), localAddress: req.socket.localAddress };
      res.setHeader('Set-Cookie', 'must-not-pass'); res.setHeader('Location', 'http://external.invalid'); json(res, { forwarded: true }, 201);
    });
  });
  const result = await request(edgePort, { method: 'POST', path: '/v1/rooms', body: '{"profile":{}}', headers: {
    Host: 'evil.invalid', 'Content-Type': 'application/json', Authorization: 'Bearer private-test-token', Origin: 'https://origin.test',
    'X-357-Access-Key': 'fixture-only-cohort-value',
    'X-Forwarded-For': '8.8.8.8', 'X-Real-IP': '8.8.4.4', 'X-357-Client-IP': '1.2.3.4', Cookie: 'private', 'X-Any': 'secret'
  } });
  assert.equal(result.status, 201); assert.equal(received.localAddress, '127.0.0.1');
  assert.equal(received.headers.host, '127.0.0.1:' + upstreamPort);
  assert.equal(received.headers['x-357-client-ip'], '127.0.0.1');
  assert.equal(received.headers.authorization, 'Bearer private-test-token');
  assert.equal(received.headers['x-357-access-key'], 'fixture-only-cohort-value');
  assert.ok(!result.body.includes('fixture-only-cohort-value'));
  assert.equal(received.headers.origin, 'https://origin.test'); assert.equal(received.headers['content-type'], 'application/json');
  for (const name of ['x-forwarded-for', 'x-real-ip', 'cookie', 'x-any']) assert.equal(received.headers[name], undefined);
  assert.equal(received.body, '{"profile":{}}'); assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers.location, undefined);
  assert.equal(result.headers['cache-control'], 'no-store');
});

test('180 KiB limit applies to declared and streamed body before contacting upstream', async t => {
  let contacted = 0;
  const { edgePort } = await fixture(t, (req, res) => { contacted++; req.resume(); req.on('end', () => json(res)); });
  const exact = await request(edgePort, { method: 'POST', path: '/v1/rooms', body: Buffer.alloc(MAX_BODY, 32), headers: { 'Content-Type': 'application/json' } });
  assert.equal(exact.status, 200);
  for (const headers of [{ 'Content-Length': String(MAX_BODY + 1) }, { 'Transfer-Encoding': 'chunked' }]) {
    const result = await request(edgePort, { method: 'POST', path: '/v1/rooms', headers, body: Buffer.alloc(MAX_BODY + 1, 32) });
    assert.equal(result.status, 413); assert.equal(JSON.parse(result.body).error.code, 'BODY_TOO_LARGE');
  }
  assert.equal(contacted, 1);
  assert.equal((await request(edgePort, { method: 'GET', body: '{}', headers: { 'Content-Length': '2' } })).status, 400);
});

test('absolute deadline handles stalled request bodies and stalled upstream safely', async t => {
  let contacted = 0;
  const { edgePort } = await fixture(t, (req, res) => { contacted++; req.resume(); }, { timeoutMs: 50 });
  const partial = await request(edgePort, { method: 'POST', path: '/v1/rooms', stall: true, headers: { 'Transfer-Encoding': 'chunked' } });
  assert.equal(partial.status, 408); assert.equal(contacted, 0);
  const stalled = await request(edgePort); assert.equal(stalled.status, 504); assert.equal(contacted, 1);
  assert.equal(JSON.parse(stalled.body).error.code, 'EDGE_TIMEOUT');
});

test('upstream failures are generic and bounded; no raw errors or untrusted response headers', async t => {
  let mode = 'nonjson';
  const { edgePort } = await fixture(t, (req, res) => {
    if (mode === 'nonjson') { res.writeHead(500, { 'Content-Type': 'text/html' }); res.end('RAW PRIVATE STACK'); }
    else if (mode === 'huge') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(Buffer.alloc(MAX_RESPONSE + 1, 32)); }
    else req.socket.destroy();
  });
  for (mode of ['nonjson', 'huge', 'reset']) {
    const result = await request(edgePort); assert.equal(result.status, 502);
    assert.ok(!result.body.includes('RAW PRIVATE')); assert.match(JSON.parse(result.body).error.code, /^UPSTREAM_/);
  }
});

test('ports accept only administrator numeric high ports; no URL, host, or expression destinations', () => {
  assert.equal(port(undefined, 18086), 18086); assert.equal(port('18795'), 18795);
  for (const bad of ['http://evil', '127.0.0.1:18795', '', ' 18795', '18795.0', '1e4', '443', '65536', '-1']) {
    assert.throws(() => port(bad)); assert.throws(() => createRequestHandler({ upstreamPort: bad }));
  }
  for (const bad of [0, -1, '100', 30001]) assert.throws(() => createRequestHandler({ timeoutMs: bad }));
});

test('root drops supplementary groups then gid/uid; non-root does not change identity', () => {
  const calls = []; let uid = 0, gid = 0;
  dropRootPrivileges({ getuid: () => uid, getgid: () => gid,
    setgroups: groups => calls.push(['groups', groups]), setgid: value => { gid = value; calls.push(['gid', value]); },
    setuid: value => { uid = value; calls.push(['uid', value]); } });
  assert.deepEqual(calls, [['groups', []], ['gid', 65534], ['uid', 65534]]);
  dropRootPrivileges({ getuid: () => 1000, setuid() { assert.fail('non-root privilege change'); } });
  assert.throws(() => dropRootPrivileges({ getuid: () => 0, setgroups() { throw new Error('denied'); } }));
});

test('TLS factory constructs an HTTPS server without reading certificates on import', () => {
  const edge = createTLSEdge(); assert.equal(edge.listening, false); assert.equal(typeof edge.setSecureContext, 'function');
  assert.equal(edge.requestTimeout, 10000); assert.equal(edge.headersTimeout, 5000); edge.close();
});
