-- Returns aggregate counts for the homepage "Live from our community" section.
-- Defined as SECURITY DEFINER so it bypasses RLS for the count itself, but it
-- only ever returns three numbers — no rows or PII are exposed.
--
-- Apply via the Supabase SQL editor: paste the whole file and click Run.

create or replace function public.get_smartfeed_stats()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'signups', (select count(*) from public.profiles),
    'meals',   (select count(*) from public.food_log
                where logged_at >= now() - interval '7 days'),
    'active',  (select count(distinct user_id) from public.food_log
                where logged_at >= now() - interval '7 days')
  );
$$;

grant execute on function public.get_smartfeed_stats() to anon, authenticated;
