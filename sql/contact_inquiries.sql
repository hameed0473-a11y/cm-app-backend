-- Website contact form — run this once in the Supabase SQL editor.
--
-- Public, unauthenticated submissions from the "Tell us your requirement"
-- form on the aftechs-website landing page (POST /contact-inquiry). Every
-- submission is also emailed to admin@aftechs.in as a best-effort notice,
-- but this table is the durable record if that email ever fails to send.
create table if not exists contact_inquiries (
  id bigint generated always as identity primary key,
  name text not null,
  email text,
  mobile text,
  project_type text not null default 'other' check (project_type in ('mobile', 'web', 'both', 'other')),
  requirement text not null,
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  created_at timestamptz not null default now()
);

create index if not exists contact_inquiries_created_at_idx on contact_inquiries(created_at desc);
