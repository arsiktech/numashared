# Shared household ledger

Numa Shared records one pot’s shared financial history and the identities allowed to act in it. Identity, access, and debt counterparties are related but deliberately distinct.

## Language

**Account**:
An authenticated person who may claim one member identity in a pot. An account is never itself a balance or settlement counterparty.
_Avoid_: User, participant, settlement unit

**Member profile**:
The erasable per-pot identity record containing a display name, role, state, and optional settlement-unit binding.
_Avoid_: Event, account

**Pending identity**:
An unclaimed member profile that can already participate in expenses and balances before an account claims it.
_Avoid_: Placeholder, invitation

**Settlement unit**:
A debt counterparty used by the ledger reducer. A unit may represent one member or a non-overlapping settlement group and is not an authentication identity.
_Avoid_: Account, member profile

**Claim**:
The binding of an account to an existing pending identity. Detaching a wrong claim restores that identity to pending without deleting its history.
_Avoid_: Invite, new member

**Archived member**:
A member profile whose access and future participation have ended while its historical attribution and unresolved balance remain visible.
_Avoid_: Deleted member, removed history
