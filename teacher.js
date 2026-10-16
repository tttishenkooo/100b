import { sql, query, one } from './supabase.js';
import { HttpError, hashPassword, genPassword, randomToken } from './http.js';
import {
  layout, e, rich, fmtDate, fmtDay, plural, statusBadge, classOptions, filesHtml, fileInput,
  isPast, isLate, inputToISO, isoToInput,
} from './view.js';
import { filesOf, attachFiles, deleteSelectedFiles, deleteSubmission, deleteAssignment, deleteStudent } from './files.js';

const classesList = () => query(sql`select id, name from classes order by name`);
const avg = (sum, n) => (n ? String(Math.round((sum / n) * 100) / 100).replace('.', ',') : '');

// ---------- список заданий ----------

export async function home(ctx) {
  const cid = ctx.q('class');
  const cidNum = cid === '' ? null : parseInt(cid, 10) || 0;
  const [rows, pend, cls] = await Promise.all([
    query(sql`select a.id, a.title, a.due_at, a.class_id, c.name as cname,
        (select count(*)::int from submissions s where s.assignment_id = a.id) as subs,
        (select count(*)::int from submissions s where s.assignment_id = a.id and s.status = 'submitted') as pending,
        (select count(*)::int from users st where st.role = 'student' and (a.class_id is null or st.class_id = a.class_id)) as total
      from assignments a left join classes c on c.id = a.class_id
      where ${cidNum}::bigint is null or a.class_id = ${cidNum}::bigint or a.class_id is null
      order by a.id desc`),
    one(sql`select count(*)::int n, (select id from submissions where status = 'submitted' order by submitted_at limit 1) as next
      from submissions where status = 'submitted'`),
    classesList(),
  ]);

  let h = '<div class="pagehead"><h1>Задания</h1><a class="btn" href="/edit">+ Новое задание</a></div>';
  if (pend.n) {
    h += `<div class="callout">Ждут проверки: <b>${pend.n}</b> ${plural(pend.n, 'работа', 'работы', 'работ')}
<a class="btn small" href="/sub?id=${pend.next}">Проверить →</a></div>`;
  }
  if (!cls.length) {
    h += '<div class="card"><p>Сначала <a href="/students">создайте класс и добавьте учеников</a>, потом публикуйте задания.</p></div>';
  } else if (cls.length > 1) {
    h += `<form class="filter" method="get"><select name="class" data-autosubmit>${classOptions(cls, cidNum, 'Все классы')}</select></form>`;
  }
  if (!rows.length) h += '<div class="card empty">Заданий пока нет. Нажмите «Новое задание».</div>';
  h += '<div class="list">' + rows.map((a) => `<a class="item" href="/task?id=${a.id}">
<div class="item-main"><div class="item-title">${e(a.title)}</div>
<div class="muted small">${e(a.cname ?? 'Все классы')} · срок: ${a.due_at ? `<span${isPast(a.due_at) ? ' class="past"' : ''}>${fmtDate(a.due_at)}</span>` : 'без срока'}</div></div>
<div class="item-side"><span class="count">${a.subs} / ${a.total}</span><span class="muted small">сдали</span>
${a.pending ? `<span class="badge blue">${a.pending} на проверке</span>` : ''}</div></a>`).join('') + '</div>';
  ctx.html(layout(ctx, 'Задания', h));
}

// ---------- создание / редактирование задания ----------

export async function edit(ctx) {
  let id = parseInt(ctx.q('id'), 10) || 0;
  const a = id ? await one(sql`select * from assignments where id = ${id}::bigint`) : null;
  if (id && !a) throw new HttpError(404);
  const errors = [];
  let v = a
    ? { ...a, due_in: isoToInput(a.due_at) }
    : { title: '', body: '', class_id: null, due_in: '', max_score: 5, strict: false };

  if (ctx.method === 'POST') {
    const f = await ctx.form();
    if (f.get('action') === 'delete' && a) {
      await deleteAssignment(id);
      ctx.flash('Задание удалено.');
      return ctx.redirect('/');
    }
    const title = f.str('title').slice(0, 200);
    const body = f.str('body');
    const classId = f.get('class_id') === '' ? null : parseInt(f.get('class_id'), 10) || null;
    const dueRaw = f.str('due_at');
    let due = null;
    if (dueRaw !== '') {
      due = inputToISO(dueRaw);
      if (!due) errors.push('Неверная дата сдачи.');
    }
    const max = Math.max(1, Math.min(100, parseInt(f.get('max_score'), 10) || 5));
    const strict = f.get('strict') === '1';
    if (!title) errors.push('Введите название задания.');
    if (!errors.length) {
      if (a) {
        await query(sql`update assignments set title = ${title}, body = ${body}, class_id = ${classId}::bigint,
          due_at = ${due}::timestamptz, max_score = ${max}::int, strict = ${strict}::boolean
          where id = ${id}::bigint returning id`);
      } else {
        const r = await one(sql`insert into assignments (title, body, class_id, due_at, max_score, strict)
          values (${title}, ${body}, ${classId}::bigint, ${due}::timestamptz, ${max}::int, ${strict}::boolean) returning id`);
        id = r.id;
      }
      await deleteSelectedFiles(f, 'assignment', id);
      const ferr = await attachFiles(ctx, f, 'assignment', id);
      if (ferr) ctx.flash(ferr, 'err');
      ctx.flash(a ? 'Задание сохранено.' : 'Задание опубликовано — ученики уже его видят.');
      return ctx.redirect('/task?id=' + id);
    }
    v = { title, body, class_id: f.get('class_id'), due_in: dueRaw, max_score: max, strict };
  }

  const [cls, af] = await Promise.all([classesList(), a ? filesOf('assignment', id) : []]);
  let h = `<div class="pagehead"><h1>${a ? 'Редактирование задания' : 'Новое задание'}</h1></div>`;
  h += errors.map((er) => `<div class="flash err">${e(er)}</div>`).join('');
  h += `<form method="post" class="card form" data-upload>
<label>Название<input name="title" required maxlength="200" value="${e(v.title)}" placeholder="Например: Упражнение 145, стр. 72"></label>
<label>Текст задания<textarea name="body" rows="8" placeholder="Что нужно сделать. Ссылки станут кликабельными.">${e(v.body)}</textarea></label>
<div class="row">
<label>Для кого<select name="class_id">${classOptions(cls, v.class_id, 'Все классы')}</select></label>
<label>Сдать до<input type="datetime-local" name="due_at" value="${e(v.due_in)}"></label>
<label>Макс. балл<input type="number" name="max_score" min="1" max="100" value="${e(v.max_score)}"></label>
</div>
<label class="check"><input type="checkbox" name="strict" value="1"${v.strict ? ' checked' : ''}> Не принимать ответы после срока</label>
<div class="field"><div class="label">Файлы к заданию</div>${filesHtml(af, false, 'del_files')}${fileInput()}</div>
<div class="actions"><button class="btn">${a ? 'Сохранить' : 'Опубликовать'}</button>
<a class="btn ghost" href="${a ? '/task?id=' + id : '/'}">Отмена</a></div></form>`;
  if (a) {
    h += `<form method="post" class="danger-zone" data-confirm="Удалить задание вместе со всеми ответами учеников?">
<input type="hidden" name="action" value="delete"><button class="btn danger">Удалить задание</button></form>`;
  }
  ctx.html(layout(ctx, a ? 'Редактирование' : 'Новое задание', h));
}

// ---------- задание: ответы учеников ----------

export async function task(ctx) {
  const id = parseInt(ctx.q('id'), 10) || 0;
  const a = await one(sql`select a.*, c.name as cname from assignments a left join classes c on c.id = a.class_id where a.id = ${id}::bigint`);
  if (!a) throw new HttpError(404);
  const [rows, af] = await Promise.all([
    query(sql`select u.id as uid, u.name, c.name as cname, s.id as sid, s.status, s.score, s.submitted_at
      from users u
      left join classes c on c.id = u.class_id
      left join submissions s on s.student_id = u.id and s.assignment_id = ${id}::bigint
      where u.role = 'student' and (${a.class_id}::bigint is null or u.class_id = ${a.class_id}::bigint or s.id is not null)
      order by c.name nulls last, u.name`),
    filesOf('assignment', id),
  ]);
  const done = rows.filter((r) => r.sid).length;

  let h = `<p class="crumbs"><a href="/">← Все задания</a></p>
<div class="pagehead"><h1>${e(a.title)}</h1><a class="btn ghost" href="/edit?id=${id}">Изменить</a></div>
<div class="meta">${e(a.cname ?? 'Все классы')} · срок: ${a.due_at ? fmtDate(a.due_at) : 'без срока'}${a.strict ? ' (после срока не принимается)' : ''} · макс. балл: ${a.max_score}</div>`;
  if (a.body || af.length) h += `<div class="card task-body">${rich(a.body)}${filesHtml(af, true)}</div>`;
  h += `<h2>Ответы учеников <span class="muted">${done} из ${rows.length}</span></h2>`;
  if (!rows.length) {
    h += '<div class="card empty">В этом классе пока нет учеников. <a href="/students">Добавить</a></div>';
  } else {
    h += '<table class="tbl"><thead><tr><th>Ученик</th><th>Статус</th><th>Сдано</th><th></th></tr></thead><tbody>';
    for (const r of rows) {
      const s = r.sid ? r : null;
      h += `<tr><td>${e(r.name)}${a.class_id === null ? ` <span class="muted small">${e(r.cname ?? '')}</span>` : ''}</td>
<td>${statusBadge(s, a.due_at)}</td><td class="muted small">${s ? fmtDate(r.submitted_at) : ''}</td>
<td class="r">${s ? `<a class="btn small${r.status === 'submitted' ? '' : ' ghost'}" href="/sub?id=${r.sid}">${r.status === 'submitted' ? 'Проверить' : 'Открыть'}</a>` : ''}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  ctx.html(layout(ctx, a.title, h));
}

// ---------- проверка ответа ----------

export async function sub(ctx) {
  const sid = parseInt(ctx.q('id'), 10) || 0;
  const s = await one(sql`select s.*, u.name as sname, c.name as cname from submissions s
    join users u on u.id = s.student_id left join classes c on c.id = u.class_id where s.id = ${sid}::bigint`);
  if (!s) throw new HttpError(404);
  const a = await one(sql`select * from assignments where id = ${s.assignment_id}::bigint`);
  let err = '';
  let posted = null;

  if (ctx.method === 'POST') {
    const f = await ctx.form();
    const action = f.get('action');
    const feedback = f.str('feedback');
    posted = { feedback, score: f.str('score') };
    if (action === 'grade') {
      const raw = f.str('score');
      if (!/^\d+$/.test(raw) || +raw > a.max_score) {
        err = `Поставьте балл от 0 до ${a.max_score}.`;
      } else {
        await query(sql`update submissions set status = 'graded', score = ${raw}::int, feedback = ${feedback}, graded_at = now()
          where id = ${sid}::bigint returning id`);
        ctx.flash(`Оценка сохранена: ${s.sname} — ${+raw}`);
      }
    } else if (action === 'return') {
      if (!feedback) {
        err = 'Напишите комментарий — что нужно исправить.';
      } else {
        await query(sql`update submissions set status = 'returned', score = null, feedback = ${feedback}, graded_at = now()
          where id = ${sid}::bigint returning id`);
        ctx.flash('Работа возвращена на доработку.');
      }
    } else if (action === 'delete') {
      await deleteSubmission(sid);
      ctx.flash('Ответ удалён — ученик сможет сдать заново.');
      return ctx.redirect('/task?id=' + a.id);
    }
    if (!err) {
      // сразу к следующей непроверенной работе этого задания
      const next = await one(sql`select id from submissions where assignment_id = ${a.id}::bigint and status = 'submitted'
        order by submitted_at limit 1`);
      return ctx.redirect(next ? '/sub?id=' + next.id : '/task?id=' + a.id);
    }
  }

  const [sf, left] = await Promise.all([
    filesOf('submission', sid),
    one(sql`select count(*)::int n from submissions where assignment_id = ${a.id}::bigint and status = 'submitted' and id <> ${sid}::bigint`),
  ]);
  const fb = posted ? posted.feedback : s.feedback;
  const sc = posted ? posted.score : s.score ?? '';

  let h = `<p class="crumbs"><a href="/task?id=${a.id}">← ${e(a.title)}</a></p>
<div class="pagehead"><h1>${e(s.sname)} <span class="muted">${e(s.cname ?? '')}</span></h1>${statusBadge(s, a.due_at)}</div>
<div class="meta">Сдано ${fmtDate(s.submitted_at)}${isLate(s.submitted_at, a.due_at) ? ' <span class="past">— после срока</span>' : ''}${left.n ? ' · ещё на проверке: ' + left.n : ''}</div>
<div class="card answer">${s.text ? `<div class="answer-text">${rich(s.text)}</div>` : '<p class="muted">Текстового ответа нет.</p>'}${filesHtml(sf, true)}</div>`;
  if (err) h += `<div class="flash err">${e(err)}</div>`;
  h += `<form method="post" class="card form grade">
<div class="score-row"><label>Балл (из ${a.max_score})<input type="number" name="score" min="0" max="${a.max_score}" value="${e(sc)}" inputmode="numeric"></label>`;
  if (a.max_score <= 10) {
    h += '<div class="quick">';
    for (let i = a.max_score; i >= (a.max_score === 5 ? 2 : 0); i--) h += `<button type="button" class="chip" data-score="${i}">${i}</button>`;
    h += '</div>';
  }
  h += `</div><label>Комментарий для ученика<textarea name="feedback" rows="4" placeholder="Молодец! / Проверь задание 3…">${e(fb)}</textarea></label>
<div class="actions"><button class="btn" name="action" value="grade">Поставить оценку</button>
<button class="btn warn" name="action" value="return">Вернуть на доработку</button></div></form>
<form method="post" class="danger-zone" data-confirm="Удалить ответ ученика полностью?">
<input type="hidden" name="action" value="delete"><button class="linkbtn danger-text">Удалить этот ответ</button></form>`;
  ctx.html(layout(ctx, s.sname, h));
}

// ---------- ученики и классы ----------

const translitMap = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const translit = (s) => [...s.toLowerCase()].map((ch) => translitMap[ch] ?? ch).join('').replace(/[^a-z0-9]/g, '');

/** "Иванов Пётр" → ivanov.p (с цифрой, если занято) */
function loginBase(fullName) {
  const parts = fullName.trim().split(/\s+/);
  let base = translit(parts[0] || '');
  if (parts[1]) base += '.' + translit(parts[1]).slice(0, 1);
  base = base.replace(/^\.+|\.+$/g, '');
  return base || 'uchenik';
}

export async function students(ctx) {
  if (ctx.method === 'POST') return studentsPost(ctx);

  const cls = await classesList();
  const hasQ = ctx.query.has('class') && ctx.q('class') !== '';
  const cid = hasQ ? parseInt(ctx.q('class'), 10) || 0 : cls[0]?.id ?? 0;
  const credsToken = ctx.q('creds');
  const [noClass, list, creds] = await Promise.all([
    one(sql`select count(*)::int n from users where role = 'student' and class_id is null`),
    query(sql`select id, name, login, class_id from users where role = 'student'
      and (case when ${cid}::bigint = 0 then class_id is null else class_id = ${cid}::bigint end) order by name`),
    credsToken
      ? one(sql`with old as (delete from creds_once where created_at < now() - interval '1 hour' returning 1)
          delete from creds_once where token = ${credsToken} returning data`)
      : null,
  ]);

  let h = '<div class="pagehead"><h1>Ученики</h1></div>';
  // только что созданные логины/пароли — показываются один раз
  if (creds) {
    h += `<div class="card creds"><div class="pagehead"><h2 style="margin:0">Данные для входа</h2><button class="btn small ghost" data-print>Распечатать</button></div>
<p class="muted small">Адрес сайта: <b>${e(ctx.host())}</b>. Сохраните или распечатайте — пароли больше не покажутся (можно только выдать новый).</p>
<table class="tbl"><thead><tr><th>Ученик</th><th>Логин</th><th>Пароль</th></tr></thead><tbody>` +
      creds.data.map(([n, l, p]) => `<tr><td>${e(n)}</td><td><code>${e(l)}</code></td><td><code>${e(p)}</code></td></tr>`).join('') +
      '</tbody></table></div>';
  }

  h += '<div class="tabs">' + cls.map((c) => `<a href="/students?class=${c.id}"${c.id === cid ? ' class="on"' : ''}>${e(c.name)}</a>`).join('');
  if (noClass.n) h += `<a href="/students?class=0"${cid === 0 && hasQ ? ' class="on"' : ''}>Без класса (${noClass.n})</a>`;
  h += `<form method="post" class="inline-form"><input type="hidden" name="action" value="add_class">
<input name="name" placeholder="Новый класс, напр. 7Б" required maxlength="50"><button class="btn small">Создать</button></form></div>`;

  if (!cls.length && !noClass.n) {
    h += '<div class="card empty">Создайте первый класс — например «5А» или «Кружок Python».</div>';
    return ctx.html(layout(ctx, 'Ученики', h));
  }

  h += '<div class="grid2"><div>';
  if (!list.length) {
    h += '<div class="card empty">В классе пока никого нет. Добавьте учеников справа.</div>';
  } else {
    h += '<table class="tbl students"><thead><tr><th>Ученик</th><th>Логин</th><th></th></tr></thead><tbody>';
    for (const st of list) {
      const hid = `<input type="hidden" name="id" value="${st.id}"><input type="hidden" name="class" value="${cid}">`;
      h += `<tr><td>${e(st.name)}</td><td><code>${e(st.login)}</code></td><td class="r">
<details class="menu"><summary>⋯</summary><div class="menu-body">
<form method="post">${hid}<button name="action" value="reset" class="linkbtn">Выдать новый пароль</button></form>
<form method="post" class="mini">${hid}<input name="name" value="${e(st.name)}"><button name="action" value="rename" class="btn small ghost">Переименовать</button></form>
<form method="post" class="mini">${hid}<select name="to">${classOptions(cls, st.class_id, '— без класса —')}</select><button name="action" value="move" class="btn small ghost">Перевести</button></form>
<form method="post" data-confirm="Удалить ученика и все его ответы?">${hid}<button name="action" value="del_student" class="linkbtn danger-text">Удалить ученика</button></form>
</div></details></td></tr>`;
    }
    h += '</tbody></table>';
  }
  if (cid && !list.length) {
    h += `<form method="post" data-confirm="Удалить пустой класс?"><input type="hidden" name="id" value="${cid}">
<button name="action" value="del_class" class="linkbtn danger-text">Удалить этот класс</button></form>`;
  }
  h += '</div>';
  if (cls.length) {
    h += `<form method="post" class="card form"><h3>Добавить учеников</h3>
<input type="hidden" name="action" value="add_students">
<label>В класс<select name="class_id">${classOptions(cls, cid || cls[0].id)}</select></label>
<label>Фамилия и имя — по одному на строку<textarea name="names" rows="8" required placeholder="Иванов Пётр&#10;Смирнова Алиса&#10;Ким Даниил"></textarea></label>
<div class="hint">Логины и пароли создадутся автоматически.</div><br>
<button class="btn">Добавить</button></form>`;
  }
  h += '</div>';
  ctx.html(layout(ctx, 'Ученики', h));
}

async function saveCreds(ctx, creds, classParam) {
  const token = randomToken();
  await query(sql`insert into creds_once (token, data) values (${token}, ${JSON.stringify(creds)}::jsonb) returning 1`);
  return ctx.redirect(`/students?class=${encodeURIComponent(classParam)}&creds=${token}`);
}

async function studentsPost(ctx) {
  const f = await ctx.form();
  const action = f.get('action');
  const id = parseInt(f.get('id'), 10) || 0;
  const back = (c) => ctx.redirect('/students' + (c !== '' && c != null ? '?class=' + encodeURIComponent(c) : ''));

  if (action === 'add_class') {
    const name = f.str('name').slice(0, 50);
    if (!name) {
      ctx.flash('Введите название класса.', 'err');
      return back('');
    }
    const r = await one(sql`insert into classes (name) values (${name}) on conflict (name) do nothing returning id`);
    if (!r) {
      ctx.flash('Такой класс уже есть.', 'err');
      return back('');
    }
    ctx.flash(`Класс «${name}» создан. Теперь добавьте учеников.`);
    return back(r.id);
  }

  if (action === 'del_class') {
    const r = await one(sql`delete from classes c where c.id = ${id}::bigint
      and not exists (select 1 from users where class_id = c.id)
      and not exists (select 1 from assignments where class_id = c.id) returning id`);
    ctx.flash(r ? 'Класс удалён.' : 'Нельзя удалить класс, пока в нём есть ученики или задания.', r ? 'ok' : 'err');
    return back('');
  }

  if (action === 'add_students') {
    const classId = parseInt(f.get('class_id'), 10) || null;
    const names = f.get('names').split(/\r?\n/).map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 200);
    if (!names.length) return back(classId ?? '');
    const bases = names.map(loginBase);
    // занятые логины с такими же основами
    const taken = new Set((await query(sql`select lower(login) as l from users
      where lower(login) ~ ('^(' || ${bases.map((b) => b.replace(/\./g, '\\.')).join('|')} || ')[0-9]*$')`)).map((r) => r.l));
    const creds = [];
    const rows = [];
    for (let i = 0; i < names.length; i++) {
      let login = bases[i];
      let k = 2;
      while (taken.has(login)) login = bases[i] + k++;
      taken.add(login);
      const pass = genPassword();
      creds.push([names[i], login, pass]);
      rows.push({ login, name: names[i], pass: hashPassword(pass) });
    }
    await query(sql`insert into users (role, login, name, pass, class_id)
      select 'student', r->>'login', r->>'name', r->>'pass', ${classId}::bigint
      from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) r returning id`);
    ctx.flash(`Добавлено учеников: ${creds.length}.`);
    return saveCreds(ctx, creds, classId ?? '');
  }

  if (action === 'reset') {
    const pass = genPassword();
    const st = await one(sql`update users set pass = ${hashPassword(pass)}, token_v = token_v + 1
      where id = ${id}::bigint and role = 'student' returning name, login`);
    if (!st) return back(f.get('class'));
    ctx.flash('Новый пароль выдан.');
    return saveCreds(ctx, [[st.name, st.login, pass]], f.get('class'));
  }

  if (action === 'move') {
    const to = f.get('to') === '' ? null : parseInt(f.get('to'), 10) || null;
    await query(sql`update users set class_id = ${to}::bigint where id = ${id}::bigint and role = 'student' returning id`);
    ctx.flash('Ученик переведён.');
    return back(to ?? 0);
  }

  if (action === 'rename') {
    const name = f.str('name');
    if (name) {
      await query(sql`update users set name = ${name} where id = ${id}::bigint and role = 'student' returning id`);
      ctx.flash('Имя изменено.');
    }
    return back(f.get('class'));
  }

  if (action === 'del_student') {
    await deleteStudent(id);
    ctx.flash('Ученик удалён вместе с его ответами.');
    return back(f.get('class'));
  }
  return back('');
}

// ---------- журнал ----------

export async function journal(ctx) {
  const cls = await classesList();
  if (!cls.length) {
    return ctx.html(layout(ctx, 'Журнал', '<div class="card empty">Сначала <a href="/students">создайте класс</a>.</div>'));
  }
  const cid = parseInt(ctx.q('class'), 10) || cls[0].id;
  const cname = cls.find((c) => c.id === cid)?.name || '';
  const [students, tasks, subsRows] = await Promise.all([
    query(sql`select id, name from users where role = 'student' and class_id = ${cid}::bigint order by name`),
    query(sql`select id, title, due_at, max_score from assignments where class_id = ${cid}::bigint or class_id is null order by id`),
    query(sql`select s.assignment_id, s.student_id, s.status, s.score, s.id from submissions s
      join users u on u.id = s.student_id where u.class_id = ${cid}::bigint`),
  ]);
  const subs = {};
  for (const s of subsRows) (subs[s.student_id] ||= {})[s.assignment_id] = s;

  if (ctx.query.has('csv')) {
    const cell = (v) => {
      const s = String(v ?? '');
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['Ученик', ...tasks.map((t) => t.title), 'Средний балл'].map(cell).join(';')];
    for (const st of students) {
      const row = [st.name];
      let sum = 0, n = 0;
      for (const t of tasks) {
        const s = subs[st.id]?.[t.id];
        if (s && s.status === 'graded') { row.push(s.score); sum += s.score; n++; }
        else if (s) row.push(s.status === 'returned' ? 'доработка' : 'сдано');
        else row.push('');
      }
      row.push(avg(sum, n));
      lines.push(row.map(cell).join(';'));
    }
    ctx.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('Журнал ' + cname + '.csv')}`,
      'Cache-Control': 'no-store',
    });
    return ctx.res.end('﻿' + lines.join('\r\n'));
  }

  let h = `<div class="pagehead"><h1>Журнал</h1><a class="btn ghost small" href="/journal?class=${cid}&csv=1">Скачать для Excel</a></div>`;
  h += '<div class="tabs">' + cls.map((c) => `<a href="/journal?class=${c.id}"${c.id === cid ? ' class="on"' : ''}>${e(c.name)}</a>`).join('') + '</div>';
  if (!students.length || !tasks.length) {
    h += `<div class="card empty">${!students.length ? 'В классе нет учеников.' : 'Для класса ещё нет заданий.'}</div>`;
    return ctx.html(layout(ctx, 'Журнал', h));
  }
  h += '<div class="journal-wrap"><table class="tbl journal"><thead><tr><th class="sticky">Ученик</th>';
  for (const t of tasks) {
    const short = t.title.length > 22 ? t.title.slice(0, 21) + '…' : t.title;
    h += `<th><a href="/task?id=${t.id}" title="${e(t.title)}">${e(short)}</a><div class="muted small">${fmtDay(t.due_at)}</div></th>`;
  }
  h += '<th>Средний</th></tr></thead><tbody>';
  for (const st of students) {
    h += `<tr><td class="sticky">${e(st.name)}</td>`;
    let sum = 0, n = 0;
    for (const t of tasks) {
      const s = subs[st.id]?.[t.id];
      if (!s) {
        h += `<td class="c">${isPast(t.due_at) ? '<span class="cell miss" title="Не сдано">—</span>' : ''}</td>`;
      } else if (s.status === 'graded') {
        sum += s.score; n++;
        const ratio = s.score / Math.max(1, t.max_score);
        const cl = ratio >= 0.85 ? 'g5' : ratio >= 0.65 ? 'g4' : ratio >= 0.45 ? 'g3' : 'g2';
        h += `<td class="c"><a class="cell ${cl}" href="/sub?id=${s.id}">${s.score}</a></td>`;
      } else if (s.status === 'returned') {
        h += `<td class="c"><a class="cell ret" href="/sub?id=${s.id}" title="На доработке">↺</a></td>`;
      } else {
        h += `<td class="c"><a class="cell pend" href="/sub?id=${s.id}" title="Ждёт проверки">●</a></td>`;
      }
    }
    h += `<td class="c"><b>${avg(sum, n)}</b></td></tr>`;
  }
  h += `</tbody></table></div>
<p class="muted small legend"><span class="cell pend">●</span> ждёт проверки &nbsp; <span class="cell ret">↺</span> на доработке &nbsp; <span class="cell miss">—</span> не сдано в срок</p>`;
  ctx.html(layout(ctx, 'Журнал', h));
}
