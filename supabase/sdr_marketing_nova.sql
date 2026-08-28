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
  responded boolean,
  responded_at timestamptz,
  approach_tag text,
  created_at timestamptz not null default now()
);

alter table public.sdr_contact_triggers
  add column if not exists trail_slug text,
  add column if not exists trigger_type text,
  add column if not exists lead_email citext,
  add column if not exists contacted_at timestamptz,
  add column if not exists contacted_by text,
  add column if not exists responded boolean,
  add column if not exists responded_at timestamptz,
  add column if not exists approach_tag text,
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

-- Universo completo de gatilhos da trilha nova de Marketing (situações A e B),
-- SEM corte por data — usado tanto pela fila (que aplica o corte) quanto pelas
-- métricas (que precisam do histórico inteiro). Função interna, não exposta.
create or replace function public.get_marketing_nova_sdr_all()
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
  contatado_por text,
  respondeu boolean,
  respondido_em timestamptz,
  abordagem text
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
    t.contacted_by,
    t.responded,
    t.responded_at,
    t.approach_tag
  from public.leads l
  left join public.sdr_contact_triggers t
    on t.trail_slug = v_trail_slug
    and t.trigger_type = 'intencao_imediata'
    and t.lead_email = l.email
  where l.nome_trilha = v_trail_nome
    and l.pretende_pos = 'sim_agora'

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
    t.contacted_by,
    t.responded,
    t.responded_at,
    t.approach_tag
  from (
    select ulp.user_id, max(ulp.completed_at) as gatilho_em
    from public.user_lesson_progress ulp
    inner join public.aulas a on a.id::text = ulp.lesson_id
    where a.trilha_id = v_trilha_id
    group by ulp.user_id
    having count(distinct ulp.lesson_id) >= v_total_aulas
  ) p
  inner join auth.users u on u.id = p.user_id
  left join public.leads l on lower(l.email::text) = lower(u.email)
  left join public.sdr_contact_triggers t
    on t.trail_slug = v_trail_slug
    and t.trigger_type = 'trilha_concluida'
    and t.lead_email = coalesce(l.email, u.email::citext);
end;
$$;

revoke all on function public.get_marketing_nova_sdr_all() from public;
grant execute on function public.get_marketing_nova_sdr_all() to authenticated;

-- Fila pra tela do SDR: só entra quem gatilhou de ontem pra cá, OU quem já foi
-- contatado (pra não sumir da lista de "já contatados" no dia seguinte).
drop function if exists public.get_marketing_nova_sdr_queue();
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
  contatado_por text,
  respondeu boolean,
  respondido_em timestamptz,
  abordagem text
)
language sql
security definer
set search_path = public
as $$
  -- Corte FIXO (não é "ontem" relativo a hoje, senão o pendente que passar
  -- disso some da fila igual sumia o contatado antes). Serve só pra não
  -- começar com o backlog de antes do painel existir; a partir daqui, tudo
  -- que gatilhar fica na fila até ser contatado, não importa há quanto tempo.
  select *
  from public.get_marketing_nova_sdr_all()
  where gatilho_em >= timestamptz '2026-08-25 00:00:00-03'
     or contatado_em is not null
  order by situacao asc, prazo_em asc;
$$;

revoke all on function public.get_marketing_nova_sdr_queue() from public;
grant execute on function public.get_marketing_nova_sdr_queue() to authenticated;

-- Marca (ou desmarca) o contato como feito para um gatilho específico.
-- Desmarcar também limpa resposta/abordagem, já que deixam de fazer sentido.
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
    contacted_by = case when p_contacted then coalesce(auth.jwt() ->> 'email', 'admin') else null end,
    responded = case when p_contacted then public.sdr_contact_triggers.responded else null end,
    responded_at = case when p_contacted then public.sdr_contact_triggers.responded_at else null end,
    approach_tag = case when p_contacted then public.sdr_contact_triggers.approach_tag else null end
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.mark_sdr_lead_contacted(text, text, text, boolean) from public;
grant execute on function public.mark_sdr_lead_contacted(text, text, text, boolean) to authenticated;

-- Marca se o lead respondeu (ou não) após o contato.
create or replace function public.set_sdr_lead_responded(
  p_trail_slug text,
  p_trigger_type text,
  p_lead_email text,
  p_responded boolean
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

  update public.sdr_contact_triggers
  set
    responded = p_responded,
    responded_at = case when p_responded then now() else null end
  where trail_slug = v_trail_slug
    and trigger_type = v_trigger_type
    and lead_email = v_email
    and contacted_at is not null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Marque o contato como feito antes de registrar a resposta.';
  end if;

  return v_row;
end;
$$;

revoke all on function public.set_sdr_lead_responded(text, text, text, boolean) from public;
grant execute on function public.set_sdr_lead_responded(text, text, text, boolean) to authenticated;

-- Salva a tag de abordagem inicial usada no contato.
create or replace function public.set_sdr_lead_approach(
  p_trail_slug text,
  p_trigger_type text,
  p_lead_email text,
  p_approach_tag text
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
  v_approach text := nullif(trim(coalesce(p_approach_tag, '')), '');
  v_row public.sdr_contact_triggers;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  update public.sdr_contact_triggers
  set approach_tag = v_approach
  where trail_slug = v_trail_slug
    and trigger_type = v_trigger_type
    and lead_email = v_email
    and contacted_at is not null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Marque o contato como feito antes de registrar a abordagem.';
  end if;

  return v_row;
end;
$$;

revoke all on function public.set_sdr_lead_approach(text, text, text, text) from public;
grant execute on function public.set_sdr_lead_approach(text, text, text, text) to authenticated;

-- Métricas gerais + quebra por abordagem, calculadas sobre o histórico
-- completo (sem o corte de "ontem pra cá" que a fila usa).
create or replace function public.get_marketing_nova_sdr_metrics()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total integer;
  v_contatados integer;
  v_contatados_no_prazo integer;
  v_respondidos integer;
  v_por_abordagem jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  select count(*) into v_total from public.get_marketing_nova_sdr_all();

  select
    count(*) filter (where contatado_em is not null),
    count(*) filter (where contatado_em is not null and contatado_em <= prazo_em),
    count(*) filter (where respondeu is true)
  into v_contatados, v_contatados_no_prazo, v_respondidos
  from public.get_marketing_nova_sdr_all();

  select coalesce(jsonb_agg(row_to_json(x) order by x.total_contatados desc), '[]'::jsonb)
  into v_por_abordagem
  from (
    select
      abordagem,
      count(*) as total_contatados,
      count(*) filter (where respondeu is true) as total_respondidos,
      case when count(*) > 0
        then round(100.0 * count(*) filter (where respondeu is true) / count(*), 1)
        else 0
      end as taxa_resposta_pct
    from public.get_marketing_nova_sdr_all()
    where abordagem is not null
      and contatado_em is not null
    group by abordagem
  ) x;

  return jsonb_build_object(
    'total_gatilhos', v_total,
    'total_contatados', v_contatados,
    'total_contatados_no_prazo', v_contatados_no_prazo,
    'total_respondidos', v_respondidos,
    'taxa_resposta_dos_contatados_pct', case when v_contatados > 0 then round(100.0 * v_respondidos / v_contatados, 1) else 0 end,
    'taxa_contato_no_prazo_pct', case when v_contatados > 0 then round(100.0 * v_contatados_no_prazo / v_contatados, 1) else 0 end,
    'taxa_resposta_geral_pct', case when v_total > 0 then round(100.0 * v_respondidos / v_total, 1) else 0 end,
    'por_abordagem', v_por_abordagem
  );
end;
$$;

revoke all on function public.get_marketing_nova_sdr_metrics() from public;
grant execute on function public.get_marketing_nova_sdr_metrics() to authenticated;
