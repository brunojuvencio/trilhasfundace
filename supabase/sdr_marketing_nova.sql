-- Painel do SDR para a trilha NOVA de Marketing (piloto).
-- Gatilhos hoje em escopo: intenção imediata (formulário) e conclusão da trilha
-- (certificado liberado). Estruturado para aceitar novos trigger_type no futuro
-- (ex.: 'email_clique_sequencia', 'email_quiz') sem mudar o schema.

create extension if not exists citext;

create table if not exists public.sdr_contact_triggers (
  id bigint generated always as identity primary key,
  trail_slug text not null,
  trigger_type text not null,
  lead_email citext not null,
  contacted_at timestamptz,
  contacted_by text,
  created_at timestamptz not null default now()
);

alter table public.sdr_contact_triggers
  add column if not exists trail_slug text,
  add column if not exists trigger_type text,
  add column if not exists lead_email citext,
  add column if not exists contacted_at timestamptz,
  add column if not exists contacted_by text,
  add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sdr_contact_triggers_unique'
      and conrelid = 'public.sdr_contact_triggers'::regclass
  ) then
    alter table public.sdr_contact_triggers
      add constraint sdr_contact_triggers_unique unique (trail_slug, trigger_type, lead_email);
  end if;
end $$;

alter table public.sdr_contact_triggers enable row level security;

drop policy if exists "Admins can read sdr contact triggers" on public.sdr_contact_triggers;
create policy "Admins can read sdr contact triggers"
on public.sdr_contact_triggers
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can write sdr contact triggers" on public.sdr_contact_triggers;
create policy "Admins can write sdr contact triggers"
on public.sdr_contact_triggers
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create index if not exists sdr_contact_triggers_lookup_idx
  on public.sdr_contact_triggers (trail_slug, trigger_type, lead_email);

-- Retorna a fila de gatilhos ativos da trilha nova de Marketing (situações A e B),
-- já com prazo calculado e o status de contato (se houver).
create or replace function public.get_marketing_nova_sdr_queue()
returns table (
  situacao text,
  trigger_type text,
  trigger_label text,
  lead_nome text,
  lead_email citext,
  lead_telefone text,
  gatilho_em timestamptz,
  prazo_em timestamptz,
  contatado_em timestamptz,
  contatado_por text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trail_slug constant text := 'trilha-nova-de-marketing';
  v_trail_nome constant text := 'Mini Curso Estratégias de Marketing para o Mercado em Transformação';
  v_trilha_id uuid;
  v_total_aulas integer;
  -- So traz gatilhos a partir de ontem (00:00 em SP), pra fila nao comecar
  -- lotada de coisa antiga ja vencida por natureza.
  v_cutoff timestamptz := (date_trunc('day', (now() at time zone 'America/Sao_Paulo') - interval '1 day')) at time zone 'America/Sao_Paulo';
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  select id into v_trilha_id from public.trilhas where slug = v_trail_slug limit 1;

  if v_trilha_id is null then
    return;
  end if;

  select count(*) into v_total_aulas from public.aulas where trilha_id = v_trilha_id;

  if v_total_aulas = 0 then
    return;
  end if;

  return query
  -- Situação A: marcou "quero começar imediatamente" no formulário da trilha.
  select
    'A'::text,
    'intencao_imediata'::text,
    'Marcou "quero começar imediatamente" no formulário'::text,
    l.nome,
    l.email::citext,
    l.telefone,
    l.created_at,
    (
      (date_trunc('day', l.created_at at time zone 'America/Sao_Paulo') + interval '1 day' - interval '1 second')
      at time zone 'America/Sao_Paulo'
    ),
    t.contacted_at,
    t.contacted_by
  from public.leads l
  left join public.sdr_contact_triggers t
    on t.trail_slug = v_trail_slug
    and t.trigger_type = 'intencao_imediata'
    and t.lead_email = l.email
  where l.nome_trilha = v_trail_nome
    and l.pretende_pos = 'sim_agora'
    and l.created_at >= v_cutoff

  union all

  -- Situação B: concluiu todas as aulas da trilha (certificado liberado no portal).
  select
    'B'::text,
    'trilha_concluida'::text,
    'Concluiu a trilha (certificado liberado)'::text,
    coalesce(l.nome, u.raw_user_meta_data ->> 'name'),
    coalesce(l.email::text, u.email)::citext,
    l.telefone,
    p.gatilho_em,
    p.gatilho_em + interval '24 hours',
    t.contacted_at,
    t.contacted_by
  from (
    select ulp.user_id, max(ulp.completed_at) as gatilho_em
    from public.user_lesson_progress ulp
    inner join public.aulas a on a.id::text = ulp.lesson_id
    where a.trilha_id = v_trilha_id
    group by ulp.user_id
    having count(distinct ulp.lesson_id) >= v_total_aulas
      and max(ulp.completed_at) >= v_cutoff
  ) p
  inner join auth.users u on u.id = p.user_id
  left join public.leads l on lower(l.email::text) = lower(u.email)
  left join public.sdr_contact_triggers t
    on t.trail_slug = v_trail_slug
    and t.trigger_type = 'trilha_concluida'
    and t.lead_email = coalesce(l.email, u.email::citext)

  order by 1 asc, 8 asc;
end;
$$;

revoke all on function public.get_marketing_nova_sdr_queue() from public;
grant execute on function public.get_marketing_nova_sdr_queue() to authenticated;

-- Marca (ou desmarca) o contato como feito para um gatilho específico.
create or replace function public.mark_sdr_lead_contacted(
  p_trail_slug text,
  p_trigger_type text,
  p_lead_email text,
  p_contacted boolean
)
returns public.sdr_contact_triggers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trail_slug text := trim(coalesce(p_trail_slug, ''));
  v_trigger_type text := trim(coalesce(p_trigger_type, ''));
  v_email citext := lower(trim(coalesce(p_lead_email, '')));
  v_row public.sdr_contact_triggers;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if v_trail_slug = '' or v_trigger_type = '' or v_email = '' then
    raise exception 'Parâmetros obrigatórios ausentes.';
  end if;

  insert into public.sdr_contact_triggers (trail_slug, trigger_type, lead_email, contacted_at, contacted_by)
  values (
    v_trail_slug,
    v_trigger_type,
    v_email,
    case when p_contacted then now() else null end,
    case when p_contacted then coalesce(auth.jwt() ->> 'email', 'admin') else null end
  )
  on conflict (trail_slug, trigger_type, lead_email) do update
  set
    contacted_at = case when p_contacted then now() else null end,
    contacted_by = case when p_contacted then coalesce(auth.jwt() ->> 'email', 'admin') else null end
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.mark_sdr_lead_contacted(text, text, text, boolean) from public;
grant execute on function public.mark_sdr_lead_contacted(text, text, text, boolean) to authenticated;
