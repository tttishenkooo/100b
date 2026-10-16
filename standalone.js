// Запуск без Vercel — на любом сервере с Node.js 20+: node standalone.js (переменные — в файле .env или окружении)
import http from 'node:http';
import fs from 'node:fs';
import { handle } from './lib/app.js';

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const port = +(process.env.PORT || 3000);
http.createServer(handle).listen(port, () => console.log('http://localhost:' + port));
