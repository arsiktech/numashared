import { describe, expect, test } from "vitest";

import type { Doc } from "./_generated/dataModel";
import {
  contestedBody,
  isNotificationEligible,
  notificationBody,
  unitNotificationRecipients,
} from "./lib/notificationMatrix";

type EventPayload = Doc<"events">["payload"];

// Only the fields each function reads are needed; the cast keeps the fixtures readable.
function payload(value: unknown): EventPayload {
  return value as EventPayload;
}

describe("GOAL_BRIEF section 6 notification matrix", () => {
  test("every body is pot-named, calm, and carries no amount", () => {
    const bodies = [
      notificationBody(payload({ kind: "expenseAdded" }), "Casa Mar"),
      notificationBody(payload({ kind: "expenseRevised" }), "Casa Mar"),
      notificationBody(payload({ kind: "recordVoided" }), "Casa Mar"),
      notificationBody(payload({ kind: "settlementRecorded" }), "Casa Mar"),
      contestedBody("Casa Mar"),
    ];
    for (const body of bodies) {
      expect(body).toBeTruthy();
      expect(body).toContain("Casa Mar");
      // No digits, no currency marks, no exclamation: amount-free and calm per canon.
      expect(body).not.toMatch(/[0-9]|[€$£]|!/);
    }
  });

  test("opening-balance revisions use record-neutral copy", () => {
    expect(notificationBody(payload({
      kind: "expenseRevised",
      content: { kind: "openingBalance" },
    }), "Casa Mar")).toBe(
      "A record in Casa Mar was edited and affects your balance",
    );
  });

  test("kinds outside the matrix never notify", () => {
    for (const kind of [
      "openingBalanceSet",
      "settlementFlagged",
      "recordRestored",
      "memberAdded",
      "memberClaimed",
      "memberArchived",
      "ownershipTransferred",
      "potRenamed",
    ]) {
      expect(notificationBody(payload({ kind }), "Casa Mar")).toBeNull();
      expect(isNotificationEligible(payload({ kind }))).toBe(false);
    }
  });

  test("eligibility is derived from the same exhaustive body matrix", () => {
    for (const kind of [
      "expenseAdded",
      "expenseRevised",
      "recordVoided",
      "settlementRecorded",
    ]) {
      expect(isNotificationEligible(payload({ kind }))).toBe(true);
    }
  });

  test("the actor never gets a push and muted members are skipped", () => {
    expect(unitNotificationRecipients({
      affectedUnitIds: ["unit-1", "unit-2", "unit-3"],
      unitMembers: new Map([
        ["unit-1", new Set(["member-actor"])],
        ["unit-2", new Set(["member-b"])],
        ["unit-3", new Set(["member-muted"])],
      ]),
      actorMemberId: "member-actor",
      mutedMemberIds: new Set(["member-muted"]),
    })).toEqual(["member-b"]);
  });

  test("an unknown unit is ignored rather than inventing a recipient", () => {
    expect(unitNotificationRecipients({
      affectedUnitIds: ["ghost-unit"],
      unitMembers: new Map(),
      actorMemberId: "member-actor",
      mutedMemberIds: new Set(),
    })).toEqual([]);
  });

  test("two units held by one member produce a single recipient", () => {
    expect(unitNotificationRecipients({
      affectedUnitIds: ["unit-1", "unit-2"],
      unitMembers: new Map([
        ["unit-1", new Set(["member-b"])],
        ["unit-2", new Set(["member-b"])],
      ]),
      actorMemberId: "member-actor",
      mutedMemberIds: new Set(),
    })).toEqual(["member-b"]);
  });

  test("a group unit reaches every unmuted member represented by it", () => {
    expect(unitNotificationRecipients({
      affectedUnitIds: ["group-unit"],
      unitMembers: new Map([
        ["group-unit", new Set(["member-actor", "member-b", "member-muted"])],
      ]),
      actorMemberId: "member-actor",
      mutedMemberIds: new Set(["member-muted"]),
    })).toEqual(["member-b"]);
  });
});
