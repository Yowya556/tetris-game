-- Run in Supabase SQL editor. Client must never receive service-role access.
create table if not exists public.scores (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id),
  player_name text not null check (char_length(player_name) between 1 and 24),
  score integer not null check (score between 0 and 100000000),
  replay_hash text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (user_id, replay_hash)
);
alter table public.scores enable row level security;
create policy "public leaderboard read" on public.scores for select using (true);
revoke insert, update, delete on public.scores from anon, authenticated;

create table if not exists public.player_profiles (
  user_id uuid primary key references auth.users(id),
  coins integer not null default 0 check (coins >= 0),
  elite_theme boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.player_profiles enable row level security;
create policy "users read own profile" on public.player_profiles for select using (auth.uid() = user_id);
revoke insert, update, delete on public.player_profiles from anon, authenticated;

create or replace function public.submit_verified_score(p_user_id uuid, p_player_name text, p_score integer, p_replay_hash text, p_idempotency_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user_id is null or p_score < 0 or p_score > 100000000 or char_length(trim(p_player_name)) not between 1 and 24 then
    raise exception 'invalid score';
  end if;
  insert into public.scores(user_id, player_name, score, replay_hash, idempotency_key)
  values (p_user_id, left(trim(p_player_name), 24), p_score, p_replay_hash, p_idempotency_key)
  on conflict (user_id, idempotency_key) do nothing;
end; $$;
revoke all on function public.submit_verified_score from public, anon, authenticated;

create table if not exists public.purchase_events (
  provider_event_id text primary key,
  user_id uuid not null references auth.users(id),
  product_id text not null,
  created_at timestamptz not null default now()
);
create or replace function public.grant_purchase_once(p_user_id uuid, p_provider_event_id text, p_product_id text, p_coins integer, p_theme text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.purchase_events(provider_event_id, user_id, product_id)
  values (p_provider_event_id, p_user_id, p_product_id)
  on conflict (provider_event_id) do nothing;
  if not found then return; end if;
  insert into public.player_profiles(user_id, coins, elite_theme)
  values (p_user_id, greatest(0, p_coins), p_theme = 'elite')
  on conflict (user_id) do update set coins = public.player_profiles.coins + greatest(0, p_coins), elite_theme = public.player_profiles.elite_theme or (p_theme = 'elite'), updated_at = now();
end; $$;
revoke all on function public.grant_purchase_once from public, anon, authenticated;
