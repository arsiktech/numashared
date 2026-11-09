// What a connected agent may change, one switch each (convex/agentAccess.ts setPermission). Reading
// is always allowed. New connections start with every switch on; the server enforces them on the
// agent's next call. Nothing here can let an agent delete an account or a household, leave a
// household or remove someone: no switch exists for that.

export type AgentPermission = 'addRecords' | 'editRecords' | 'manageHousehold';
export type AgentPermissions = Record<AgentPermission, boolean>;

/** The switches in the order Settings shows them. The labels are the names refusals quote to the agent. */
export const AGENT_SWITCHES: ReadonlyArray<{ key: AgentPermission; label: string; sub?: string }> = [
  { key: 'addRecords', label: 'Add expenses and repayments' },
  { key: 'editRecords', label: 'Edit and void records' },
  { key: 'manageHousehold', label: 'Manage the household', sub: 'Rename it, make invite codes, set groups, add people who haven’t joined' },
];

export const READ_ONLY: AgentPermissions = { addRecords: false, editRecords: false, manageHousehold: false };

/** One switch changed, the rest kept. */
export const withPermission = (current: AgentPermissions, key: AgentPermission, allowed: boolean): AgentPermissions =>
  ({ ...current, [key]: allowed });

/** "Can read and add", "Can read, add and manage the household", "Can only read": a line under the agent's name. */
export function permissionSummary(p: AgentPermissions): string {
  const can = [p.addRecords ? 'add' : null, p.editRecords ? 'edit' : null, p.manageHousehold ? 'manage the household' : null]
    .filter((x): x is string => x !== null);
  if (can.length === 0) return 'Can only read';
  const all = ['read', ...can];
  return `Can ${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}
