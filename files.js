import crypto from 'node:crypto';
import { sql, query, one, storagePut, storageGet, storageRemove } from './supabase.js';
import { HttpError } from './http.js';
import { ALLOWED_EXT, MAX_FILE_MB, MAX_FILES, MIME, TEXT_EXT, fileExt } from './view.js';

export async function filesOf(owner, id) {
  return query(sql`select id, name, size from files where owner = ${owner} and owner_id = ${id}::bigint order by id`);
}

/** POST /upload?name=… — тело запроса = содержимое файла. Возвращает {id}. */
export async function uploadHandler(ctx) {
  if (ctx.method !== 'POST') throw new HttpError(405);
  ctx.checkOrigin();
  let name = ctx.q('name').replace(/\\/g, '/').split('/').pop().slice(0, 150).trim() || 'file';
  if (!ALLOWED_EXT.includes(fileExt(name))) return ctx.json({ error: 'такой тип файла не поддерживается' }, 400);
  let buf;
  try {
    buf = await ctx.rawBody(MAX_FILE_MB * 1048576);
  } catch (e) {
    if (e.status === 413) return ctx.json({ error: `больше ${MAX_FILE_MB} МБ` }, 413);
    throw e;
  }
  if (!buf.length) return ctx.json({ error: 'пустой файл' }, 400);

  const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(16).toString('hex')}.${fileExt(name)}`;
  await storagePut(path, buf, MIME[fileExt(name)] || 'application/octet-stream');
  const row = await one(sql`insert into files (uploader_id, name, path, size)
    values (${ctx.user.id}::bigint, ${name}, ${path}, ${buf.length}::int) returning id`);

  // Подчищаем файлы, которые загрузили, но так и не прикрепили (старше суток)
  if (Math.random() < 0.2) {
    const old = await query(sql`delete from files where owner is null and created_at < now() - interval '1 day' returning path`);
    await storageRemove(old.map((r) => r.path));
  }
  return ctx.json({ id: row.id });
}

/** Прикрепляет загруженные этим пользователем файлы к заданию/ответу. Возвращает текст ошибки или ''. */
export async function attachFiles(ctx, form, owner, ownerId) {
  const ids = form.all('file_ids').map((x) => parseInt(x, 10)).filter((x) => x > 0);
  if (!ids.length) return '';
  const cnt = await one(sql`select count(*)::int n from files where owner = ${owner} and owner_id = ${ownerId}::bigint`);
  const room = Math.max(0, MAX_FILES - cnt.n);
  const take = ids.slice(0, room);
  if (take.length) {
    await query(sql`update files set owner = ${owner}, owner_id = ${ownerId}::bigint
      where id = any(${take}::bigint[]) and uploader_id = ${ctx.user.id}::bigint and owner is null returning id`);
  }
  return ids.length > room ? `Можно прикрепить не больше ${MAX_FILES} файлов — лишние не сохранены.` : '';
}

/** Удаляет отмеченные файлы, но только принадлежащие этому заданию/ответу */
export async function deleteSelectedFiles(form, owner, ownerId) {
  const ids = form.all('del_files').map((x) => parseInt(x, 10)).filter((x) => x > 0);
  if (!ids.length) return;
  const rows = await query(sql`delete from files where id = any(${ids}::bigint[])
    and owner = ${owner} and owner_id = ${ownerId}::bigint returning path`);
  await storageRemove(rows.map((r) => r.path));
}

export async function deleteSubmission(sid) {
  const rows = await query(sql`with f as (delete from files where owner = 'submission' and owner_id = ${sid}::bigint returning path),
    s as (delete from submissions where id = ${sid}::bigint returning id)
    select path from f`);
  await storageRemove(rows.map((r) => r.path));
}

export async function deleteAssignment(id) {
  const rows = await query(sql`with f as (delete from files where (owner = 'assignment' and owner_id = ${id}::bigint)
      or (owner = 'submission' and owner_id in (select id from submissions where assignment_id = ${id}::bigint)) returning path),
    a as (delete from assignments where id = ${id}::bigint returning id)
    select path from f`);
  await storageRemove(rows.map((r) => r.path));
}

export async function deleteStudent(id) {
  const rows = await query(sql`with f as (delete from files where uploader_id = ${id}::bigint
      or (owner = 'submission' and owner_id in (select id from submissions where student_id = ${id}::bigint)) returning path),
    u as (delete from users where id = ${id}::bigint and role = 'student' returning id)
    select path from f`);
  await storageRemove(rows.map((r) => r.path));
}

/** GET /file?id= — отдаёт файл, проверив доступ */
export async function fileHandler(ctx) {
  const u = ctx.user;
  const id = parseInt(ctx.q('id'), 10) || 0;
  const f = await one(sql`select f.* from files f where f.id = ${id}::bigint and (
      ${u.role} = 'teacher'
      or f.uploader_id = ${u.id}::bigint
      or (f.owner = 'submission' and exists (select 1 from submissions s where s.id = f.owner_id and s.student_id = ${u.id}::bigint))
      or (f.owner = 'assignment' and exists (select 1 from assignments a where a.id = f.owner_id
            and (a.class_id is null or a.class_id = ${u.class_id}::bigint)))
    )`);
  if (!f) throw new HttpError(404);
  const buf = await storageGet(f.path);
  if (!buf) throw new HttpError(404);
  const ext = fileExt(f.name);
  const isText = TEXT_EXT.includes(ext);
  const type = MIME[ext] || (isText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  const headers = {
    'Content-Type': type,
    'Content-Length': String(buf.length),
    'Content-Disposition': `${MIME[ext] || isText ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'private, max-age=86400',
  };
  if (!MIME[ext]) headers['Content-Security-Policy'] = 'sandbox';
  ctx.writeHead(200, headers);
  ctx.res.end(buf);
}
