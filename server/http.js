'use strict';

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRoomService, RoomError, CODE } = require('./rooms');
const MAX_BODY = 180 * 1024;
function createHTTPServer(options = {}) {
  const service = options.service || createRoomService(options);
  const limits = new Map(), now = options.now || Date.now;
  const maxIPs = options.maxIPs || 1000;
  const accessKey = options.accessKey || '';
  if (accessKey && !/^[a-f0-9]{64}$/.test(accessKey)) throw new Error('Invalid internal-test access configuration');
  function rate(ip, kind) {
    const time = now();
    for (const [key, bucket] of limits) if (time >= bucket.until) limits.delete(key);
    const key = ip + ':' + kind;
    let bucket = limits.get(key);
    if (!bucket) {
      if (limits.size >= maxIPs * 3) throw new RoomError(429, 'RATE_LIMIT', '内测请求过多，请稍后再试');
      bucket = { until: time + 60000, count: 0 }; limits.set(key, bucket);
    }
    const max = kind === 'create' ? 6 : kind === 'join' ? 20 : 180;
    if (++bucket.count > max) throw new RoomError(429, 'RATE_LIMIT', '请求过于频繁，请稍后再试');
  }
  async function readBody(req) {
    const type = req.headers['content-type'] || '';
    if (!/^application\/json(?:\s*;.*)?$/i.test(type)) throw new RoomError(415, 'JSON_REQUIRED', '请使用JSON请求');
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); throw new RoomError(413, 'BODY_TOO_LARGE', '请求内容过大'); }
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new RoomError(413, 'BODY_TOO_LARGE', '请求内容过大');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw new RoomError(400, 'INVALID_JSON', 'JSON格式无效'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RoomError(400, 'INVALID_JSON', 'JSON须为对象');
    return body;
  }
  function respond(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", 'Connection': 'close' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    try {
      // Trust only our explicit loopback TLS proxy, which overwrites this header.
      // Never trust public X-Forwarded-For or enable proxy trust by default.
      const peer = req.socket.remoteAddress || 'unknown';
      const forwarded = req.headers['x-357-client-ip'];
      const trusted = options.trustLocalProxy === true && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
      const ip = trusted && typeof forwarded === 'string' && net.isIP(forwarded) ? forwarded : peer;
      const url = new URL(req.url, 'http://localhost');
      if (url.search || url.hash) throw new RoomError(400, 'NO_QUERY', '接口不接受查询参数或令牌');
      if (req.headers.origin && req.headers.origin !== options.allowedOrigin) throw new RoomError(403, 'ORIGIN_REJECTED', '不接受该网页来源的请求');
      if (req.method === 'GET' && url.pathname === '/healthz') return respond(res, 200, { ok: true, service: '357-rooms' });
      let kind = 'other';
      if (req.method === 'POST' && url.pathname === '/v1/rooms') kind = 'create';
      else if (req.method === 'POST' && /\/join$/.test(url.pathname)) kind = 'join';
      rate(ip, kind);
      if (accessKey) {
        const supplied = req.headers['x-357-access-key'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
            !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(accessKey))) {
          throw new RoomError(403, 'INTERNAL_TEST_ONLY', '当前入口仅向本次内测构建开放');
        }
      }
      if (kind === 'create') {
        const body = await readBody(req);
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'profile')) throw new RoomError(400, 'INVALID_PROFILE', '仅接受本局头像资料');
        return respond(res, 200, service.create(body.profile));
      }
      const match = /^\/v1\/rooms\/([A-HJ-NP-Z2-9]{8})(?:\/(join|moves|leave))?$/.exec(url.pathname);
      if (!match || !CODE.test(match[1])) throw new RoomError(404, 'NOT_FOUND', '接口不存在');
      const [, code, action] = match;
      if (req.method === 'POST' && action === 'join') {
        const body = await readBody(req);
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'profile')) throw new RoomError(400, 'INVALID_PROFILE', '仅接受本局头像资料');
        return respond(res, 200, service.join(code, body.profile));
      }
      const auth = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
      if (!auth) throw new RoomError(401, 'UNAUTHORIZED', '需要有效房间会话');
      if (req.method === 'GET' && !action) return respond(res, 200, service.read(code, auth[1]));
      if (req.method === 'POST' && action === 'moves') return respond(res, 200, service.move(code, auth[1], await readBody(req)));
      if (req.method === 'POST' && action === 'leave') {
        const body = await readBody(req);
        if (Object.keys(body).length) throw new RoomError(400, 'INVALID_LEAVE', '离开请求无效');
        return respond(res, 200, service.leave(code, auth[1]));
      }
      throw new RoomError(405, 'METHOD_NOT_ALLOWED', '请求方式不支持');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const known = error instanceof RoomError;
        respond(res, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : '房间服务暂不可用，请稍后查询' } });
      }
      // Deliberately no raw request, token, room code, body, avatar or stack logging.
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 3000;
  const sweep = setInterval(() => service.sweep(), 30000); sweep.unref();
  server.on('close', () => clearInterval(sweep));
  server.roomService = service;
  return server;
}
if (require.main === module) {
  const host = process.env.ROOMS_HOST || '127.0.0.1', port = Number(process.env.ROOMS_PORT || 18795);
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Room service must bind loopback behind the isolated TLS proxy');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid room service port');
  const accessKey = process.env.ROOMS_ACCESS_KEY;
  if (!/^[a-f0-9]{64}$/.test(accessKey || '')) throw new Error('Internal-test access key is required; refusing to start an open service');
  const server = createHTTPServer({ trustLocalProxy: process.env.ROOMS_TRUST_LOCAL_PROXY === '1', accessKey });
  server.listen(port, host, () => process.stdout.write('357 isolated room service listening on loopback\n'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}
module.exports = { createHTTPServer, MAX_BODY };
