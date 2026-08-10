-- Adiciona suporte a vídeos do YouTube além do Vimeo nas aulas.
-- Execute este script no SQL Editor do Supabase.

alter table public.aulas
  add column if not exists video_provider text not null default 'vimeo';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aulas_video_provider_check'
      and conrelid = 'public.aulas'::regclass
  ) then
    alter table public.aulas
      add constraint aulas_video_provider_check
      check (video_provider in ('vimeo', 'youtube'));
  end if;
end $$;

alter table public.aulas drop constraint if exists aulas_vimeo_id_numeric_check;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'aulas_video_id_format_check'
      and conrelid = 'public.aulas'::regclass
  ) then
    alter table public.aulas
      add constraint aulas_video_id_format_check
      check (
        (video_provider = 'vimeo' and vimeo_id ~ '^[0-9]+$')
        or (video_provider = 'youtube' and vimeo_id ~ '^[A-Za-z0-9_-]{11}$')
      );
  end if;
end $$;
