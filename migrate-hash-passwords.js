// ===================================================================
// One-time migration: hash any plaintext passwords still sitting in
// the `users` table (Basic/Lite tier). Safe to re-run — it only ever
// touches rows whose password does NOT already look like a bcrypt
// hash (bcrypt hashes always start with "$2"), so already-hashed rows
// are left untouched on every run.
//
// This does NOT touch pro_users — that table has always hashed
// passwords correctly since /pro/register was built.
//
// Usage: node migrate-hash-passwords.js
// Run from the backend project root (needs ./lib/supabase.js and your
// real .env in place, same as running the server itself).
// ===================================================================

const bcrypt = require('bcryptjs');
const supabase = require('./lib/supabase');

async function main() {
  console.log('Fetching all users…');
  const { data: users, error } = await supabase
    .from('users')
    .select('id, password');

  if (error) {
    console.error('Could not fetch users:', error.message);
    process.exit(1);
  }

  const plaintextUsers = users.filter(u => u.password && !u.password.startsWith('$2'));
  console.log(`Total users: ${users.length}`);
  console.log(`Already hashed: ${users.length - plaintextUsers.length}`);
  console.log(`Plaintext (need hashing): ${plaintextUsers.length}\n`);

  if (plaintextUsers.length === 0) {
    console.log('Nothing to do — every password is already hashed.');
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (const u of plaintextUsers) {
    try {
      const hashed = await bcrypt.hash(u.password, 10);
      const { error: updateError } = await supabase
        .from('users')
        .update({ password: hashed })
        .eq('id', u.id);

      if (updateError) {
        console.log(`  ✗ user id ${u.id}: ${updateError.message}`);
        failed++;
      } else {
        console.log(`  ✓ user id ${u.id}: hashed successfully`);
        succeeded++;
      }
    } catch (err) {
      console.log(`  ✗ user id ${u.id}: ${err?.message || err}`);
      failed++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nSome rows failed — re-run this script again; it only touches remaining plaintext rows.');
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Migration script crashed:', err);
  process.exit(1);
});
