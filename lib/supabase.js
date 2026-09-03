const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ---------------------------------------------------------------
// Supabase client — single shared instance used by every route file.
// (Moved here unchanged from the original routes/auth.js so every
// route reuses the same connection instead of creating its own.)
// ---------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

module.exports = supabase;
