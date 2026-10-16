// Доступ к Supabase только с сервера (браузер учеников к Supabase не обращается).
// База — через функцию app_sql (REST /rpc), файлы — через Storage REST API.

const BUCKET = 'files';

function cfg() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    const e = new Error('CONFIG');
    e.config = true;
    throw e;
  }
  return { url, key };
}

function authHeaders(key, extra = {}) {
  const h = { apikey: key, ...extra };
  // Старые ключи (JWT, начинаются с eyJ) нужно передавать и в Authorization
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  return h;
}

// ---------- SQL ----------

class Raw {
  constructor(s) { this.s = s; }
}
/** Вставка готового куска SQL без параметров (только для констант из кода!) */
export const raw = (s) => new Raw(s);

/**
 * sql`select * from users where id = ${id}::bigint`
 * Каждое значение превращается в ($1->>N) — текст из JSON-массива параметров.
 * Массивы — в text[] (дальше приводите: ${ids}::bigint[]).
 */
export function sql(strings, ...vals) {
  let text = strings[0];
  const params = [];
  vals.forEach((v, i) => {
    if (v instanceof Raw) {
      text += v.s;
    } else if (v && typeof v === 'object' && 'text' in v && 'params' in v) {
      throw new Error('Вложенные sql`` не поддерживаются');
    } else {
      const n = params.length;
      if (Array.isArray(v)) {
        params.push(v.map((x) => (x === undefined || x === null ? null : String(x))));
        text += `(array(select jsonb_array_elements_text($1->${n})))`;
      } else {
        params.push(v === undefined || v === null ? null : typeof v === 'boolean' ? v : String(v));
        text += `($1->>${n})`;
      }
    }
    text += strings[i + 1];
  });
  return { text, params };
}

export async function query(q) {
  const { url, key } = cfg();
  const res = await fetch(url + '/rest/v1/rpc/app_sql', {
    method: 'POST',
    headers: authHeaders(key, { 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ q: q.text, p: q.params }),
  });
  const body = await res.text();
  if (!res.ok) {
    const e = new Error('Supabase ' + res.status + ': ' + body.slice(0, 500));
    try {
      const j = JSON.parse(body);
      e.pgCode = j.code;
    } catch {}
    throw e;
  }
  return JSON.parse(body) || [];
}

export async function one(q) {
  const rows = await query(q);
  return rows[0] || null;
}

// ---------- Storage ----------

function objUrl(url, path) {
  return url + '/storage/v1/object/' + BUCKET + '/' + path.split('/').map(encodeURIComponent).join('/');
}

export async function storagePut(path, buf, contentType) {
  const { url, key } = cfg();
  const res = await fetch(objUrl(url, path), {
    method: 'POST',
    headers: authHeaders(key, { 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buf,
  });
  if (!res.ok) throw new Error('Storage upload ' + res.status + ': ' + (await res.text()).slice(0, 300));
}

export async function storageGet(path) {
  const { url, key } = cfg();
  const res = await fetch(objUrl(url, path), { headers: authHeaders(key) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function storageRemove(paths) {
  paths = (paths || []).filter(Boolean);
  if (!paths.length) return;
  const { url, key } = cfg();
  try {
    await fetch(url + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE',
      headers: authHeaders(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: paths }),
    });
  } catch (e) {
    console.error('storage remove failed', e);
  }
}
