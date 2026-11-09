// The tools a connected agent can use, as MCP tool definitions. Reading tools call one internal
// query each; writing tools call convex/agentWrites.ts `write`. Both run as the connection's
// account, so the app's membership checks apply unchanged, and the server, not these
// descriptions, enforces the person's switches. `AgentIo` is supplied by the HTTP endpoint or a test.
//
// There is no tool, and no other path, that deletes an account or a household, leaves a household
// or removes a member (agentMcp.test.ts checks the list).
import type { AgentWriteOp } from "../agentWrites";

type Json = Record<string, unknown>;
type Schema = { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties: false };

export type AgentReader = "households" | "members" | "balances" | "records";

export type AgentIo = {
  read: (reader: AgentReader, args: Json) => Promise<unknown>;
  write: (op: AgentWriteOp, requestId: string) => Promise<unknown>;
};

/** The switch in Settings, AI agents that a writing tool needs. */
export type AgentSwitchName = "addRecords" | "editRecords" | "manageHousehold";

export type AgentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  /** Set on tools that change something. */
  writes?: AgentSwitchName;
  /** Replaces or removes something people see (an edit, a void, a new name, new groups). */
  destructive?: boolean;
  run: (io: AgentIo, args: Json) => Promise<unknown>;
};

/** A mistake in what the agent sent: reported back to it as a tool error, never as a server failure. */
export class AgentInputError extends Error {}

export const AGENT_INSTRUCTIONS =
  "Numa Shared records who paid, who benefited and who owes whom in a household. Numa Shared never moves money: "
  + "recording a repayment only notes money that moved elsewhere. "
  + "You act as the person who connected you, and the household's history shows your changes as theirs \"via\" you. "
  + "Reading is always allowed. Adding, editing and managing the household each need a switch the person controls in Settings, AI agents; "
  + "a refused call names the switch. Nobody can delete an account or a household, leave a household or remove a member through you. "
  + "Start with list_households to get household ids, and list_members for member_id values. "
  + "Amounts are whole minor units (cents): 12.50 EUR is amount_minor_units 1250 with currency EUR, and the currency must be the household's. "
  + "Every change takes a request_id you choose; send the same one only to retry the same call, so nothing is added twice. "
  + "Check with the person before you change or void something they didn't ask for. "
  + "In balances, a positive amount means that person is owed money and a negative amount means they owe money.";

const str = (description: string, extra: Json = {}): Json => ({ type: "string", description, ...extra });
const schema = (properties: Record<string, Json>, required: string[] = []): Schema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

const household = str("Household id from list_households.");
const requestId = str("A unique id you choose for this change (8 to 100 letters, digits, '.', '_', ':' or '-'), such as a UUID. Send the same id only to retry this exact call: the retry answers the same and adds nothing.");
const minorUnits = { type: "integer", minimum: 1, description: "The amount in whole minor units (cents): 1250 for 12.50." };
const currency = str("The household's currency code, such as EUR. A different currency is refused: there is no conversion.");
const person = str("A member_id from list_members (a person). A unitId from list_members or get_balances (a group) also works where a group is meant.");
const date = str("The day it happened, YYYY-MM-DD. Default today.");
const timeZone = str("IANA time zone the person is in, such as Europe/Madrid. Default: the person's phone, else UTC.");
const NEVER = "Numa Shared never moves money.";
const splitSchema: Json = {
  type: "object",
  description: "How the cost is shared. {\"mode\":\"equal\"} splits it equally between every group; add \"between\" (member or unit ids) to split between some, and \"per_person\": true to weigh each group by its number of people. {\"mode\":\"exact\",\"shares\":[{\"who\":id,\"minor_units\":n}]} gives exact shares that must add up to the amount.",
  properties: {
    mode: { type: "string", enum: ["equal", "exact"] },
    between: { type: "array", items: { type: "string" } },
    per_person: { type: "boolean" },
    shares: { type: "array", items: { type: "object", properties: { who: { type: "string" }, minor_units: { type: "integer", minimum: 0 } }, required: ["who", "minor_units"], additionalProperties: false } },
  },
  required: ["mode"],
  additionalProperties: false,
};

function text(args: Json, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > 100) {
    throw new AgentInputError(`${key} is required (text from list_households)`);
  }
  return value;
}

function optionalText(args: Json, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 100) throw new AgentInputError(`${key} must be short text`);
  return value;
}

/** Refuses properties the tool doesn't define, so a misspelt field never goes unnoticed. */
function onlyKnown(args: Json, tool: AgentTool): void {
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new AgentInputError(`${tool.name} has no argument "${key}"`);
  }
}

function requestIdOf(args: Json): string {
  const value = args.request_id;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,100}$/.test(value)) {
    throw new AgentInputError("request_id is required: a unique id you choose, 8 to 100 letters, digits, '.', '_', ':' or '-'");
  }
  return value;
}

/** A whole number of minor units. 12.5 or "12.50" are refused: say 1250. */
function wholeMinorUnits(args: Json, key: string, required: true): bigint;
function wholeMinorUnits(args: Json, key: string, required: false): bigint | undefined;
function wholeMinorUnits(args: Json, key: string, required: boolean): bigint | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new AgentInputError(`${key} is required: the amount in whole minor units (cents), 1250 for 12.50`);
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d{1,15}$/.test(value)) return BigInt(value);
  throw new AgentInputError(`${key} must be a whole number of minor units (cents): 1250 for 12.50, not 12.5`);
}

function requiredText(args: Json, key: string, what: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > 600) throw new AgentInputError(`${key} is required: ${what}`);
  return value;
}

function textOrUndefined(args: Json, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 600) throw new AgentInputError(`${key} must be text`);
  return value;
}

function idList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every((x) => typeof x === "string" && x.length > 0 && x.length <= 100)) {
    throw new AgentInputError(`${key} must be a list of ids from list_members`);
  }
  return value as string[];
}

type SplitOp = Extract<AgentWriteOp, { tool: "add_expense" }>["split"];

function splitOf(value: unknown): SplitOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentInputError('split is required: {"mode":"equal"} or {"mode":"exact","shares":[...]}');
  }
  const split = value as Json;
  for (const key of Object.keys(split)) {
    if (!["mode", "between", "per_person", "shares"].includes(key)) throw new AgentInputError(`split has no field "${key}"`);
  }
  if (split.mode === "equal") {
    if (split.shares !== undefined) throw new AgentInputError("an equal split takes between, not shares");
    if (split.per_person !== undefined && typeof split.per_person !== "boolean") throw new AgentInputError("split.per_person must be true or false");
    return {
      mode: "equal",
      perPerson: split.per_person === true,
      ...(split.between === undefined ? {} : { between: idList(split.between, "split.between") }),
    };
  }
  if (split.mode === "exact") {
    if (split.between !== undefined || split.per_person !== undefined) throw new AgentInputError("an exact split takes shares only");
    if (!Array.isArray(split.shares) || split.shares.length === 0 || split.shares.length > 64) {
      throw new AgentInputError("split.shares must list {who, minor_units} for each group that shares the cost");
    }
    return {
      mode: "exact",
      shares: split.shares.map((share: unknown) => {
        if (!share || typeof share !== "object") throw new AgentInputError("each share is {who, minor_units}");
        const entry = share as Json;
        if (Object.keys(entry).some((k) => k !== "who" && k !== "minor_units")) throw new AgentInputError("each share is {who, minor_units}");
        return { who: requiredText(entry, "who", "a member_id or unitId"), minorUnits: wholeMinorUnits(entry, "minor_units", true) };
      }),
    };
  }
  throw new AgentInputError('split.mode must be "equal" or "exact"');
}

const optional = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value });

export const agentTools: AgentTool[] = [
  {
    name: "list_households",
    title: "List households",
    description: "The households this person belongs to, with currency, their role and how many people are in each.",
    inputSchema: schema({}),
    run: (io) => io.read("households", {}),
  },
  {
    name: "list_members",
    title: "List people",
    description: "The people in one household, with their role and whether each is active.",
    inputSchema: schema({ household }, ["household"]),
    run: (io, args) => io.read("members", { potId: text(args, "household") }),
  },
  {
    name: "get_balances",
    title: "Get balances",
    description: "Who is owed money and who owes money in one household, from all live expenses, repayments and opening balances.",
    inputSchema: schema({ household }, ["household"]),
    run: (io, args) => io.read("balances", { potId: text(args, "household") }),
  },
  {
    name: "list_records",
    title: "List records",
    description:
      "Expenses, repayments and opening balances in one household, newest first, with who paid and how it was split. "
      + "Pass before_sequence from a previous answer's nextBeforeSequence to read older records.",
    inputSchema: schema({
      household,
      limit: { type: "number", description: "How many records, 1 to 50. Default 25." },
      before_sequence: str("Cursor from a previous answer's nextBeforeSequence."),
      record_id: str("Read just this record."),
    }, ["household"]),
    run: (io, args) => {
      const limit = args.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) {
        throw new AgentInputError("limit must be a number");
      }
      const beforeSequence = optionalText(args, "before_sequence");
      const recordId = optionalText(args, "record_id");
      return io.read("records", {
        potId: text(args, "household"),
        ...(limit === undefined ? {} : { limit }),
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
        ...(recordId === undefined ? {} : { recordId }),
      });
    },
  },
  {
    name: "add_expense",
    title: "Add an expense",
    writes: "addRecords",
    description:
      "Records an expense in one household as the person who connected you: who paid, how much and how it is shared. "
      + "It changes balances and the other people involved get a notification, as when the app adds one. "
      + `Needs the "Add expenses and repayments" switch. ${NEVER}`,
    inputSchema: schema({
      household, request_id: requestId,
      amount_minor_units: minorUnits, currency,
      title: str("What it was, such as Weekly shop. Default: the category's name."),
      category: str("One of groceries, household, rent, bills, internet, eating-out, cleaning, other. Default other."),
      note: str("Optional note."),
      paid_by: str("member_id of the person who paid. Default: the person who connected you."),
      split: splitSchema,
      date, time_zone: timeZone,
    }, ["household", "request_id", "amount_minor_units", "currency", "split"]),
    run: (io, args) => io.write({
      tool: "add_expense",
      potId: text(args, "household"),
      amountMinorUnits: wholeMinorUnits(args, "amount_minor_units", true),
      currency: requiredText(args, "currency", "the household's currency code, such as EUR"),
      split: splitOf(args.split),
      ...optional("title", textOrUndefined(args, "title")),
      ...optional("category", textOrUndefined(args, "category")),
      ...optional("note", textOrUndefined(args, "note")),
      ...optional("paidBy", textOrUndefined(args, "paid_by")),
      ...optional("date", textOrUndefined(args, "date")),
      ...optional("timeZone", textOrUndefined(args, "time_zone")),
    }, requestIdOf(args)),
  },
  {
    name: "add_repayment",
    title: "Record a repayment",
    writes: "addRecords",
    description:
      "Notes that one person or group paid another back, outside Numa Shared (cash, bank transfer, Bizum). "
      + "It changes balances and notifies the people involved, as in the app. "
      + `Needs the "Add expenses and repayments" switch. ${NEVER} This only records a payment that already happened.`,
    inputSchema: schema({
      household, request_id: requestId,
      amount_minor_units: minorUnits, currency,
      from: { ...person, description: "Who paid back: a member_id or unitId." },
      to: { ...person, description: "Who was paid back: a member_id or unitId." },
      method: str("Optional: bizum, bank, cash or other."),
      note: str("Optional note."),
      date, time_zone: timeZone,
    }, ["household", "request_id", "amount_minor_units", "currency", "from", "to"]),
    run: (io, args) => io.write({
      tool: "add_repayment",
      potId: text(args, "household"),
      amountMinorUnits: wholeMinorUnits(args, "amount_minor_units", true),
      currency: requiredText(args, "currency", "the household's currency code, such as EUR"),
      from: requiredText(args, "from", "who paid back (member_id or unitId)"),
      to: requiredText(args, "to", "who was paid back (member_id or unitId)"),
      ...optional("method", textOrUndefined(args, "method")),
      ...optional("note", textOrUndefined(args, "note")),
      ...optional("date", textOrUndefined(args, "date")),
      ...optional("timeZone", textOrUndefined(args, "time_zone")),
    }, requestIdOf(args)),
  },
  {
    name: "edit_record",
    title: "Edit an expense",
    writes: "editRecords",
    destructive: true,
    description:
      "Changes an expense: give only the fields that change. Everyone sees the edit in the history, with the old and new values. "
      + "Pass the record's revision from list_records; if someone changed it since, the edit is refused so you can read it again. "
      + "Voided records and repayments can't be edited. If you change the amount of an expense that isn't split equally, give the new split too. "
      + `Needs the "Edit and void records" switch. ${NEVER}`,
    inputSchema: schema({
      household, request_id: requestId,
      record_id: str("recordId from list_records."),
      revision: str("revision from list_records, the version you are changing."),
      amount_minor_units: minorUnits, currency,
      title: str("New title."), category: str("New category."), note: str("New note; an empty string removes it."),
      paid_by: str("member_id of who paid."), split: splitSchema, date,
      reason: str("Why it changed, shown in the history."),
    }, ["household", "request_id", "record_id", "revision"]),
    run: (io, args) => {
      const amount = wholeMinorUnits(args, "amount_minor_units", false);
      const currencyCode = textOrUndefined(args, "currency");
      if (amount !== undefined && currencyCode === undefined) throw new AgentInputError("currency is required with amount_minor_units");
      return io.write({
        tool: "edit_record",
        potId: text(args, "household"),
        recordId: requiredText(args, "record_id", "recordId from list_records"),
        revision: requiredText(args, "revision", "revision from list_records"),
        ...optional("amountMinorUnits", amount),
        ...optional("currency", currencyCode),
        ...optional("title", textOrUndefined(args, "title")),
        ...optional("category", textOrUndefined(args, "category")),
        ...optional("note", textOrUndefined(args, "note")),
        ...optional("paidBy", textOrUndefined(args, "paid_by")),
        ...(args.split === undefined ? {} : { split: splitOf(args.split) }),
        ...optional("date", textOrUndefined(args, "date")),
        ...optional("reason", textOrUndefined(args, "reason")),
      }, requestIdOf(args));
    },
  },
  {
    name: "void_record",
    title: "Void an expense",
    writes: "editRecords",
    destructive: true,
    description:
      "Voids an expense or opening balance: it stays in the history, marked void with your reason, and no longer counts in balances. "
      + "Repayments can't be voided here. "
      + `Needs the "Edit and void records" switch. ${NEVER}`,
    inputSchema: schema({
      household, request_id: requestId,
      record_id: str("recordId from list_records."),
      reason: str("Why, shown to everyone in the history. Required."),
    }, ["household", "request_id", "record_id", "reason"]),
    run: (io, args) => io.write({
      tool: "void_record",
      potId: text(args, "household"),
      recordId: requiredText(args, "record_id", "recordId from list_records"),
      reason: requiredText(args, "reason", "why the record is void"),
    }, requestIdOf(args)),
  },
  {
    name: "rename_household",
    title: "Rename the household",
    writes: "manageHousehold",
    destructive: true,
    description:
      "Gives the household a new name for everyone in it. Only the household's owner can. "
      + `Needs the "Manage the household" switch. ${NEVER}`,
    inputSchema: schema({ household, request_id: requestId, name: str("The new name, up to 128 characters.") }, ["household", "request_id", "name"]),
    run: (io, args) => io.write({
      tool: "rename_household",
      potId: text(args, "household"),
      name: requiredText(args, "name", "the new name"),
    }, requestIdOf(args)),
  },
  {
    name: "add_person",
    title: "Add a person",
    writes: "manageHousehold",
    description:
      "Adds someone who hasn't joined yet, so expenses can include them before they have the app. Only the owner can. "
      + "Use create_invite to give them a code to join. "
      + `Needs the "Manage the household" switch. ${NEVER}`,
    inputSchema: schema({ household, request_id: requestId, name: str("Their name, up to 128 characters.") }, ["household", "request_id", "name"]),
    run: (io, args) => io.write({
      tool: "add_person",
      potId: text(args, "household"),
      name: requiredText(args, "name", "the person's name"),
    }, requestIdOf(args)),
  },
  {
    name: "update_groups",
    title: "Set who pays as a group",
    writes: "manageHousehold",
    destructive: true,
    description:
      "Sets which people pay as one group (a couple, a family). List each group of two or more people; everyone else pays alone. "
      + "Allowed only before the household records any money, and only by the owner. "
      + `Needs the "Manage the household" switch. ${NEVER}`,
    inputSchema: schema({
      household, request_id: requestId,
      groups: { type: "array", description: "Each group is a list of member_ids. [] puts everyone on their own.", items: { type: "array", items: { type: "string" } } },
    }, ["household", "request_id", "groups"]),
    run: (io, args) => {
      if (!Array.isArray(args.groups) || args.groups.length > 64) throw new AgentInputError("groups must be a list of member_id lists");
      return io.write({
        tool: "update_groups",
        potId: text(args, "household"),
        groups: args.groups.map((group, index) => idList(group, `groups[${index}]`)),
      }, requestIdOf(args));
    },
  },
  {
    name: "create_invite",
    title: "Create an invite code",
    writes: "manageHousehold",
    description:
      "Makes a six-character code and a link that let one person who hasn't joined claim their place in the household. "
      + "It lasts 29 days. Only the owner can. Give the code only to that person. "
      + "If they already have a live code, the call is refused unless replace_existing is true, which stops the old code working. "
      + `Needs the "Manage the household" switch. ${NEVER}`,
    inputSchema: schema({
      household, request_id: requestId,
      member_id: str("member_id of a person who hasn't joined yet (list_members state pending)."),
      replace_existing: { type: "boolean", description: "Replace a live code this person already has. Default false." },
    }, ["household", "request_id", "member_id"]),
    run: (io, args) => {
      if (args.replace_existing !== undefined && typeof args.replace_existing !== "boolean") {
        throw new AgentInputError("replace_existing must be true or false");
      }
      return io.write({
        tool: "create_invite",
        potId: text(args, "household"),
        memberId: requiredText(args, "member_id", "the person's member_id"),
        replaceExisting: args.replace_existing === true,
      }, requestIdOf(args));
    },
  },
];

/** Runs a tool after refusing arguments it doesn't define. */
export function runTool(io: AgentIo, tool: AgentTool, args: Json): Promise<unknown> {
  onlyKnown(args, tool);
  return tool.run(io, args);
}
