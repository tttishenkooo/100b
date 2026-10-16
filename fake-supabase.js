// Мини-эмулятор Supabase для локальной проверки: /rest/v1/rpc/app_sql → psql, Storage → папка.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DB = process.env.PGDATABASE || 'shkola';
const DIR = process.env.STORE_DIR || '/tmp/fake-storage';
const KEY = process.env.FAKE_KEY || 'sb_secret_test';
fs.mkdirSync(DIR, { recursive: true });

function body(req) {
  return new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
}
http.createServer(async (req, res) => {
  if (req.headers.apikey !== KEY) { res.writeHead(401); return res.end('{"message":"bad key"}'); }
  const u = new URL(req.url, 'http://x');
  const b = await body(req);
  if (u.pathname === '/rest/v1/rpc/app_sql') {
    const { q, p } = JSON.parse(b.toString());
    const child = execFile('psql', ['-d', DB, '-AtX', '-v', 'ON_ERROR_STOP=1', '-v', 'q=' + q, '-v', 'p=' + JSON.stringify(p)],
      { maxBuffer: 1 << 26 }, (err, out, se) => {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: se })); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out.trim());
    });
    child.stdin.end("select app_sql(:'q', :'p'::jsonb);");
    return;
  }
  const m = /^\/storage\/v1\/object\/files(?:\/(.*))?$/.exec(u.pathname);
  if (m) {
    if (req.method === 'DELETE') {
      for (const p of JSON.parse(b.toString()).prefixes) fs.rmSync(path.join(DIR, p), { force: true });
      res.writeHead(200); return res.end('[]');
    }
    const fp = path.join(DIR, decodeURIComponent(m[1]));
    if (!fp.startsWith(DIR)) { res.writeHead(400); return res.end(); }
    if (req.method === 'POST') { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, b); res.writeHead(200); return res.end('{}'); }
    if (fs.existsSync(fp)) { res.writeHead(200); return res.end(fs.readFileSync(fp)); }
    res.writeHead(404); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(54321, () => console.log('fake supabase on 54321'));
