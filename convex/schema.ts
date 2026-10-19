import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  budgetGroupTopologyValidator,
  eventPayloadValidator,
  memberRoleValidator,
  membershipStatusValidator,
  textFieldValidator,
} from "./model";

export default defineSchema({
  accounts: defineTable({
    publicAccountId: v.string(),
    appleSubjectHash: v.string(),
    relayEmail: v.optional(v.string()),
    deletionStartedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_public_account_id", ["publicAccountId"])
    .index("by_apple_subject_hash", ["appleSubjectHash"]),

  sessions: defineTable({
    sessionId: v.string(),
    accountId: v.id("accounts"),
    refreshTokenHash: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    rotatedAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_refresh_token_hash", ["refreshTokenHash"])
    .index("by_account", ["accountId"]),

  refreshTokenHistory: defineTable({
    tokenHash: v.string(),
    sessionId: v.string(),
    accountId: v.id("accounts"),
    rotatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_session", ["sessionId"])
    .index("by_account", ["accountId"])
    .index("by_expires_at", ["expiresAt"]),

  identityRateLimits: defineTable({
    bucketKey: v.string(),
    windowStartedAt: v.number(),
    count: v.int64(),
    expiresAt: v.number(),
  })
    .index("by_bucket_key", ["bucketKey"])
    .index("by_expires_at", ["expiresAt"]),

  accountWriteQuotas: defineTable({
    accountId: v.id("accounts"),
    scope: v.union(
      v.literal("event"),
      v.literal("potCreate"),
      v.literal("inviteIssue"),
    ),
    windowStartedAt: v.number(),
    count: v.int64(),
    expiresAt: v.number(),
  })
    .index("by_account_scope", ["accountId", "scope"])
    .index("by_account", ["accountId"])
    .index("by_expires_at", ["expiresAt"]),

  appleAuthorizations: defineTable({
    accountId: v.id("accounts"),
    encryptedRefreshToken: v.string(),
    encryptionNonce: v.string(),
    encryptionKeyVersion: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    authorizedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  appleIdentityNotifications: defineTable({
    notificationEventId: v.string(),
    jwtId: v.string(),
    eventType: v.string(),
    appleSubjectHash: v.string(),
    accountId: v.optional(v.id("accounts")),
    eventTime: v.number(),
    processedAt: v.number(),
  })
    .index("by_notification_event_id", ["notificationEventId"])
    .index("by_account", ["accountId"])
    .index("by_apple_subject_hash", ["appleSubjectHash"]),

  // A completed deletion may remove the refresh credential before the HTTP response
  // reaches the device. This short-lived, random request receipt lets that exact retry
  // return success without retaining an account id, Apple subject, email, or token hash.
  accountDeletionReceipts: defineTable({
    requestId: v.string(),
    completedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_expires_at", ["expiresAt"]),

  // An authenticated deletion request keeps only this opaque resume handle while its
  // bounded erasure batches run. The row is removed atomically with the account after
  // the completion receipt is written, so destroying sessions cannot strand deletion.
  accountDeletionProgress: defineTable({
    requestId: v.string(),
    accountId: v.id("accounts"),
    startedAt: v.number(),
  })
    .index("by_request_id", ["requestId"])
    .index("by_account", ["accountId"]),

  // Card sync (cardSync.ts): one active link per household, and the spends it has added.
  cardSyncLinks: defineTable({
    potId: v.string(),
    accountId: v.id("accounts"),
    actorMemberId: v.string(),
    keyHash: v.string(),
    timeZone: v.string(),
    cards: v.array(v.object({ last4: v.string(), forUnitId: v.string(), label: v.string() })),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    added: v.int64(),
  })
    .index("by_pot", ["potId"])
    .index("by_key_hash", ["keyHash"]),

  cardSyncSpends: defineTable({
    potId: v.string(),
    spendId: v.string(),
    eventId: v.string(),
    card: v.string(),
    addedAt: v.number(),
  }).index("by_pot_spend", ["potId", "spendId"]),

  appConfiguration: defineTable({
    key: v.literal("global"),
    minimumSupportedBuild: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  pots: defineTable({
    potId: v.string(),
    currencyCode: v.string(),
    currencyExponent: v.int64(),
    orderedUnitIds: v.array(v.string()),
    initialOrderedUnitIds: v.optional(v.array(v.string())),
    ownerAccountId: v.id("accounts"),
    // Current pot name, projected from the latest potRenamed event. Optional because a
    // pot is created before it is ever named. The server needs it to compose the
    // pot-named, amount-free push text (§6) without the client sending display strings.
    name: v.optional(v.string()),
    minimumReaderSchemaVersion: v.int64(),
    budgetGroupTopology: v.optional(budgetGroupTopologyValidator),
    nextSequence: v.int64(),
    nextTextRevision: v.int64(),
    positiveContributionBudget: v.int64(),
    negativeContributionBudget: v.int64(),
    legacyMigrationCompletedAt: v.optional(v.number()),
    archivedAtSequence: v.optional(v.int64()),
    /** Set when the owner starts deleting the household; nothing can join or write after. */
    deletingAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_pot_id", ["potId"]),

  potMembers: defineTable({
    potId: v.string(),
    accountId: v.id("accounts"),
    memberId: v.string(),
    role: memberRoleValidator,
    status: membershipStatusValidator,
    archivedAtSequence: v.optional(v.int64()),
    joinedAt: v.number(),
  })
    .index("by_pot_account", ["potId", "accountId"])
    .index("by_account_status", ["accountId", "status"])
    .index("by_pot_member", ["potId", "memberId"]),

  // Erasure-capable per-pot identity projection. Display names never enter the
  // append-only event envelope: structural events remain the audit source while this
  // small sidecar provides the current roster and can be anonymized independently.
  potMemberProfiles: defineTable({
    potId: v.string(),
    memberId: v.string(),
    unitId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    role: memberRoleValidator,
    state: v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("archived"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_pot_member", ["potId", "memberId"]),

  events: defineTable({
    potId: v.string(),
    eventId: v.string(),
    recordId: v.optional(v.string()),
    reversalOfRecordId: v.optional(v.string()),
    actorMemberId: v.string(),
    occurredAtMillis: v.int64(),
    originatingTimeZone: v.string(),
    schemaVersion: v.int64(),
    sequence: v.int64(),
    payload: eventPayloadValidator,
    textFields: v.array(textFieldValidator),
    legacyAuthoredText: v.optional(v.boolean()),
    groupExpectedRevision: v.optional(v.int64()),
    createdAt: v.number(),
  })
    .index("by_pot_sequence", ["potId", "sequence"])
    .index("by_pot_kind", ["potId", "payload.kind", "sequence"])
    .index("by_pot_record", ["potId", "recordId", "sequence"])
    .index("by_pot_reversal", ["potId", "reversalOfRecordId", "sequence"])
    .index("by_pot_event", ["potId", "eventId"])
    .index("by_event_id", ["eventId"]),

  eventTexts: defineTable({
    potId: v.string(),
    eventId: v.string(),
    sequence: v.int64(),
    field: textFieldValidator,
    value: v.string(),
    authorAccountId: v.id("accounts"),
    createdAt: v.number(),
  })
    .index("by_event_field", ["potId", "eventId", "field"])
    .index("by_author", ["authorAccountId"])
    .index("by_pot_event", ["potId", "eventId"])
    .index("by_pot_sequence", ["potId", "sequence"]),

  textRedactions: defineTable({
    potId: v.string(),
    eventId: v.string(),
    sequence: v.int64(),
    field: textFieldValidator,
    revision: v.int64(),
    redactedAt: v.number(),
  })
    .index("by_pot_revision", ["potId", "revision"])
    .index("by_event_field", ["potId", "eventId", "field"]),

  // P3 invites. Raw credentials are never stored: high-entropy link tokens use SHA-256,
  // while six-character codes use a deployment-secret, domain-separated HMAC so a
  // database leak cannot enumerate their small value space offline. Per-member invites
  // bind 1:1 to a pending memberId and are consumed by the first claim; pot-link invites
  // are multi-use and every claim requires owner approval before history is visible.
  invites: defineTable({
    potId: v.string(),
    inviteId: v.string(),
    kind: v.union(v.literal("perMember"), v.literal("potLink")),
    tokenHash: v.string(),
    codeHash: v.string(),
    pendingMemberId: v.optional(v.string()),
    issuedByAccountId: v.id("accounts"),
    status: v.union(
      v.literal("active"),
      v.literal("revoked"),
      v.literal("consumed"),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_pot", ["potId"])
    .index("by_issuer", ["issuedByAccountId"])
    .index("by_invite_id", ["inviteId"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_code_hash", ["codeHash"]),

  // APNs device tokens per account. A token is globally unique to one device, so a
  // re-registration from another account moves it rather than duplicating it. Apple's
  // 410 Unregistered response and SIWA revocation both drop tokens (P3.4 fan-out).
  pushTokens: defineTable({
    accountId: v.id("accounts"),
    deviceToken: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    timeZone: v.string(),
    updatedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_token", ["deviceToken"]),

  // Per-pot, per-account mute. Respected server-side before fan-out, so a muted member
  // costs no APNs delivery at all rather than being filtered on the device.
  potMutes: defineTable({
    potId: v.string(),
    accountId: v.id("accounts"),
    mutedAt: v.number(),
  })
    .index("by_pot_account", ["potId", "accountId"])
    .index("by_account", ["accountId"]),

  // Pot-link claims awaiting the owner's decision. Per-member invites skip this table:
  // their single claim is bound and consumed directly. A claim references the identity
  // the joiner picked ("I'm Leo" → memberId) or none ("I'm new here" → undefined).
  inviteClaims: defineTable({
    potId: v.string(),
    inviteId: v.string(),
    claimantAccountId: v.id("accounts"),
    chosenMemberId: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
    ),
    createdAt: v.number(),
  })
    .index("by_pot", ["potId"])
    .index("by_pot_status", ["potId", "status"])
    .index("by_invite", ["inviteId"])
    .index("by_claimant", ["claimantAccountId"])
    .index("by_pot_claimant", ["potId", "claimantAccountId"]),
});
