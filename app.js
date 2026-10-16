import { sql, one, query } from './supabase.js';
import { Ctx, HttpError, sign, unsign, hashPassword, checkPassword } from './http.js';
import { layout, e } from './view.js';
import { uploadHandler, fileHandler } from './files.js';
import * as T from './teacher.js';
import * as S from './student.js';

const SESSION_DAYS = 30; // чтобы детям не входить каждый раз

export async function handle(req, res) {
  const ctx = new Ctx(req, res);
  try {
    await route(ctx);
  } catch (err) {
    if (res.headersSent) {
      console.error(err);
      try { res.end(); } catch {}
      return;
    }
    if (err.config) return ctx.html(configPage(), 500);
    if (err.status === 404) return notFound(ctx);
    if (err.status === 403) return ctx.html(layout(ctx, 'Ошибка', '<div class="card narrow"><h1>Запрос отклонён</h1><p>Обновите страницу и попробуйте ещё раз.</p></div>'), 403);
    if (err.status === 413) return ctx.html(layout(ctx, 'Ошибка', '<div class="card narrow"><h1>Слишком большой запрос</h1></div>'), 413);
    if (err.status === 405) return ctx.html('Method not allowed', 405);
    console.error(err);
    ctx.html(layout(ctx, 'Ошибка', '<div class="card narrow"><h1>Что-то пошло не так</h1><p>Попробуйте обновить страницу через минуту.</p><p><a href="/">На главную</a></p></div>'), 500);
  }
}

export function notFound(ctx) {
  ctx.html(layout(ctx, 'Не найдено', '<div class="card narrow"><h1>Не найдено</h1><p>Такой страницы нет или у вас нет к ней доступа.</p><p><a href="/">На главную</a></p></div>'), 404);
}

function configPage() {
  return `<!doctype html><meta charset="utf-8"><title>Настройка</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>Сайт ещё не настроен</h1>
<p>В Vercel → Settings → Environment Variables нужно добавить переменные
<code>SUPABASE_URL</code>, <code>SUPABASE_SECRET_KEY</code> и <code>SESSION_SECRET</code> (не короче 16 символов),
а потом сделать Redeploy. Подробности — в README.md.</p></body>`;
}

async function route(ctx) {
  if (ctx.path === '/favicon.ico') {
    ctx.writeHead(204);
    return ctx.res.end();
  }
  if (ctx.method === 'POST') ctx.checkOrigin();

  // Один запрос к базе: кто вошёл и есть ли вообще учитель
  const sess = unsign(ctx.cookies.sid);
  const sessOk = sess && sess.exp > Date.now();
  const st = await one(sql`select
      (select to_jsonb(u) - 'pass' from users u where u.id = ${sessOk ? sess.u : null}::bigint and u.token_v = ${sessOk ? sess.v : null}::int) as me,
      exists (select 1 from users where role = 'teacher') as has_teacher`);
  ctx.user = st.me || null;
  ctx.flashIn = ctx.takeFlash();

  if (!st.has_teacher) return setupPage(ctx);

  if (ctx.path === '/logout') {
    if (ctx.method === 'POST') ctx.setCookie('sid', '', { maxAge: 0 });
    return ctx.redirect('/');
  }
  if (ctx.path === '/login') {
    if (ctx.method === 'POST') return loginPage(ctx);
    return ctx.redirect('/');
  }
  if (!ctx.user) {
    if (ctx.path === '/upload') return ctx.json({ error: 'войдите заново' }, 401);
    if (ctx.path !== '/') return ctx.redirect('/');
    return loginPage(ctx);
  }

  if (ctx.path === '/password') return passwordPage(ctx);
  if (ctx.path === '/upload') return uploadHandler(ctx);
  if (ctx.path === '/file') return fileHandler(ctx);

  const routes = ctx.user.role === 'teacher'
    ? { '/': T.home, '/edit': T.edit, '/task': T.task, '/sub': T.sub, '/students': T.students, '/journal': T.journal }
    : { '/': S.home, '/task': S.task };
  const fn = routes[ctx.path];
  if (!fn) throw new HttpError(404);
  return fn(ctx);
}

export function startSession(ctx, user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  ctx.setCookie('sid', sign({ u: user.id, v: user.token_v, exp }), { maxAge: SESSION_DAYS * 86400 });
}

// ================= общие страницы =================

async function setupPage(ctx) {
  let err = '';
  let f = null;
  if (ctx.method === 'POST') {
    f = await ctx.form();
    const name = f.str('name');
    const login = f.str('login');
    const pass = f.get('pass');
    const key = process.env.SETUP_KEY || '';
    if (key && f.get('key') !== key) {
      err = 'Неверный ключ установки.';
    } else if (!name || !login) {
      err = 'Заполните имя и логин.';
    } else if (!/^[a-zA-Z0-9._-]{3,30}$/.test(login)) {
      err = 'Логин: 3–30 латинских букв, цифр, точек или дефисов.';
    } else if (pass.length < 8) {
      err = 'Пароль должен быть не короче 8 символов.';
    } else {
      // вставляем, только если учителя всё ещё нет (защита от двойной отправки)
      const u = await one(sql`insert into users (role, login, name, pass)
        select 'teacher', ${login}, ${name}, ${hashPassword(pass)}
        where not exists (select 1 from users where role = 'teacher')
        returning id, token_v`);
      if (u) {
        startSession(ctx, u);
        ctx.flash('Готово! Теперь создайте класс и добавьте учеников.');
        return ctx.redirect('/students');
      }
      return ctx.redirect('/');
    }
  }
  const v = (k) => e(f ? f.get(k) : '');
  const needKey = !!process.env.SETUP_KEY;
  ctx.html(layout(ctx, 'Первый запуск', `<div class="card narrow"><h1>Добро пожаловать!</h1>
<p class="muted">Создайте учётную запись учителя. Это нужно сделать один раз.</p>
${err ? `<div class="flash err">${e(err)}</div>` : ''}
<form method="post" class="form">
${needKey ? `<label>Ключ установки (SETUP_KEY из Vercel)<input type="password" name="key" required></label>` : ''}
<label>Ваше имя (так его увидят ученики)<input name="name" required value="${v('name')}" placeholder="Анна Сергеевна"></label>
<label>Логин<input name="login" required autocapitalize="off" value="${v('login')}" placeholder="teacher"></label>
<label>Пароль (минимум 8 символов)<input type="password" name="pass" required minlength="8"></label>
<button class="btn">Создать</button></form></div>`));
}

async function loginPage(ctx) {
  let err = '';
  let login = '';
  if (ctx.method === 'POST') {
    const f = await ctx.form();
    login = f.str('login');
    const ip = ctx.ip();
    const r = await one(sql`with d as (delete from login_fails where at < now() - interval '15 minutes' returning 1)
      select (select count(*)::int from login_fails where ip = ${ip} and at >= now() - interval '15 minutes') as fails,
             (select jsonb_build_object('id', id, 'pass', pass, 'token_v', token_v) from users where lower(login) = lower(${login})) as u`);
    if (r.fails >= 15) {
      err = 'Слишком много попыток. Подождите 15 минут.';
    } else if (r.u && checkPassword(f.get('pass'), r.u.pass)) {
      startSession(ctx, r.u);
      return ctx.redirect('/');
    } else {
      await query(sql`insert into login_fails (ip) values (${ip}) returning 1`);
      await new Promise((ok) => setTimeout(ok, 400));
      err = 'Неверный логин или пароль.';
    }
  }
  ctx.html(layout(ctx, 'Вход', `<div class="card narrow"><h1>Вход</h1>
${err ? `<div class="flash err">${e(err)}</div>` : ''}
<form method="post" action="/login" class="form">
<label>Логин<input name="login" required autofocus autocapitalize="off" autocorrect="off" autocomplete="username" value="${e(login)}"></label>
<label>Пароль<input type="password" name="pass" required autocomplete="current-password"></label>
<button class="btn">Войти</button></form>
<p class="muted small">Забыли пароль? Попросите учителя выдать новый.</p></div>`));
}

async function passwordPage(ctx) {
  const u = ctx.user;
  let err = '';
  if (ctx.method === 'POST') {
    const f = await ctx.form();
    const row = await one(sql`select pass from users where id = ${u.id}::bigint`);
    const min = u.role === 'teacher' ? 8 : 4;
    const nw = f.get('new');
    if (!checkPassword(f.get('old'), row.pass)) {
      err = 'Текущий пароль введён неверно.';
    } else if (nw.length < min) {
      err = `Новый пароль должен быть не короче ${min} символов.`;
    } else if (nw !== f.get('new2')) {
      err = 'Пароли не совпадают.';
    } else {
      const upd = await one(sql`update users set pass = ${hashPassword(nw)}, token_v = token_v + 1
        where id = ${u.id}::bigint returning id, token_v`);
      startSession(ctx, upd);
      ctx.flash('Пароль изменён.');
      return ctx.redirect('/');
    }
  }
  ctx.html(layout(ctx, 'Смена пароля', `<div class="card narrow"><h1>Смена пароля</h1>
<p class="muted">Логин: <b>${e(u.login)}</b></p>
${err ? `<div class="flash err">${e(err)}</div>` : ''}
<form method="post" class="form">
<label>Текущий пароль<input type="password" name="old" required autocomplete="current-password"></label>
<label>Новый пароль<input type="password" name="new" required autocomplete="new-password"></label>
<label>Новый пароль ещё раз<input type="password" name="new2" required autocomplete="new-password"></label>
<button class="btn">Сохранить</button></form></div>`));
}
