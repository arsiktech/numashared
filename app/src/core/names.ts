// How people and groups are named on screen, from the viewer's point of view.
import type { Category, Cents, Group, ID, Person } from './types';

const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  groceries: 'Groceries',
  household: 'Household',
  rent: 'Rent',
  bills: 'Bills',
  internet: 'Internet',
  'eating-out': 'Eating out',
  cleaning: 'Cleaning',
  other: 'Other',
};

/** "Eating out" for 'eating-out'. Also exported from explain.ts. */
export function categoryLabel(category: Category): string {
  return CATEGORY_LABELS[category] ?? 'Other';
}

/** "You" for the viewer, otherwise the person's name. Unknown ids read "Someone". */
export function personName(personId: ID, people: Person[], viewerId: ID): string {
  if (personId === viewerId) return 'You';
  return people.find((p) => p.id === personId)?.name ?? 'Someone';
}

function members(group: Group, people: Person[]): Person[] {
  return group.memberIds
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is Person => p !== undefined);
}

/** "You + Sam", "You", "Alex + Jo", "Mia". The viewer always comes first. */
export function groupName(group: Group, people: Person[], viewerId: ID): string {
  const list = members(group, people);
  if (list.length === 0) return 'Nobody';
  const viewer = list.find((p) => p.id === viewerId);
  const ordered = viewer ? [viewer, ...list.filter((p) => p !== viewer)] : list;
  return ordered.map((p) => (p.id === viewerId ? 'You' : p.name)).join(' + ');
}

/** Whether the group's name takes a plural verb: "You owe", "You + Sam owe", "Alex + Jo owe". */
export function isPlural(group: Group, people: Person[], viewerId: ID): boolean {
  const list = members(group, people);
  return list.length > 1 || list.some((p) => p.id === viewerId);
}

export type StandingVerb = 'owe' | 'owes' | 'get back' | 'gets back' | 'square';
export type Standing = { verb: StandingVerb; amount: Cents };

/**
 * A balance as a verb and a positive amount: −5820 for "You + Sam" -> { verb: 'owe', amount: 5820 };
 * +1320 for "Mia" -> { verb: 'gets back', amount: 1320 }; 0 -> { verb: 'square', amount: 0 }.
 */
export function standing(balance: Cents, group: Group, people: Person[], viewerId: ID): Standing {
  if (balance === 0) return { verb: 'square', amount: 0 };
  const plural = isPlural(group, people, viewerId);
  if (balance < 0) return { verb: plural ? 'owe' : 'owes', amount: -balance };
  return { verb: plural ? 'get back' : 'gets back', amount: balance };
}
