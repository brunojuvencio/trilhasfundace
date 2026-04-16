create extension if not exists citext;

create table if not exists public.leads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

alter table public.leads
  add column if not exists nome text,
  add column if not exists email citext,
  add column if not exists cidade text,
  add column if not exists telefone text,
  add column if not exists possui_formacao_superior boolean,
  add column if not exists area_formacao text,
  add column if not exists empresa text,
  add column if not exists cargo text,
  add column if not exists pretende_pos text,
  add column if not exists mba_offer_shown_at timestamptz,
  add column if not exists mba_offer_acknowledged boolean not null default false,
  add column if not exists consultor_contact_opt_in boolean,
  add column if not exists consultor_contact_answered_at timestamptz;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'leads'
      and column_name = 'pretende_pos'
      and data_type = 'boolean'
  ) then
    alter table public.leads
      alter column pretende_pos type text
      using case
        when pretende_pos is true then 'sim_agora'
        else 'nao'
      end;
  end if;
end $$;

alter table public.leads
  alter column nome set not null,
  alter column email set not null,
  alter column telefone set not null,
  alter column possui_formacao_superior set not null,
  alter column area_formacao set not null,
  alter column empresa set not null,
  alter column cargo set not null,
  alter column pretende_pos set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'leads_email_key'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_email_key unique (email);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'leads_pretende_pos_check'
      and conrelid = 'public.leads'::regclass
  ) then
    alter table public.leads
      add constraint leads_pretende_pos_check
      check (pretende_pos in ('sim_agora', 'sim_depois', 'nao'));
  end if;
end $$;

alter table public.leads enable row level security;

revoke all on public.leads from anon, authenticated;

create or replace function public.capture_lead(
  p_nome text,
  p_email text,
  p_cidade text,
  p_telefone text,
  p_possui_formacao_superior boolean,
  p_area_formacao text,
  p_empresa text,
  p_cargo text,
  p_pretende_pos text
)
returns public.leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text := trim(coalesce(p_nome, ''));
  v_email citext := lower(trim(coalesce(p_email, '')));
  v_cidade text := nullif(trim(coalesce(p_cidade, '')), '');
  v_telefone text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_area_formacao text := trim(coalesce(p_area_formacao, ''));
  v_empresa text := trim(coalesce(p_empresa, ''));
  v_cargo text := trim(coalesce(p_cargo, ''));
  v_pretende_pos text := trim(coalesce(p_pretende_pos, ''));
  v_lead public.leads;
begin
  if v_nome = '' then
    raise exception 'Nome é obrigatório.';
  end if;

  if v_email = '' or v_email !~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$' then
    raise exception 'E-mail inválido.';
  end if;

  if length(v_telefone) < 10 or length(v_telefone) > 13 then
    raise exception 'Telefone inválido.';
  end if;

  if p_possui_formacao_superior is null then
    raise exception 'Formação superior é obrigatória.';
  end if;

  if v_area_formacao = '' then
    raise exception 'Área de formação é obrigatória.';
  end if;

  if v_empresa = '' then
    raise exception 'Empresa é obrigatória.';
  end if;

  if v_cargo = '' then
    raise exception 'Cargo é obrigatório.';
  end if;

  if v_pretende_pos not in ('sim_agora', 'sim_depois', 'nao') then
    raise exception 'Valor inválido para pretende_pos.';
  end if;

  insert into public.leads (
    nome,
    email,
    cidade,
    telefone,
    possui_formacao_superior,
    area_formacao,
    empresa,
    cargo,
    pretende_pos
  )
  values (
    v_nome,
    v_email,
    v_cidade,
    v_telefone,
    p_possui_formacao_superior,
    v_area_formacao,
    v_empresa,
    v_cargo,
    v_pretende_pos
  )
  on conflict (email) do update
  set
    nome = excluded.nome,
    cidade = excluded.cidade,
    telefone = excluded.telefone,
    possui_formacao_superior = excluded.possui_formacao_superior,
    area_formacao = excluded.area_formacao,
    empresa = excluded.empresa,
    cargo = excluded.cargo,
    pretende_pos = excluded.pretende_pos
  returning * into v_lead;

  return v_lead;
end;
$$;

revoke all on function public.capture_lead(text, text, text, text, boolean, text, text, text, text) from public;
grant execute on function public.capture_lead(text, text, text, text, boolean, text, text, text, text) to anon, authenticated;

create or replace function public.get_lead_offer_context(
  p_email text
)
returns table (
  email citext,
  nome text,
  possui_formacao_superior boolean,
  pretende_pos text,
  mba_offer_shown_at timestamptz,
  mba_offer_acknowledged boolean,
  consultor_contact_opt_in boolean,
  consultor_contact_answered_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext := lower(trim(coalesce(p_email, '')));
begin
  if v_email = '' then
    raise exception 'E-mail é obrigatório.';
  end if;

  return query
  select
    l.email::citext,
    l.nome,
    l.possui_formacao_superior,
    l.pretende_pos,
    l.mba_offer_shown_at,
    l.mba_offer_acknowledged,
    l.consultor_contact_opt_in,
    l.consultor_contact_answered_at
  from public.leads l
  where l.email = v_email
  limit 1;
end;
$$;

revoke all on function public.get_lead_offer_context(text) from public;
grant execute on function public.get_lead_offer_context(text) to anon, authenticated;

create or replace function public.record_lead_offer_response(
  p_email text,
  p_consultor_contact_opt_in boolean,
  p_mba_offer_acknowledged boolean default true
)
returns public.leads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext := lower(trim(coalesce(p_email, '')));
  v_lead public.leads;
begin
  if v_email = '' then
    raise exception 'E-mail é obrigatório.';
  end if;

  update public.leads
  set
    mba_offer_shown_at = coalesce(mba_offer_shown_at, now()),
    mba_offer_acknowledged = coalesce(p_mba_offer_acknowledged, true),
    consultor_contact_opt_in = p_consultor_contact_opt_in,
    consultor_contact_answered_at = now()
  where email = v_email
  returning * into v_lead;

  if v_lead.id is null then
    raise exception 'Lead não encontrado.';
  end if;

  return v_lead;
end;
$$;

revoke all on function public.record_lead_offer_response(text, boolean, boolean) from public;
grant execute on function public.record_lead_offer_response(text, boolean, boolean) to anon, authenticated;
