// The one place that knows which roles a stored account may hold. It lives on
// its own, with no imports and no side effects, because two copies of this list
// already drifted apart: `Design` was added to the user store but not to the
// PostgreSQL CHECK constraint, so every Design account failed to replicate.
// Anything that validates or persists a role must read it from here.
//
// `Creator` is deliberately absent: the owner is a singleton assembled from the
// environment (config.creator), never a row in the user store.
// CEO carries exactly the Admin capabilities: every authorization list that
// names Admin names CEO beside it. The separate name exists so the title on
// the account matches the title in the company.
export const ASSIGNABLE_ROLES = Object.freeze(["Admin", "CEO", "Design", "Member", "Viewer"]);

export const ASSIGNABLE_ROLE_SET = new Set(ASSIGNABLE_ROLES);

// Rendered into DDL, so it quotes for SQL rather than for JSON.
export function rolesSqlList() {
  return ASSIGNABLE_ROLES.map((role) => `'${role}'`).join(", ");
}

// "Admin, Design, Member, or Viewer" — kept next to the list so the message a
// user sees cannot fall out of step with what is actually accepted.
export function rolesSentence() {
  if (ASSIGNABLE_ROLES.length < 2) return ASSIGNABLE_ROLES[0] || "";
  return `${ASSIGNABLE_ROLES.slice(0, -1).join(", ")}, or ${ASSIGNABLE_ROLES.at(-1)}`;
}
