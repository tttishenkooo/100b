export const APP_NAME = process.env.APP_NAME || 'Школьные задания';
export const TZ = process.env.APP_TIMEZONE || 'Europe/Moscow';
export const MAX_FILE_MB = 4; // ограничение Vercel на размер запроса — 4,5 МБ
export const MAX_FILES = 10;

export const ALLOWED_EXT = [
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp',
  'zip', 'rar', '7z', 'mp3', 'm4a', 'ogg', 'wav', 'mp4', 'mov', 'webm',
  'py', 'cpp', 'c', 'h', 'java', 'js', 'html', 'css', 'pas', 'cs', 'kt', 'go', 'sql', 'json', 'xml', 'md',
];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
export const TEXT_EXT = ['txt', 'py', 'cpp', 'c', 'h', 'java', 'js', 'html', 'css', 'pas', 'cs', 'kt', 'go', 'sql', 'json', 'xml', 'md', 'csv'];
export const MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

export function e(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Текст с переносами строк и кликабельными ссылками */
export function rich(s) {
  return e(s)
    .replace(/https?:\/\/[^\s<]+/g, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`)
    .replace(/\r?\n/g, '<br>');
}

export function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

export function fileExt(name) {
  const m = /\.([^.]+)$/.exec(String(name));
  return m ? m[1].toLowerCase() : '';
}

export function fmtSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return Math.round(b / 1024) + ' КБ';
  return (Math.round((b / 1048576) * 10) / 10).toString().replace('.', ',') + ' МБ';
}

// ---------- время (часовой пояс школы) ----------

function tzOffsetMin(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const g = (t) => +parts.find((p) => p.type === t).value;
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** '2026-10-20T18:00' (время школы) → ISO UTC */
export function inputToISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = tzOffsetMin(new Date(guess));
  return new Date(guess - off * 60000).toISOString();
}

export function isoToInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() + tzOffsetMin(d) * 60000).toISOString().slice(0, 16);
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso)).replace(',', '');
}

export function fmtDay(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(new Date(iso));
}

export const isPast = (iso) => !!iso && new Date(iso).getTime() < Date.now();
export const isLate = (sub, due) => !!due && !!sub && new Date(sub).getTime() > new Date(due).getTime();

// ---------- кусочки разметки ----------

export function statusBadge(s, due) {
  if (!s || !s.status) {
    if (isPast(due)) return '<span class="badge red">Не сдано, срок прошёл</span>';
    return '<span class="badge gray">Не сдано</span>';
  }
  if (s.status === 'graded') return `<span class="badge green">Оценка: ${e(s.score)}</span>`;
  if (s.status === 'returned') return '<span class="badge orange">На доработку</span>';
  return `<span class="badge blue">На проверке${isLate(s.submitted_at, due) ? ' (с опозданием)' : ''}</span>`;
}

export function classOptions(classes, selected, emptyLabel = '') {
  let h = emptyLabel !== '' ? `<option value="">${e(emptyLabel)}</option>` : '';
  for (const c of classes) {
    h += `<option value="${c.id}"${String(selected ?? '') === String(c.id) ? ' selected' : ''}>${e(c.name)}</option>`;
  }
  return h;
}

/** Список файлов. preview — показывать картинки, delName — чекбоксы удаления */
export function filesHtml(files, preview = false, delName = '') {
  if (!files || !files.length) return '';
  let imgs = '';
  let list = '';
  for (const f of files) {
    const href = '/file?id=' + f.id;
    if (preview && IMAGE_EXT.includes(fileExt(f.name))) {
      imgs += `<a class="thumb" href="${href}" target="_blank"><img src="${href}" alt="${e(f.name)}" loading="lazy"></a>`;
    }
    list += `<li><a href="${href}" target="_blank">📎 ${e(f.name)}</a> <span class="muted">${fmtSize(f.size)}</span>`;
    if (delName) list += ` <label class="del"><input type="checkbox" name="${e(delName)}" value="${f.id}"> удалить</label>`;
    list += '</li>';
  }
  return (imgs ? `<div class="thumbs">${imgs}</div>` : '') + `<ul class="files">${list}</ul>`;
}

export function fileInput() {
  return (
    `<input type="file" multiple data-files>` +
    `<div class="hint">До ${MAX_FILES} файлов, каждый до ${MAX_FILE_MB} МБ: фото, PDF, Word, презентации, архивы, код. Большие фото сжимаются автоматически.</div>` +
    `<div class="upstatus"></div>`
  );
}

// Загрузка файлов: по одному, через наш сервер; большие фото сжимаются в браузере
const UPLOAD_JS = `
(function(){
var MAX=${MAX_FILE_MB}*1048576;
function shrink(file){return new Promise(function(ok){
  if(!window.createImageBitmap){ok(null);return;}
  createImageBitmap(file).then(function(img){
    var k=Math.min(1,2000/Math.max(img.width,img.height));
    var c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    c.toBlob(function(b){ok(b)},'image/jpeg',0.85);
  }).catch(function(){ok(null)});
});}
document.querySelectorAll('form[data-upload]').forEach(function(f){
  f.addEventListener('submit',async function(ev){
    var inp=f.querySelector('input[data-files]');
    if(!inp||!inp.files.length)return;
    ev.preventDefault();
    var sub=ev.submitter, btns=f.querySelectorAll('button'), st=f.querySelector('.upstatus'), errs=[], files=[].slice.call(inp.files);
    btns.forEach(function(b){b.disabled=true});
    st.className='upstatus';
    for(var i=0;i<files.length;i++){
      var file=files[i], blob=file, name=file.name;
      st.textContent='Загружаю файл '+(i+1)+' из '+files.length+'…';
      if(/^image\\/(jpeg|png|webp|heic|heif)$/i.test(file.type)&&file.size>1.5*1048576){
        var s=await shrink(file); if(s&&s.size<file.size){blob=s;name=name.replace(/\\.[^.]+$/,'')+'.jpg';}
      }
      if(blob.size>MAX){errs.push('«'+name+'» больше ${MAX_FILE_MB} МБ');continue;}
      try{
        var r=await fetch('/upload?name='+encodeURIComponent(name),{method:'POST',body:blob,headers:{'Content-Type':blob.type||'application/octet-stream'}});
        var j=await r.json().catch(function(){return {error:'сервер не ответил'}});
        if(!r.ok){errs.push('«'+name+'»: '+(j.error||'ошибка'));continue;}
        var h=document.createElement('input');h.type='hidden';h.name='file_ids';h.value=j.id;f.appendChild(h);
      }catch(e){errs.push('«'+name+'»: нет связи');}
    }
    inp.value='';
    btns.forEach(function(b){b.disabled=false});
    if(errs.length){st.className='upstatus err';st.textContent='Не загрузились: '+errs.join('; ')+'. Остальные файлы прикреплены — нажмите кнопку ещё раз.';return;}
    st.textContent='Отправляю…';
    if(f.requestSubmit){f.requestSubmit(sub||undefined)}else{f.submit()}
  });
});
document.querySelectorAll('[data-confirm]').forEach(function(f){
  f.addEventListener('submit',function(ev){if(!window.confirm(f.getAttribute('data-confirm')))ev.preventDefault();});
});
document.querySelectorAll('[data-score]').forEach(function(b){
  b.addEventListener('click',function(){b.form.score.value=b.getAttribute('data-score');});
});
document.querySelectorAll('[data-autosubmit]').forEach(function(s){
  s.addEventListener('change',function(){s.form.submit();});
});
document.querySelectorAll('[data-print]').forEach(function(b){
  b.addEventListener('click',function(){window.print();});
});
})();`;

export function layout(ctx, title, body, { nav = '' } = {}) {
  const u = ctx.user;
  let header = `<a class="brand" href="/">${e(APP_NAME)}</a>`;
  if (u) {
    const links = u.role === 'teacher'
      ? [['/', 'Задания', ['/', '/task', '/edit', '/sub']], ['/students', 'Ученики', ['/students']], ['/journal', 'Журнал', ['/journal']]]
      : [['/', 'Мои задания', ['/', '/task']]];
    header += '<nav>' + links.map(([href, label, act]) =>
      `<a href="${href}"${act.includes(ctx.path) ? ' class="on"' : ''}>${label}</a>`).join('') + '</nav>';
    header += `<div class="me"><a href="/password" title="Сменить пароль">${e(u.name)}</a>` +
      `<form method="post" action="/logout"><button class="linkbtn">Выйти</button></form></div>`;
  }
  const flashes = (ctx.flashIn || []).map(([t, m]) => `<div class="flash ${t === 'err' ? 'err' : 'ok'}">${e(m)}</div>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)} · ${e(APP_NAME)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E📘%3C/text%3E%3C/svg%3E">
<style>${CSS}</style></head><body>
<header class="top"><div class="wrap bar">${header}</div></header>
<main class="wrap">${flashes}${body}</main>
<script>${UPLOAD_JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:#f6f7fb;--card:#fff;--text:#1d2433;--muted:#6b7385;--line:#e3e6ee;--brand:#3b5bdb;--brand2:#2f4ac0;
--green:#2b8a3e;--greenbg:#ebfbee;--red:#c92a2a;--redbg:#fff5f5;--orange:#d9480f;--orangebg:#fff4e6;--blue:#1971c2;--bluebg:#e7f5ff;--graybg:#f1f3f5}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
a{color:var(--brand)}
.wrap{max-width:980px;margin:0 auto;padding:0 16px}
main.wrap{padding-top:20px;padding-bottom:60px}
.top{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.bar{display:flex;align-items:center;gap:18px;min-height:56px;flex-wrap:wrap}
.brand{font-weight:700;font-size:18px;color:var(--text);text-decoration:none}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{padding:6px 12px;border-radius:8px;text-decoration:none;color:var(--muted);font-weight:500}
nav a.on,nav a:hover{background:var(--bluebg);color:var(--brand)}
.me{margin-left:auto;display:flex;gap:12px;align-items:center;font-size:14px}
.me a{color:var(--text);text-decoration:none}
.me form{margin:0}
h1{font-size:26px;margin:0;line-height:1.25}
h2{font-size:19px;margin:28px 0 10px}
h3{margin:0 0 12px;font-size:17px}
.muted{color:var(--muted)}.small{font-size:13px}
.pagehead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
.card.narrow{max-width:420px;margin:40px auto}
.empty{color:var(--muted);text-align:center;padding:30px}
.crumbs{margin:0 0 8px;font-size:14px}.crumbs a{text-decoration:none}
.meta{color:var(--muted);margin-bottom:14px;font-size:15px}
.past{color:var(--red)}
.flash{padding:10px 14px;border-radius:10px;margin-bottom:14px;background:var(--greenbg);color:var(--green);border:1px solid #b2f2bb}
.flash.err{background:var(--redbg);color:var(--red);border-color:#ffc9c9}
.callout{background:var(--bluebg);border:1px solid #a5d8ff;padding:12px 16px;border-radius:12px;margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;line-height:1.3}
.btn:hover{background:var(--brand2)}
.btn:disabled{opacity:.6;cursor:wait}
.btn.small{padding:6px 12px;font-size:14px}
.btn.ghost{background:#fff;color:var(--brand);border:1px solid var(--line)}
.btn.ghost:hover{background:var(--bluebg)}
.btn.warn{background:var(--orange)}
.btn.danger{background:#fff;color:var(--red);border:1px solid #ffc9c9}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--brand);cursor:pointer;text-decoration:underline}
.danger-text{color:var(--red)}
.danger-zone{margin-top:24px}
.form label,.field{display:block;margin-bottom:14px;font-weight:500}
.form .label{margin-bottom:6px}
input[type=text],input:not([type]),input[type=password],input[type=number],input[type=datetime-local],select,textarea{
display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #cdd3df;border-radius:10px;font:inherit;background:#fff;color:inherit}
textarea{resize:vertical;min-height:90px}
input:focus,select:focus,textarea:focus{outline:2px solid #a5c0ff;border-color:var(--brand)}
input[type=file]{margin-top:6px;max-width:100%}
.form label.check{display:flex;align-items:center;gap:8px;font-weight:400}
.hint{font-size:13px;color:var(--muted);font-weight:400;margin-top:4px}
.upstatus{font-size:14px;margin-top:6px;color:var(--blue);font-weight:500}.upstatus.err{color:var(--red)}
.row{display:grid;grid-template-columns:2fr 2fr 1fr;gap:12px}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.list{display:flex;flex-direction:column;gap:8px}
.item{display:flex;justify-content:space-between;align-items:center;gap:14px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;text-decoration:none;color:inherit}
.item:hover{border-color:#a5c0ff;box-shadow:0 2px 8px rgba(59,91,219,.08)}
.item-title{font-weight:600}
.item-side{display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.count{font-weight:700;font-size:17px}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600;white-space:nowrap}
.badge.gray{background:var(--graybg);color:var(--muted)}.badge.red{background:var(--redbg);color:var(--red)}
.badge.green{background:var(--greenbg);color:var(--green)}.badge.orange{background:var(--orangebg);color:var(--orange)}
.badge.blue{background:var(--bluebg);color:var(--blue)}
.tbl{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.tbl th,.tbl td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.tbl th{background:#fafbfd;font-size:13px;color:var(--muted);font-weight:600}
.tbl tr:last-child td{border-bottom:0}
.r{text-align:right}.c{text-align:center}
code{background:var(--graybg);padding:2px 6px;border-radius:6px;font-size:14px}
.task-body,.answer-text{word-wrap:break-word}
.answer-text{white-space:normal;margin-bottom:8px}
.files{list-style:none;padding:0;margin:10px 0 0}.files li{margin:4px 0}
.files .del{font-weight:400;font-size:13px;color:var(--red);display:inline;margin-left:8px}
.thumbs{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.thumb img{max-width:260px;max-height:260px;border-radius:10px;border:1px solid var(--line);display:block}
.feedback.good{border-color:#b2f2bb;background:var(--greenbg)}.feedback.warn{border-color:#ffd8a8;background:var(--orangebg)}
.big-score{font-size:40px;font-weight:800;color:var(--green);line-height:1}.big-score span{font-size:20px;color:var(--muted)}
.fb-title{font-weight:700;color:var(--orange)}.fb-text{margin-top:8px}
.score-row{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;margin-bottom:6px}
.score-row label{width:150px}
.quick{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.chip{border:1px solid var(--line);background:#fff;border-radius:8px;width:42px;height:42px;font:inherit;font-weight:700;cursor:pointer}
.chip:hover{background:var(--bluebg);border-color:var(--brand)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.tabs a{padding:6px 14px;border-radius:20px;background:#fff;border:1px solid var(--line);text-decoration:none;color:var(--text)}
.tabs a.on{background:var(--brand);border-color:var(--brand);color:#fff}
.inline-form{display:flex;gap:6px;margin-left:auto}
.inline-form input{margin:0;width:190px;padding:6px 10px}
.filter{margin-bottom:12px}.filter select{width:auto;display:inline-block}
.grid2{display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start}
details.menu{position:relative;display:inline-block}
details.menu summary{list-style:none;cursor:pointer;padding:2px 10px;border-radius:8px;font-weight:700}
details.menu summary::-webkit-details-marker{display:none}
details.menu[open] summary{background:var(--graybg)}
.menu-body{position:absolute;right:0;top:30px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;width:270px;z-index:3;box-shadow:0 8px 24px rgba(0,0,0,.1);text-align:left}
.menu-body form{margin:0 0 10px}.menu-body form:last-child{margin:0}
.mini{display:flex;gap:6px;align-items:center}.mini input,.mini select{margin:0;padding:6px 8px}
.journal-wrap{overflow-x:auto;border-radius:12px}
.journal th,.journal td{white-space:nowrap;padding:8px 10px}
.journal th a{color:var(--text);text-decoration:none}
.sticky{position:sticky;left:0;background:#fff;z-index:1}
.cell{display:inline-block;min-width:30px;padding:3px 6px;border-radius:6px;font-weight:700;text-decoration:none}
.g5{background:var(--greenbg);color:var(--green)}.g4{background:#e6fcf5;color:#087f5b}.g3{background:#fff9db;color:#e67700}.g2{background:var(--redbg);color:var(--red)}
.pend{color:var(--blue)}.ret{color:var(--orange)}.miss{color:#adb5bd}
.creds{border:2px dashed var(--brand)}
@media (max-width:760px){
.row{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}
.item{flex-direction:column;align-items:flex-start}.item-side{justify-content:flex-start}
.inline-form{margin-left:0;width:100%}.inline-form input{flex:1;width:auto}
h1{font-size:22px}.me{margin-left:0}
.tbl th,.tbl td{padding:8px}
}
@media print{.top,.tabs,.grid2>form,.btn,.danger-zone{display:none!important}body{background:#fff}.card{border:0}}
`;
