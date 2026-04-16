create extension if not exists citext;

create table if not exists public.admin_users (
  email citext primary key,
  nome text,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.admin_users
  add column if not exists nome text,
  add column if not exists created_by text;

alter table public.admin_users enable row level security;

drop policy if exists "Admins can read admin users" on public.admin_users;
create policy "Admins can read admin users"
on public.admin_users
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can update admin users" on public.admin_users;
create policy "Admins can update admin users"
on public.admin_users
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can insert admin users" on public.admin_users;
create policy "Admins can insert admin users"
on public.admin_users
for insert
to authenticated
with check (public.is_admin());

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where active is true
      and lower(email::text) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create table if not exists public.comments (
  id bigint generated always as identity primary key,
  lesson_id text not null,
  user_id uuid references auth.users (id) on delete set null,
  name text not null,
  text text not null,
  status text not null default 'pending',
  approved boolean not null default false,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz not null default now()
);

alter table public.comments
  add column if not exists user_id uuid references auth.users (id) on delete set null,
  add column if not exists status text,
  add column if not exists approved boolean,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text;

update public.comments
set
  status = case when coalesce(approved, false) then 'approved' else 'pending' end,
  approved = coalesce(approved, false)
where status is null
   or approved is null;

alter table public.comments
  alter column name set not null,
  alter column text set not null,
  alter column lesson_id set not null,
  alter column status set default 'pending',
  alter column status set not null,
  alter column approved set default false,
  alter column approved set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'comments_status_check'
      and conrelid = 'public.comments'::regclass
  ) then
    alter table public.comments
      add constraint comments_status_check
      check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

create index if not exists comments_lesson_created_idx
  on public.comments (lesson_id, created_at desc);

create index if not exists comments_status_created_idx
  on public.comments (status, created_at desc);

alter table public.comments enable row level security;

drop policy if exists "Authenticated users can read approved comments" on public.comments;
create policy "Authenticated users can read approved comments"
on public.comments
for select
to authenticated
using (approved is true or public.is_admin());

drop policy if exists "Authenticated users can insert pending comments" on public.comments;
create policy "Authenticated users can insert pending comments"
on public.comments
for insert
to authenticated
with check (
  auth.uid() = user_id
  and approved is false
  and status = 'pending'
);

drop policy if exists "Admins can update comments" on public.comments;
create policy "Admins can update comments"
on public.comments
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can delete comments" on public.comments;
create policy "Admins can delete comments"
on public.comments
for delete
to authenticated
using (public.is_admin());

create table if not exists public.lesson_views (
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_id text not null,
  view_count integer not null default 1,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

alter table public.lesson_views enable row level security;

drop policy if exists "Users can read own lesson views" on public.lesson_views;
create policy "Users can read own lesson views"
on public.lesson_views
for select
to authenticated
using (auth.uid() = user_id or public.is_admin());

drop policy if exists "Admins can update lesson views" on public.lesson_views;
create policy "Admins can update lesson views"
on public.lesson_views
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create index if not exists lesson_views_lesson_last_view_idx
  on public.lesson_views (lesson_id, last_viewed_at desc);

create or replace function public.track_lesson_view(p_lesson_id text)
returns public.lesson_views
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lesson_id text := trim(coalesce(p_lesson_id, ''));
  v_row public.lesson_views;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado.';
  end if;

  if v_lesson_id = '' then
    raise exception 'lesson_id é obrigatório.';
  end if;

  insert into public.lesson_views (
    user_id,
    lesson_id,
    view_count,
    first_viewed_at,
    last_viewed_at
  )
  values (
    auth.uid(),
    v_lesson_id,
    1,
    now(),
    now()
  )
  on conflict (user_id, lesson_id) do update
  set
    view_count = public.lesson_views.view_count + 1,
    last_viewed_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.track_lesson_view(text) from public;
grant execute on function public.track_lesson_view(text) to authenticated;

create or replace function public.moderate_comment(
  p_comment_id bigint,
  p_status text
)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := lower(trim(coalesce(p_status, '')));
  v_comment public.comments;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if v_status not in ('approved', 'rejected', 'pending') then
    raise exception 'Status inválido.';
  end if;

  update public.comments
  set
    status = v_status,
    approved = (v_status = 'approved'),
    reviewed_at = now(),
    reviewed_by = coalesce(auth.jwt() ->> 'email', reviewed_by)
  where id = p_comment_id
  returning * into v_comment;

  if v_comment.id is null then
    raise exception 'Comentário não encontrado.';
  end if;

  return v_comment;
end;
$$;

revoke all on function public.moderate_comment(bigint, text) from public;
grant execute on function public.moderate_comment(bigint, text) to authenticated;

create or replace function public.get_lesson_analytics()
returns table (
  lesson_id text,
  unique_viewers bigint,
  total_views bigint,
  last_viewed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  return query
  select
    lv.lesson_id,
    count(*)::bigint as unique_viewers,
    coalesce(sum(lv.view_count), 0)::bigint as total_views,
    max(lv.last_viewed_at) as last_viewed_at
  from public.lesson_views lv
  group by lv.lesson_id
  order by total_views desc, unique_viewers desc, lv.lesson_id asc;
end;
$$;

revoke all on function public.get_lesson_analytics() from public;
grant execute on function public.get_lesson_analytics() to authenticated;

create or replace function public.list_admin_users()
returns table (
  email citext,
  nome text,
  active boolean,
  created_by text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  return query
  select
    au.email,
    au.nome,
    au.active,
    au.created_by,
    au.created_at
  from public.admin_users au
  order by au.active desc, au.created_at desc, au.email asc;
end;
$$;

revoke all on function public.list_admin_users() from public;
grant execute on function public.list_admin_users() to authenticated;

drop policy if exists "Admins can read leads" on public.leads;
create policy "Admins can read leads"
on public.leads
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can update leads" on public.leads;
create policy "Admins can update leads"
on public.leads
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins can read all lesson progress" on public.user_lesson_progress;
create policy "Admins can read all lesson progress"
on public.user_lesson_progress
for select
to authenticated
using (public.is_admin());

-- Depois de rodar esta migration, adicione seu e-mail como admin:
-- insert into public.admin_users (email) values ('seu-email@dominio.com')
-- on conflict (email) do update set active = true;
