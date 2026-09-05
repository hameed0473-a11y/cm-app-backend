// ===================================================================
// Central ID generator. Every child record's ID is prefixed with the
// owning pro user's own ID, so IDs are globally unique by construction
// — no two users can ever produce the same string, regardless of how
// many records either of them creates. The sequence number itself
// comes from an atomic Postgres counter (public.next_seq), so two
// concurrent requests for the same user/entity type never collide
// either.
//
// Format: <userId>-<entityCode>-<seq, zero-padded>
//   e.g. pro-59476314-gm-0001, pro-59476314-c-0007, pro-59476314-rc-000042
// ===================================================================

const ENTITY_CODES = {
  monthly: 'gm',
  yearly: 'gy',
  special: 'gs',
  event: 'ge',
  pledge: 'gp',
  installment: 'gi',
  contributor: 'c',
  contribution: 'rc',
  ticket: 'tk',
  expense: 'ex',
  payee: 'py'
};

const PAD = {
  contribution: 6
};

async function nextId(supabase, userId, entityType) {
  const code = ENTITY_CODES[entityType];
  if (!code) throw new Error(`nextId: unknown entity type "${entityType}"`);

  const { data, error } = await supabase.rpc('next_seq', {
    p_user_id: userId,
    p_entity_type: entityType
  });
  if (error) throw new Error(`nextId (${entityType}) failed: ${error.message}`);

  const seq = String(data).padStart(PAD[entityType] || 4, '0');
  return `${userId}-${code}-${seq}`;
}

// Goal/target categories all share one counter family ("gm"/"gy"/"gs"/"ge"/"gp")
// but each category counts independently, e.g. a user's first pledge is
// -gp-0001 even if they already have five monthly goals.
function goalEntityType(category) {
  if (!['monthly', 'yearly', 'special', 'event', 'pledge', 'installment'].includes(category)) {
    throw new Error(`goalEntityType: unknown category "${category}"`);
  }
  return category;
}

module.exports = { nextId, goalEntityType };
