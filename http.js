import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, msg) {
    super(msg || String(status));
    this.status = status;
  }
}

function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 16) {
    const e = new Error('CONFIG');
    e.config = true;
    throw e;
  }
  return s;
}

export function sign(obj) {
  const payload = b64u(JSON.stringify(obj));
  const mac = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return payload + '.' + mac;
}

export function unsign(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const good = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export class Form {
  constructor(params) {
    this.p = params;
  }
  get(k) {
    return (this.p.get(k) ?? '').toString();
  }
  str(k) {
    return this.get(k).trim();
  }
  all(k) {
    return this.p.getAll(k);
  }
  has(k) {
    return this.p.has(k);
  }
}

export class Ctx {
  constructor(req, res) {
    this.req = req;
    this.res = res;
    const u = new URL(req.url || '/', 'http://localhost');
    // Vercel передаёт исходный путь в __p (см. vercel.json)
    const p = u.searchParams.get('__p');
    u.searchParams.delete('__p');
    this.path = (p != null ? p : u.pathname).replace(/\/+$/, '') || '/';
    if (!this.path.startsWith('/')) this.path = '/' + this.path;
    this.query = u.searchParams;
    this.method = (req.method || 'GET').toUpperCase();
    this.cookies = parseCookies(req.headers.cookie);
    this.outCookies = [];
    this.flashOut = [];
    this.user = null;
    this.secure =
      !!process.env.VERCEL || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  }

  q(k) {
    return this.query.get(k) ?? '';
  }

  ip() {
    const xf = String(this.req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xf || this.req.socket?.remoteAddress || '';
  }

  host() {
    return String(this.req.headers['x-forwarded-host'] || this.req.headers.host || '');
  }

  async rawBody(limit) {
    // На случай, если платформа уже прочитала тело запроса сама
    if (this.req.readableEnded && this.req.body !== undefined) {
      const b = this.req.body;
      const buf = Buffer.isBuffer(b) ? b : typeof b === 'string' ? Buffer.from(b) : Buffer.from(new URLSearchParams(b).toString());
      if (buf.length > limit) throw new HttpError(413);
      return buf;
    }
    const chunks = [];
    let size = 0;
    for await (const c of this.req) {
      size += c.length;
      if (size > limit) throw new HttpError(413);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async form() {
    if (this._form) return this._form;
    const buf = await this.rawBody(2 * 1024 * 1024);
    this._form = new Form(new URLSearchParams(buf.toString('utf8')));
    return this._form;
  }

  /** Защита от подделки запросов с чужих сайтов */
  checkOrigin() {
    const origin = this.req.headers.origin;
    if (!origin || origin === 'null') {
      if (origin === 'null') throw new HttpError(403);
      return;
    }
    let h;
    try {
      h = new URL(origin).host;
    } catch {
      throw new HttpError(403);
    }
    if (h !== this.host()) throw new HttpError(403);
  }

  setCookie(name, value, { maxAge, httpOnly = true } = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
    if (httpOnly) c += '; HttpOnly';
    if (this.secure) c += '; Secure';
    if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
    this.outCookies.push(c);
  }

  flash(msg, type = 'ok') {
    this.flashOut.push([type, msg]);
  }

  /** Читает flash-сообщения прошлого запроса и стирает их */
  takeFlash() {
    const raw = this.cookies.flash;
    if (!raw) return [];
    this.setCookie('flash', '', { maxAge: 0 });
    try {
      const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  writeHead(status, headers = {}) {
    if (this.flashOut.length) {
      this.setCookie('flash', b64u(JSON.stringify(this.flashOut.slice(0, 10))), { maxAge: 120 });
    }
    const h = {
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...headers,
    };
    if (this.outCookies.length) h['Set-Cookie'] = this.outCookies;
    this.res.writeHead(status, h);
  }

  html(body, status = 200) {
    this.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    this.res.end(body);
  }

  json(obj, status = 200) {
    this.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    this.res.end(JSON.stringify(obj));
  }

  redirect(loc) {
    this.writeHead(303, { Location: loc, 'Cache-Control': 'no-store' });
    this.res.end();
  }
}

// ---------- пароли ----------

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

export function checkPassword(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

export function genPassword(len = 6) {
  const abc = 'abcdefghkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}

export function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}
