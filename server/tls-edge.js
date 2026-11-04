'use strict';

// An isolated HTTPS edge; importing this module never reads TLS files or listens.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const MAX_BODY = 180 * 1024;
const MAX_RESPONSE = 512 * 1024;
function port(value, fallback) {
  const text = value === undefined ? String(fallback) : String(value);
  if (!/^[0-9]{1,5}$/.test(text)) throw new Error('Invalid edge port configuration');
  const result = Number(text);
  if (!Number.isInteger(result) || result < 1024 || result > 65535) throw new Error('Invalid edge port configuration');
  return result;
}
function timeout(value = 10000) {
  if (!Number.isInteger(value) || value < 10 || value > 30000) throw new Error('Invalid edge timeout configuration');
  return value;
}
function allowed(method, path) {
  if (method === 'GET' && path === '/healthz') return true;
  if (method === 'POST' && path === '/v1/rooms') return true;
  const match = /^\/v1\/rooms\/[A-HJ-NP-Z2-9]{8}(?:\/(join|moves|leave))?$/.exec(path || '');
  return !!match && (match[1] ? method === 'POST' : method === 'GET');
}
function responseHeaders(type = 'application/json') {
  return { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", 'Connection': 'close' };
}
function createRequestHandler(options = {}) {
  // Only an administrator-supplied numeric port is configurable, never hostname/URL.
  const upstreamPort = port(options.upstreamPort, 18795), timeoutMs = timeout(options.timeoutMs);
  return (req, res) => {
    let finished = false, upstream = null, upstreamResponse = null, phase = 'body';
    const finish = (status, body, type) => {
      if (finished) return;
      finished = true; clearTimeout(deadline);
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (upstreamResponse && !upstreamResponse.destroyed) upstreamResponse.destroy();
      if (!res.destroyed && !res.headersSent) { res.writeHead(status, responseHeaders(type)); res.end(body); }
      if (!req.complete) req.resume();
    };
    const fail = (status, code) => finish(status, JSON.stringify({ error: { code, message: '内测接口暂不可用，请稍后查询' } }));
    const deadline = setTimeout(() => fail(phase === 'body' ? 408 : 504, 'EDGE_TIMEOUT'), timeoutMs);
    deadline.unref();
    res.on('close', () => {
      clearTimeout(deadline);
      if (!finished) { finished = true; if (upstream) upstream.destroy(); if (upstreamResponse) upstreamResponse.destroy(); }
    });
    req.on('error', () => fail(400, 'INVALID_REQUEST'));
    req.on('aborted', () => fail(400, 'INVALID_REQUEST'));
    if (!allowed(req.method, req.url)) { fail(404, 'NOT_FOUND'); return; }
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) {
      fail(413, 'BODY_TOO_LARGE'); return;
    }
    if (req.method === 'GET' && (Number(declared) > 0 || req.headers['transfer-encoding'])) { fail(400, 'INVALID_REQUEST'); return; }
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY) { fail(413, 'BODY_TOO_LARGE'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      phase = 'upstream';
      const headers = {};
      for (const name of ['content-type', 'authorization', 'origin', 'x-357-access-key']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      const peer = req.socket.remoteAddress;
      if (!net.isIP(peer || '')) { fail(400, 'INVALID_PEER'); return; }
      headers['x-357-client-ip'] = peer;
      headers['content-length'] = String(size);
      try {
        upstream = http.request({ hostname: '127.0.0.1', family: 4, port: upstreamPort,
          method: req.method, path: req.url, headers, agent: false }, incoming => {
          upstreamResponse = incoming;
          if (finished) { incoming.destroy(); return; }
          const type = incoming.headers['content-type'];
          if (typeof type !== 'string' || !/^application\/json(?:\s*;.*)?$/i.test(type)) { fail(502, 'UPSTREAM_INVALID'); return; }
          const output = []; let outputSize = 0;
          incoming.on('data', chunk => {
            outputSize += chunk.length;
            if (outputSize > MAX_RESPONSE) { fail(502, 'UPSTREAM_INVALID'); return; }
            output.push(chunk);
          });
          incoming.on('error', () => fail(502, 'UPSTREAM_UNAVAILABLE'));
          incoming.on('aborted', () => fail(502, 'UPSTREAM_UNAVAILABLE'));
          incoming.on('end', () => finish(incoming.statusCode || 502, Buffer.concat(output), 'application/json'));
        });
        upstream.on('error', () => fail(502, 'UPSTREAM_UNAVAILABLE'));
        upstream.end(Buffer.concat(chunks));
      } catch (_) { fail(502, 'UPSTREAM_UNAVAILABLE'); }
    });
    // No logs of request paths, headers, bodies, avatar data, tokens or raw errors.
  };
}
function createTLSEdge(options = {}) {
  const handler = createRequestHandler(options);
  const server = https.createServer({ ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16384, handshakeTimeout: 5000 }, handler);
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 10;
  server.setTimeout(10000, socket => socket.destroy());
  server.on('connect', (_req, socket) => { socket.destroy(); });
  server.on('upgrade', (_req, socket) => { socket.destroy(); });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  server.on('tlsClientError', (_error, socket) => { socket.destroy(); });
  return server;
}
function dropRootPrivileges(runtime = process) {
  if (typeof runtime.getuid === 'function' && runtime.getuid() === 0) {
    runtime.setgroups([]); runtime.setgid(65534); runtime.setuid(65534);
    if (runtime.getuid() !== 65534 || runtime.getgid() !== 65534) throw new Error('Edge privilege drop failed');
  }
}
function main() {
  let server, stage = 'configuration validation';
  try {
    const listenPort = port(process.env.TLS_EDGE_PORT, 18086), upstreamPort = port(process.env.ROOMS_PORT, 18795);
    if (listenPort === upstreamPort) throw new Error('Edge and room ports must differ');
    if (!process.env.TLS_CERT || !process.env.TLS_KEY) throw new Error('TLS configuration missing');
    // TLS material is read only here, never copied, printed, exported or included in errors.
    const fs = require('node:fs');
    stage = 'TLS certificate/key file read (check administrator-provided paths and read permissions)';
    const cert = fs.readFileSync(process.env.TLS_CERT), key = fs.readFileSync(process.env.TLS_KEY);
    // https.createServer constructs its TLS context synchronously before privilege drop/listen.
    stage = 'TLS context creation';
    server = createTLSEdge({ upstreamPort, tls: { cert, key } });
    stage = 'root privilege drop';
    dropRootPrivileges();
    server.on('error', () => { process.stderr.write('357 TLS edge could not listen\n'); process.exitCode = 1; });
    server.listen(listenPort, '0.0.0.0', () => process.stdout.write('357 isolated TLS edge ready\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref();
    });
  } catch (_) {
    if (server) server.close();
    process.stderr.write('357 TLS edge startup failed during ' + stage + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { createRequestHandler, createTLSEdge, dropRootPrivileges, port, MAX_BODY, MAX_RESPONSE };
