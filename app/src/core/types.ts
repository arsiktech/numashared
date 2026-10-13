// Domain types shared by the ledger core, the store and the screens.
// Money is always integer minor units (cents). Nothing here is ever mutated in place:
// a household changes only by appending events.

export type Cents = number;
export type ID = string;

export type GroupColor = 'citrus' | 'lilac' | 'sky' | 'mint' | 'butter' | 'rose';
export const GROUP_COLORS: readonly GroupColor[] = ['citrus', 'lilac', 'sky', 'mint', 'butter', 'rose'];
export const MAX_GROUPS = GROUP_COLORS.length;

export type Person = {
  id: ID;
  name: string;
  groupId: ID;
  /** False while the person is invited but has not joined from their own device. */
  joined: boolean;
  joinedAt?: number;
};

/** People who pay as one (a couple) or a single person. One balance per group. */
export type Group = {
  id: ID;
  color: GroupColor;
  memberIds: ID[];
};

export type Category =
  | 'groceries' | 'household' | 'rent' | 'bills' | 'internet'
  | 'eating-out' | 'cleaning' | 'other';

export type PaymentMethod = 'bizum' | 'bank' | 'cash' | 'other';

/** How an expense is divided between groups. Custom drags are stored as exact shares. */
export type Split =
  | { mode: 'equal'; groupIds: ID[]; weighting: 'group' | 'person' }
  | { mode: 'exact'; shares: Record<ID, Cents> };

export type ExpenseContent = {
  payerId: ID;          // a person; their group pays
  amount: Cents;        // > 0
  date: string;         // YYYY-MM-DD, the day it happened
  category: Category;
  title?: string;       // optional custom name; otherwise the category label is shown
  note?: string;        // optional free text, e.g. "Apples, bread and coffee"
  split: Split;
};

export type SettlementContent = {
  fromGroupId: ID;
  toGroupId: ID;
  amount: Cents;        // > 0
  date: string;
  method?: PaymentMethod;
  note?: string;
  /** Set when this repayment corrects a flagged one (opposite direction, linked). */
  reversalOf?: ID;
};

export type OpeningEntry = { fromGroupId: ID; toGroupId: ID; amount: Cents };
export type OpeningContent = { entries: OpeningEntry[]; note?: string; date: string };

type Base = { id: ID; at: number; by: ID };

export type LedgerEvent =
  | (Base & { kind: 'expenseAdded'; recordId: ID; content: ExpenseContent })
  | (Base & { kind: 'expenseRevised'; recordId: ID; content: ExpenseContent; reason?: string })
  | (Base & { kind: 'openingBalanceSet'; recordId: ID; content: OpeningContent })
  | (Base & { kind: 'settlementRecorded'; recordId: ID; content: SettlementContent })
  | (Base & { kind: 'settlementFlagged'; recordId: ID; reason?: string })
  | (Base & { kind: 'recordVoided'; recordId: ID; reason: string })
  | (Base & { kind: 'recordRestored'; recordId: ID });

export type EventKind = LedgerEvent['kind'];

export type Household = {
  id: ID;
  name: string;
  currency: string;     // ISO 4217, fixed once the first financial record exists
  createdAt: number;
  people: Person[];
  groups: Group[];
  /** The person using this device. */
  youId: ID;
  events: LedgerEvent[];
  /** eventId -> personId -> time they saw it. */
  seen: Record<ID, Record<ID, number>>;
  /** Invite code shown on the Invite screen. */
  inviteCode: string;
};

// ---------- derived ----------

export type RecordKind = 'expense' | 'settlement' | 'opening';

export type TimelineEntry =
  | { type: 'added'; at: number; by: ID; eventId: ID }
  | { type: 'edited'; at: number; by: ID; eventId: ID; reason?: string; changes: FieldChange[] }
  | { type: 'voided'; at: number; by: ID; eventId: ID; reason: string }
  | { type: 'restored'; at: number; by: ID; eventId: ID }
  | { type: 'flagged'; at: number; by: ID; eventId: ID; reason?: string }
  | { type: 'seen'; at: number; personId: ID; eventId: ID };

export type FieldChange = { field: 'amount' | 'payer' | 'category' | 'title' | 'note' | 'date' | 'split'; from: string; to: string };

export type LedgerRecord = {
  id: ID;
  kind: RecordKind;
  createdAt: number;
  createdBy: ID;
  updatedAt: number;
  /** Current content (latest revision). */
  expense?: ExpenseContent;
  settlement?: SettlementContent;
  opening?: OpeningContent;
  /** Every revision of the content, oldest first (expenses only have more than one). */
  revisions: { eventId: ID; at: number; by: ID; content: ExpenseContent | SettlementContent | OpeningContent }[];
  voided: boolean;
  voidReason?: string;
  flagged: boolean;
  /** Signed effect on each group's balance; positive = that group gets money back. Zero-sum. Empty when voided. */
  effect: Record<ID, Cents>;
  timeline: TimelineEntry[];
};

export type Ledger = {
  records: LedgerRecord[];          // chronological by createdAt
  byId: Record<ID, LedgerRecord>;
  balances: Record<ID, Cents>;      // every group id present, zero-sum
};

export type Transfer = { fromGroupId: ID; toGroupId: ID; amount: Cents };
export type PlanOutcome = { status: 'exact'; transfers: Transfer[] } | { status: 'unavailable' };

export type ExplainLine = {
  recordId: ID;
  at: number;
  date: string;
  label: string;
  detail: string;
  change: Cents;      // effect on the asked group
  running: Cents;     // balance after this line
  voided: boolean;
};
