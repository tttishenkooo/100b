import { sql, query, one } from './supabase.js';
import { HttpError } from './http.js';
import { layout, e, rich, fmtDate, plural, statusBadge, filesHtml, fileInput, isPast } from './view.js';
import { filesOf, attachFiles, deleteSelectedFiles, deleteSubmission } from './files.js';

export async function home(ctx) {
  const u = ctx.user;
  const rows = await query(sql`select a.id, a.title, a.due_at, s.id as sid, s.status, s.score, s.submitted_at
    from assignments a
    left join submissions s on s.assignment_id = a.id and s.student_id = ${u.id}::bigint
    where a.class_id is null or a.class_id = ${u.class_id}::bigint
    order by a.id desc`);
  const todo = [], wait = [], done = [];
  for (const r of rows) {
    if (!r.sid || r.status === 'returned') todo.push(r);
    else if (r.status === 'submitted') wait.push(r);
    else done.push(r);
  }
  // ближайший срок — выше
  todo.sort((x, y) => (x.due_at || '9999').localeCompare(y.due_at || '9999'));

  const first = String(u.name).trim().split(/\s+/);
  let h = `<div class="pagehead"><h1>Привет, ${e(first[1] || first[0])}!</h1></div>`;
  if (!rows.length) h += '<div class="card empty">Заданий пока нет. Загляни позже 🙂</div>';
  const section = (title, items) => {
    if (!items.length) return '';
    return `<h2>${title} <span class="muted">${items.length}</span></h2><div class="list">` + items.map((a) =>
      `<a class="item" href="/task?id=${a.id}"><div class="item-main"><div class="item-title">${e(a.title)}</div>
<div class="muted small">${a.due_at ? 'Сдать до ' + fmtDate(a.due_at) : 'Без срока'}</div></div>
<div class="item-side">${statusBadge(a.sid ? a : null, a.due_at)}</div></a>`).join('') + '</div>';
  };
  h += section('Нужно сделать', todo) + section('На проверке', wait) + section('Проверено', done);
  ctx.html(layout(ctx, 'Мои задания', h));
}

export async function task(ctx) {
  const u = ctx.user;
  const id = parseInt(ctx.q('id'), 10) || 0;
  const a = await one(sql`select * from assignments where id = ${id}::bigint
    and (class_id is null or class_id = ${u.class_id}::bigint)`);
  if (!a) throw new HttpError(404);
  let s = await one(sql`select * from submissions where assignment_id = ${id}::bigint and student_id = ${u.id}::bigint`);
  const closed = a.strict && isPast(a.due_at);
  const canEdit = (!s || s.status !== 'graded') && !closed;
  let editing = canEdit && (!s || s.status === 'returned' || ctx.query.has('edit'));
  let err = '';
  let postedText = null;

  if (ctx.method === 'POST') {
    const f = await ctx.form();
    if (!canEdit) {
      ctx.flash(closed ? 'Срок сдачи прошёл.' : 'Работа уже проверена.', 'err');
      return ctx.redirect('/task?id=' + id);
    }
    const text = f.str('text');
    const saved = await one(sql`insert into submissions (assignment_id, student_id, text, status, submitted_at)
      values (${id}::bigint, ${u.id}::bigint, ${text}, 'submitted', now())
      on conflict (assignment_id, student_id) do update
        set text = excluded.text, status = 'submitted', submitted_at = now()
        where submissions.status <> 'graded'
      returning id`);
    if (!saved) {
      ctx.flash('Работа уже проверена.', 'err');
      return ctx.redirect('/task?id=' + id);
    }
    await deleteSelectedFiles(f, 'submission', saved.id);
    const ferr = await attachFiles(ctx, f, 'submission', saved.id);
    const cnt = await one(sql`select count(*)::int n from files where owner = 'submission' and owner_id = ${saved.id}::bigint`);
    if (text === '' && !cnt.n) {
      // пустой ответ не засчитываем
      await deleteSubmission(saved.id);
      err = 'Напиши ответ или прикрепи файл.';
      s = null;
      editing = true;
      postedText = text;
    } else {
      if (ferr) ctx.flash(ferr, 'err');
      ctx.flash('Ответ отправлен учителю! ✔');
      return ctx.redirect('/task?id=' + id);
    }
  }

  const [af, sf] = await Promise.all([filesOf('assignment', id), s ? filesOf('submission', s.id) : []]);
  let h = `<p class="crumbs"><a href="/">← Мои задания</a></p>
<div class="pagehead"><h1>${e(a.title)}</h1>${statusBadge(s, a.due_at)}</div>
<div class="meta">${a.due_at ? 'Сдать до <b>' + fmtDate(a.due_at) + '</b>' : 'Без срока'} · максимум ${a.max_score} ${plural(a.max_score, 'балл', 'балла', 'баллов')}</div>`;
  if (a.body || af.length) h += `<div class="card task-body">${rich(a.body)}${filesHtml(af, true)}</div>`;

  // отзыв учителя
  if (s && (s.status === 'graded' || s.status === 'returned')) {
    h += `<div class="card feedback ${s.status === 'graded' ? 'good' : 'warn'}">`;
    h += s.status === 'graded'
      ? `<div class="big-score">${s.score}<span>/${a.max_score}</span></div>`
      : '<div class="fb-title">Учитель вернул работу на доработку</div>';
    if (s.feedback) h += `<div class="fb-text">${rich(s.feedback)}</div>`;
    h += '</div>';
  }
  if (err) h += `<div class="flash err">${e(err)}</div>`;

  if (editing) {
    const text = postedText ?? (s ? s.text : '');
    h += `<form method="post" class="card form" data-upload>
<h3>${s ? 'Исправить ответ' : 'Мой ответ'}</h3>
<label>Текст ответа<textarea name="text" rows="8" placeholder="Напиши ответ здесь…">${e(text)}</textarea></label>
<div class="field"><div class="label">Файлы (можно сфотографировать тетрадь)</div>
${s ? filesHtml(sf, true, 'del_files') : ''}${fileInput()}</div>
<div class="actions"><button class="btn">Отправить учителю</button>
${s && s.status === 'submitted' ? `<a class="btn ghost" href="/task?id=${id}">Отмена</a>` : ''}</div></form>`;
  } else if (s) {
    h += `<h2>Мой ответ <span class="muted small">${fmtDate(s.submitted_at)}</span></h2>
<div class="card answer">${s.text ? `<div class="answer-text">${rich(s.text)}</div>` : ''}${filesHtml(sf, true)}</div>`;
    if (canEdit) h += `<p><a class="btn ghost" href="/task?id=${id}&edit=1">Изменить ответ</a> <span class="muted small">пока учитель не проверил</span></p>`;
  }
  if (closed && !s) h += '<div class="card empty">Срок сдачи прошёл — ответы больше не принимаются.</div>';
  ctx.html(layout(ctx, a.title, h));
}
