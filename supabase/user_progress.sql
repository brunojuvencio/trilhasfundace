create table if not exists public.user_lesson_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_id text not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

alter table public.user_lesson_progress enable row level security;

drop policy if exists "Users can read own lesson progress" on public.user_lesson_progress;
create policy "Users can read own lesson progress"
on public.user_lesson_progress
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can insert own lesson progress" on public.user_lesson_progress;
create policy "Users can insert own lesson progress"
on public.user_lesson_progress
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "Users can update own lesson progress" on public.user_lesson_progress;
create policy "Users can update own lesson progress"
on public.user_lesson_progress
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create index if not exists user_lesson_progress_user_completed_idx
  on public.user_lesson_progress (user_id, completed_at desc);
