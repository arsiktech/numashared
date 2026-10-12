import type { Doc } from "../_generated/dataModel";

type EventPayload = Doc<"events">["payload"];

// GOAL_BRIEF §6 is exhaustive: nothing outside this set notifies. Opening balances and
// settlement flags deliberately stay silent. Text is English, calm, sentence case,
// pot-named, and carries NO amount — the server never puts money in a payload.
export function notificationBody(
  payload: EventPayload,
  potName: string,
): string | null {
  switch (payload.kind) {
    case "expenseAdded":
      return `New expense in ${potName} affects your balance`;
    case "expenseRevised":
      return `A record in ${potName} was edited and affects your balance`;
    case "recordVoided":
      return `A record in ${potName} was voided and affects your balance`;
    case "settlementRecorded":
      return `A settlement in ${potName} involves your balance`;
    default:
      return null;
  }
}

export function isNotificationEligible(payload: EventPayload): boolean {
  return notificationBody(payload, "") !== null;
}

// A contested record asks both heads' authors to choose; it is the one notification not
// derived from a single event's units.
export function contestedBody(potName: string): string {
  return `A record in ${potName} needs your choice`;
}

// Recipients for a unit-derived notification: every member holding an affected unit,
// minus the actor (§6 — the actor never gets a push for their own action) and minus
// members who muted the pot. `unitMembers` maps each personal or settlement-group unit
// to every member represented by it.
export function unitNotificationRecipients(args: {
  affectedUnitIds: readonly string[];
  unitMembers: ReadonlyMap<string, ReadonlySet<string>>;
  actorMemberId: string;
  mutedMemberIds: ReadonlySet<string>;
}): string[] {
  const recipients = new Set<string>();
  for (const unitId of args.affectedUnitIds) {
    for (const memberId of args.unitMembers.get(unitId) ?? []) {
      if (memberId === args.actorMemberId) continue;
      if (args.mutedMemberIds.has(memberId)) continue;
      recipients.add(memberId);
    }
  }
  return [...recipients].sort();
}
