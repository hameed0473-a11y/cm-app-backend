-- Staff login redesign — run this once, AFTER sql/staff_users.sql.
--
-- Staff no longer log in with a mobile number (that shared the owner's own
-- /web-login form and mixed the two together). Instead each staff member
-- gets a fixed, system-generated login id: "<owner's pro_users.id>.<2-digit
-- sequence>" — e.g. an owner id of "pro-12345678" gets staff ids
-- "pro-12345678.01", ".02", and so on, assigned in order as the owner adds
-- staff. They log in through a separate Staff Login screen using that id
-- plus the password set for them at registration. Email is now collected
-- at registration too (contact/recovery info); mobile becomes optional.
alter table pro_users add column if not exists staff_seq integer not null default 0;

alter table staff_users add column if not exists email text;
alter table staff_users add column if not exists staff_user_id text unique;

-- mobile is no longer the login key — make it optional contact info only.
alter table staff_users alter column mobile drop not null;
alter table staff_users drop constraint if exists staff_users_mobile_key;
