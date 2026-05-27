create extension if not exists pgcrypto;

create table if not exists public.cursos (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  descricao text,
  criado_em timestamptz not null default now()
);

insert into public.cursos (nome, descricao)
values
  ('Contabilidade em IFRS', 'Curso de Contabilidade em IFRS.'),
  ('Gestão de Produção com IA', 'Curso de Gestão de Produção com IA.')
on conflict (nome) do nothing;

create table if not exists public.trilhas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text not null default '',
  curso_id uuid not null references public.cursos (id) on delete restrict,
  status text not null default 'rascunho',
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

alter table public.trilhas
  add column if not exists nome text,
  add column if not exists descricao text not null default '',
  add column if not exists curso_id uuid references public.cursos (id) on delete restrict,
  add column if not exists status text not null default 'rascunho',
  add column if not exists criada_em timestamptz not null default now(),
  add column if not exists atualizada_em timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'trilhas_status_check'
      and conrelid = 'public.trilhas'::regclass
  ) then
    alter table public.trilhas
      add constraint trilhas_status_check
      check (status in ('rascunho', 'publicada'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'trilhas_descricao_length_check'
      and conrelid = 'public.trilhas'::regclass
  ) then
    alter table public.trilhas
      add constraint trilhas_descricao_length_check
      check (char_length(descricao) <= 200);
  end if;
end $$;

create table if not exists public.aulas (
  id uuid primary key default gen_random_uuid(),
  trilha_id uuid not null references public.trilhas (id) on delete cascade,
  titulo text not null,
  vimeo_id text not null,
  duracao text,
  ordem integer not null default 1,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

alter table public.aulas
  add column if not exists trilha_id uuid references public.trilhas (id) on delete cascade,
  add column if not exists titulo text,
  add column if not exists vimeo_id text,
  add column if not exists duracao text,
  add column if not exists ordem integer not null default 1,
  add column if not exists criada_em timestamptz not null default now(),
  add column if not exists atualizada_em timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aulas_vimeo_id_numeric_check'
      and conrelid = 'public.aulas'::regclass
  ) then
    alter table public.aulas
      add constraint aulas_vimeo_id_numeric_check
      check (vimeo_id ~ '^[0-9]+$');
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'aulas_ordem_positive_check'
      and conrelid = 'public.aulas'::regclass
  ) then
    alter table public.aulas
      add constraint aulas_ordem_positive_check
      check (ordem > 0);
  end if;
end $$;

create index if not exists trilhas_curso_status_idx
  on public.trilhas (curso_id, status, criada_em desc);

create index if not exists aulas_trilha_ordem_idx
  on public.aulas (trilha_id, ordem asc, criada_em asc);

create or replace function public.set_atualizada_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizada_em = now();
  return new;
end;
$$;

drop trigger if exists set_trilhas_atualizada_em on public.trilhas;
create trigger set_trilhas_atualizada_em
before update on public.trilhas
for each row execute function public.set_atualizada_em();

drop trigger if exists set_aulas_atualizada_em on public.aulas;
create trigger set_aulas_atualizada_em
before update on public.aulas
for each row execute function public.set_atualizada_em();

alter table public.cursos enable row level security;
alter table public.trilhas enable row level security;
alter table public.aulas enable row level security;

drop policy if exists "Authenticated users can read courses" on public.cursos;
create policy "Authenticated users can read courses"
on public.cursos
for select
to authenticated
using (true);

drop policy if exists "Admins can manage courses" on public.cursos;
create policy "Admins can manage courses"
on public.cursos
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Authenticated users can read published trilhas" on public.trilhas;
create policy "Authenticated users can read published trilhas"
on public.trilhas
for select
to authenticated
using (status = 'publicada' or public.is_admin());

drop policy if exists "Admins can manage trilhas" on public.trilhas;
create policy "Admins can manage trilhas"
on public.trilhas
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Authenticated users can read published aulas" on public.aulas;
create policy "Authenticated users can read published aulas"
on public.aulas
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.trilhas t
    where t.id = aulas.trilha_id
      and t.status = 'publicada'
  )
);

drop policy if exists "Admins can manage aulas" on public.aulas;
create policy "Admins can manage aulas"
on public.aulas
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select on public.cursos, public.trilhas, public.aulas to authenticated;
grant insert, update, delete on public.cursos, public.trilhas, public.aulas to authenticated;
