-- Staff accounts feature — run this once in the Supabase SQL editor.
--
-- A staff account is a limited-access login that belongs to one Pro
-- owner (pro_users.id). Staff can log in from the same /web-login form
-- as the owner (looked up by mobile, same as owner accounts) but only
-- reach a small allow-listed set of endpoints: reading dashboard data,
-- adding contributors, subscribing contributors to a goal, and
-- collecting payments. Every other /web-* endpoint keeps rejecting
-- non-owner tokens exactly as it already does today.
create table if not exists staff_users (
  id text primary key default ('STAFF-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
  owner_user_id text not null references pro_users(id) on delete cascade,
  name text not null,
  mobile text not null unique,
  password text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create index if not exists staff_users_owner_idx on staff_users(owner_user_id);

-- `contributions` already has collected_by but never collected_by_id.
-- `pledges` (event/special-goal payments) has neither. Add what's missing
-- on both so a payment collected by staff can be attributed correctly —
-- both which name printed on the receipt AND a stable reference id —
-- whether it's viewed/reprinted right away or looked up later.
alter table contributions add column if not exists collected_by_id text;
alter table pledges add column if not exists collected_by text;
alter table pledges add column if not exists collected_by_id text;
