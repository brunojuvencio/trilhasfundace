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
  stage_id bigint,
  stage_changed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.sdr_contact_triggers
  add column if not exists stage_id bigint,
  add column if not exists stage_changed_at timestamptz;

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

-- Etapas do Kanban, configuráveis por funil. Cada trigger_type (situação A e
-- situação B) é o seu próprio funil, com etapas independentes. A etapa com
-- is_default=true é onde um lead recém-chegado aparece por padrão (ainda sem
-- linha em sdr_contact_triggers).
create table if not exists public.sdr_pipeline_stages (
  id bigint generated always as identity primary key,
  funil text not null,
  stage_key text not null,
  nome text not null,
  ordem integer not null default 1,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.sdr_pipeline_stages
  add column if not exists funil text,
  add column if not exists stage_key text,
  add column if not exists nome text,
  add column if not exists ordem integer not null default 1,
  add column if not exists is_default boolean not null default false,
  add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sdr_pipeline_stages_unique'
      and conrelid = 'public.sdr_pipeline_stages'::regclass
  ) then
    alter table public.sdr_pipeline_stages
      add constraint sdr_pipeline_stages_unique unique (funil, stage_key);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sdr_contact_triggers_stage_fk'
      and conrelid = 'public.sdr_contact_triggers'::regclass
  ) then
    alter table public.sdr_contact_triggers
      add constraint sdr_contact_triggers_stage_fk
      foreign key (stage_id) references public.sdr_pipeline_stages (id) on delete set null;
  end if;
end $$;

alter table public.sdr_pipeline_stages enable row level security;

drop policy if exists "Admins can read sdr pipeline stages" on public.sdr_pipeline_stages;
create policy "Admins can read sdr pipeline stages"
on public.sdr_pipeline_stages
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can write sdr pipeline stages" on public.sdr_pipeline_stages;
create policy "Admins can write sdr pipeline stages"
on public.sdr_pipeline_stages
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Semente: os dois funis (situação A e B) começam com as mesmas duas etapas.
-- O time pode renomear, reordenar, adicionar ou remover (menos a primeira)
-- depois, pela tela.
insert into public.sdr_pipeline_stages (funil, stage_key, nome, ordem, is_default)
values
  ('intencao_imediata', 'lead', 'Lead', 1, true),
  ('intencao_imediata', 'primeira_abordagem', 'Primeira abordagem', 2, false),
  ('trilha_concluida', 'lead', 'Lead', 1, true),
  ('trilha_concluida', 'primeira_abordagem', 'Primeira abordagem', 2, false)
on conflict (funil, stage_key) do nothing;

create or replace function public.list_sdr_pipeline_stages(p_funil text)
returns setof public.sdr_pipeline_stages
language sql
security definer
set search_path = public
as $$
  select *
  from public.sdr_pipeline_stages
  where funil = trim(coalesce(p_funil, ''))
    and public.is_admin()
  order by ordem asc;
$$;

revoke all on function public.list_sdr_pipeline_stages(text) from public;
grant execute on function public.list_sdr_pipeline_stages(text) to authenticated;

create or replace function public.create_sdr_pipeline_stage(
  p_funil text,
  p_nome text
)
returns public.sdr_pipeline_stages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_funil text := trim(coalesce(p_funil, ''));
  v_nome text := trim(coalesce(p_nome, ''));
  v_key text;
  v_next_ordem integer;
  v_row public.sdr_pipeline_stages;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if v_funil = '' or v_nome = '' then
    raise exception 'Nome da etapa é obrigatório.';
  end if;

  -- Slug simples (sem depender da extensão unaccent) + sufixo aleatório pra
  -- garantir unicidade mesmo com nomes repetidos ou só de acentos/símbolos.
  v_key := lower(regexp_replace(v_nome, '[^a-zA-Z0-9]+', '_', 'g')) || '_' || substr(md5(random()::text), 1, 6);

  select coalesce(max(ordem), 0) + 1 into v_next_ordem
  from public.sdr_pipeline_stages
  where funil = v_funil;

  insert into public.sdr_pipeline_stages (funil, stage_key, nome, ordem, is_default)
  values (v_funil, v_key, v_nome, v_next_ordem, false)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_sdr_pipeline_stage(text, text) from public;
grant execute on function public.create_sdr_pipeline_stage(text, text) to authenticated;

create or replace function public.rename_sdr_pipeline_stage(
  p_stage_id bigint,
  p_nome text
)
returns public.sdr_pipeline_stages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text := trim(coalesce(p_nome, ''));
  v_row public.sdr_pipeline_stages;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if v_nome = '' then
    raise exception 'Nome da etapa é obrigatório.';
  end if;

  update public.sdr_pipeline_stages
  set nome = v_nome
  where id = p_stage_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Etapa não encontrada.';
  end if;

  return v_row;
end;
$$;

revoke all on function public.rename_sdr_pipeline_stage(bigint, text) from public;
grant execute on function public.rename_sdr_pipeline_stage(bigint, text) to authenticated;

create or replace function public.reorder_sdr_pipeline_stages(
  p_funil text,
  p_stage_ids bigint[]
)
returns setof public.sdr_pipeline_stages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_funil text := trim(coalesce(p_funil, ''));
  v_id bigint;
  v_pos integer := 1;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  foreach v_id in array p_stage_ids loop
    update public.sdr_pipeline_stages
    set ordem = v_pos
    where id = v_id and funil = v_funil;
    v_pos := v_pos + 1;
  end loop;

  return query
  select * from public.sdr_pipeline_stages where funil = v_funil order by ordem asc;
end;
$$;

revoke all on function public.reorder_sdr_pipeline_stages(text, bigint[]) from public;
grant execute on function public.reorder_sdr_pipeline_stages(text, bigint[]) to authenticated;

create or replace function public.delete_sdr_pipeline_stage(p_stage_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_default boolean;
  v_in_use integer;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  select is_default into v_is_default from public.sdr_pipeline_stages where id = p_stage_id;

  if v_is_default is null then
    raise exception 'Etapa não encontrada.';
  end if;

  if v_is_default then
    raise exception 'Não é possível excluir a etapa inicial do funil.';
  end if;

  select count(*) into v_in_use from public.sdr_contact_triggers where stage_id = p_stage_id;
  if v_in_use > 0 then
    raise exception 'Mova os leads dessa etapa antes de excluí-la (% ainda nela).', v_in_use;
  end if;

  delete from public.sdr_pipeline_stages where id = p_stage_id;
end;
$$;

revoke all on function public.delete_sdr_pipeline_stage(bigint) from public;
grant execute on function public.delete_sdr_pipeline_stage(bigint) to authenticated;

-- Move um lead de etapa (usado pelo Kanban, arrastar ou pelo select "mover
-- para"). Sair da etapa inicial marca contato feito (se ainda não estava);
-- voltar pra etapa inicial desfaz a marca de contato.
create or replace function public.move_sdr_lead_stage(
  p_trail_slug text,
  p_trigger_type text,
  p_lead_email text,
  p_stage_id bigint
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
  v_is_default boolean;
  v_row public.sdr_contact_triggers;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if v_trail_slug = '' or v_trigger_type = '' or v_email = '' then
    raise exception 'Parâmetros obrigatórios ausentes.';
  end if;

  select is_default into v_is_default from public.sdr_pipeline_stages where id = p_stage_id and funil = v_trigger_type;
  if v_is_default is null then
    raise exception 'Etapa inválida para esse funil.';
  end if;

  insert into public.sdr_contact_triggers (trail_slug, trigger_type, lead_email, stage_id, stage_changed_at, contacted_at, contacted_by)
  values (
    v_trail_slug, v_trigger_type, v_email, p_stage_id, now(),
    case when not v_is_default then now() else null end,
    case when not v_is_default then coalesce(auth.jwt() ->> 'email', 'admin') else null end
  )
  on conflict (trail_slug, trigger_type, lead_email) do update
  set
    stage_id = p_stage_id,
    stage_changed_at = now(),
    contacted_at = case
      when v_is_default then null
      when public.sdr_contact_triggers.contacted_at is not null then public.sdr_contact_triggers.contacted_at
      else now()
    end,
    contacted_by = case
      when v_is_default then null
      when public.sdr_contact_triggers.contacted_by is not null then public.sdr_contact_triggers.contacted_by
      else coalesce(auth.jwt() ->> 'email', 'admin')
    end
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.move_sdr_lead_stage(text, text, text, bigint) from public;
grant execute on function public.move_sdr_lead_stage(text, text, text, bigint) to authenticated;

-- Biblioteca de abordagens salvas: cada uma tem uma tag curta (o que aparece
-- no card, escolhido num select) e a mensagem completa (fica só aqui, o SDR
-- não digita ela no card).
create table if not exists public.sdr_approach_templates (
  id bigint generated always as identity primary key,
  trail_slug text not null default 'trilha-nova-de-marketing',
  tag text not null,
  message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sdr_approach_templates
  add column if not exists trail_slug text not null default 'trilha-nova-de-marketing',
  add column if not exists tag text,
  add column if not exists message text not null default '',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sdr_approach_templates_unique'
      and conrelid = 'public.sdr_approach_templates'::regclass
  ) then
    alter table public.sdr_approach_templates
      add constraint sdr_approach_templates_unique unique (trail_slug, tag);
  end if;
end $$;

alter table public.sdr_approach_templates enable row level security;

drop policy if exists "Admins can read sdr approach templates" on public.sdr_approach_templates;
create policy "Admins can read sdr approach templates"
on public.sdr_approach_templates
for select
to authenticated
using (public.is_admin());

drop policy if exists "Admins can write sdr approach templates" on public.sdr_approach_templates;
create policy "Admins can write sdr approach templates"
on public.sdr_approach_templates
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create or replace function public.list_sdr_approach_templates(p_trail_slug text default 'trilha-nova-de-marketing')
returns setof public.sdr_approach_templates
language sql
security definer
set search_path = public
as $$
  select *
  from public.sdr_approach_templates
  where trail_slug = coalesce(nullif(trim(p_trail_slug), ''), 'trilha-nova-de-marketing')
    and public.is_admin()
  order by tag asc;
$$;

revoke all on function public.list_sdr_approach_templates(text) from public;
grant execute on function public.list_sdr_approach_templates(text) to authenticated;

create or replace function public.upsert_sdr_approach_template(
  p_trail_slug text,
  p_tag text,
  p_message text
)
returns public.sdr_approach_templates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trail_slug text := coalesce(nullif(trim(p_trail_slug), ''), 'trilha-nova-de-marketing');
  v_tag text := trim(coalesce(p_tag, ''));
  v_row public.sdr_approach_templates;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  if v_tag = '' then
    raise exception 'A tag da abordagem é obrigatória.';
  end if;

  insert into public.sdr_approach_templates (trail_slug, tag, message)
  values (v_trail_slug, v_tag, coalesce(p_message, ''))
  on conflict (trail_slug, tag) do update
  set message = coalesce(p_message, ''), updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_sdr_approach_template(text, text, text) from public;
grant execute on function public.upsert_sdr_approach_template(text, text, text) to authenticated;

create or replace function public.delete_sdr_approach_template(
  p_trail_slug text,
  p_tag text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Acesso negado.';
  end if;

  delete from public.sdr_approach_templates
  where trail_slug = coalesce(nullif(trim(p_trail_slug), ''), 'trilha-nova-de-marketing')
    and tag = trim(coalesce(p_tag, ''));
end;
$$;

revoke all on function public.delete_sdr_approach_template(text, text) from public;
grant execute on function public.delete_sdr_approach_template(text, text) to authenticated;

-- Empurra um timestamp pra segunda-feira 00:00 (America/Sao_Paulo) se ele cair
-- num fim de semana (sábado ou domingo); nos demais dias devolve sem alterar.
-- Usada pra calcular prazo de contato sem contar sábado/domingo como tempo útil.
create or replace function public.sdr_skip_weekend(p_ts timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case extract(dow from (p_ts at time zone 'America/Sao_Paulo'))
    when 6 then (date_trunc('day', p_ts at time zone 'America/Sao_Paulo') + interval '2 days') at time zone 'America/Sao_Paulo'
    when 0 then (date_trunc('day', p_ts at time zone 'America/Sao_Paulo') + interval '1 day') at time zone 'America/Sao_Paulo'
    else p_ts
  end;
$$;

-- Universo completo de gatilhos da trilha nova de Marketing (situações A e B),
-- SEM corte por data — usado tanto pela fila (que aplica o corte) quanto pelas
-- métricas (que precisam do histórico inteiro). Função interna, não exposta.
drop function if exists public.get_marketing_nova_sdr_all();
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
  abordagem text,
  stage_id bigint,
  stage_nome text,
  stage_ordem integer,
  stage_is_default boolean,
  stage_desde timestamptz
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
      (date_trunc('day', public.sdr_skip_weekend(l.created_at) at time zone 'America/Sao_Paulo') + interval '1 day' - interval '1 second')
      at time zone 'America/Sao_Paulo'
    ),
    t.contacted_at,
    t.contacted_by,
    t.responded,
    t.responded_at,
    t.approach_tag,
    coalesce(st.id, ds.id),
    coalesce(st.nome, ds.nome),
    coalesce(st.ordem, ds.ordem),
    coalesce(st.is_default, ds.is_default, true),
    coalesce(t.stage_changed_at, l.created_at)
  from public.leads l
  left join public.sdr_contact_triggers t
    on t.trail_slug = v_trail_slug
    and t.trigger_type = 'intencao_imediata'
    and t.lead_email = l.email
  left join public.sdr_pipeline_stages st on st.id = t.stage_id
  left join public.sdr_pipeline_stages ds on ds.funil = 'intencao_imediata' and ds.is_default = true
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
    (
      case
        when extract(dow from ((public.sdr_skip_weekend(p.gatilho_em) + interval '24 hours') at time zone 'America/Sao_Paulo')) in (0, 6)
          then public.sdr_skip_weekend(p.gatilho_em) + interval '24 hours' + interval '48 hours'
        else public.sdr_skip_weekend(p.gatilho_em) + interval '24 hours'
      end
    ),
    t.contacted_at,
    t.contacted_by,
    t.responded,
    t.responded_at,
    t.approach_tag,
    coalesce(st.id, ds.id),
    coalesce(st.nome, ds.nome),
    coalesce(st.ordem, ds.ordem),
    coalesce(st.is_default, ds.is_default, true),
    coalesce(t.stage_changed_at, p.gatilho_em)
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
    and t.lead_email = coalesce(l.email, u.email::citext)
  left join public.sdr_pipeline_stages st on st.id = t.stage_id
  left join public.sdr_pipeline_stages ds on ds.funil = 'trilha_concluida' and ds.is_default = true;
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
  abordagem text,
  stage_id bigint,
  stage_nome text,
  stage_ordem integer,
  stage_is_default boolean,
  stage_desde timestamptz
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
