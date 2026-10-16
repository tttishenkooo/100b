-- =====================================================================
--  Школьные задания — схема базы данных для Supabase.
--  Откройте Supabase → SQL Editor → New query, вставьте весь файл и нажмите Run.
--  Скрипт можно запускать повторно: он ничего не удалит.
-- =====================================================================

create table if not exists classes (
  id bigserial primary key,
  name text not null unique
);

create table if not exists users (
  id bigserial primary key,
  role text not null check (role in ('teacher', 'student')),
  login text not null,
  name text not null,
  pass text not null,
  class_id bigint references classes(id) on delete set null,
  token_v int not null default 0,          -- меняется при смене пароля → старые входы сбрасываются
  created_at timestamptz not null default now()
);
create unique index if not exists users_login_key on users (lower(login));

create table if not exists assignments (
  id bigserial primary key,
  title text not null,
  body text not null default '',
  class_id bigint references classes(id) on delete set null,   -- null = для всех классов
  due_at timestamptz,
  strict boolean not null default false,  -- не принимать ответы после срока
  max_score int not null default 5,
  created_at timestamptz not null default now()
);

create table if not exists submissions (
  id bigserial primary key,
  assignment_id bigint not null references assignments(id) on delete cascade,
  student_id bigint not null references users(id) on delete cascade,
  text text not null default '',
  status text not null default 'submitted' check (status in ('submitted', 'graded', 'returned')),
  score int,
  feedback text not null default '',
  submitted_at timestamptz not null default now(),
  graded_at timestamptz,
  unique (assignment_id, student_id)
);

-- Файлы лежат в Supabase Storage (бакет "files"), здесь — только описание
create table if not exists files (
  id bigserial primary key,
  owner text check (owner in ('assignment', 'submission')),   -- null = загружен, но ещё не прикреплён
  owner_id bigint,
  uploader_id bigint references users(id) on delete cascade,
  name text not null,
  path text not null,
  size int not null,
  created_at timestamptz not null default now()
);
create index if not exists files_owner_idx on files (owner, owner_id);

create table if not exists login_fails (
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists login_fails_ip_idx on login_fails (ip, at);

-- Логины/пароли новых учеников показываются учителю один раз, потом удаляются
create table if not exists creds_once (
  token text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

-- Закрываем таблицы от публичного API: читать/писать может только сервер сайта
alter table classes      enable row level security;
alter table users        enable row level security;
alter table assignments  enable row level security;
alter table submissions  enable row level security;
alter table files        enable row level security;
alter table login_fails  enable row level security;
alter table creds_once   enable row level security;

-- Сервер сайта выполняет свои SQL-запросы через эту функцию.
-- Вызвать её может только секретный ключ (service_role), не публичный.
create or replace function app_sql(q text, p jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  result jsonb := '[]'::jsonb;
begin
  for r in execute q using p loop
    result := result || jsonb_build_array(to_jsonb(r));
  end loop;
  return result;
end
$$;

revoke all on function app_sql(text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function app_sql(text, jsonb) from anon, authenticated';
    execute 'grant execute on function app_sql(text, jsonb) to service_role';
  end if;
end $$;

-- Приватный бакет для файлов (только в Supabase)
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('files', 'files', false)
    on conflict (id) do nothing;
  end if;
end $$;
