# sql/

One-time migration SQL snippets. Run each file's contents in the Supabase SQL editor (or via `supabase db push` if using the CLI). They use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so re-running them is safe.

## contact_inquiries.sql

Creates the `contact_inquiries` table for the Aftech website contact form. Each row is a submission from the "Tell us your requirement" form on `aftechs.in`. The backend also emails each submission to `admin@aftechs.in` as a real-time notice, but this table is the durable record.

## staff_users.sql

Creates the `staff_users` table for limited-access staff accounts that belong to a treasurer (`pro_users`). Also adds `collected_by_id` to `contributions` and `collected_by` + `collected_by_id` to `pledges`, so payments collected by staff are attributed on receipts with both a display name and a stable ID.

## staff_login_id.sql

Helper for the staff login lookup path.

## Applying migrations

1. Open your Supabase project → SQL Editor
2. Paste the file contents
3. Click Run

The main CM App schema (pro_users, pro_user_data, targets, contributors, etc.) is managed separately and is not in this directory.
