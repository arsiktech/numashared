// The tools a connected agent can use, as MCP tool definitions. Every tool only reads. Each calls
// one internal query that runs as the connection's account, so the checks the app follows on
// membership apply to agents unchanged. `AgentIo` is supplied by the HTTP endpoint or by a test.

type Json = Record<string, unknown>;
type Schema = { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties: false };

export type AgentReader = "households" | "members" | "balances" | "records";

export type AgentIo = {
  read: (reader: AgentReader, args: Json) => Promise<unknown>;
};

export type AgentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  run: (io: AgentIo, args: Json) => Promise<unknown>;
};

/** A mistake in what the agent sent: reported back to it as a tool error, never as a server failure. */
export class AgentInputError extends Error {}

export const AGENT_INSTRUCTIONS =
  "Numa Shared records who paid, who benefited and who owes whom in a household. "
  + "This connection can only read. It cannot add, change or delete anything, and Numa Shared never moves money. "
  + "Start with list_households to get household ids. Amounts come as minorUnits (cents) and as a decimal string in the household currency. "
  + "In balances, a positive amount means that person is owed money and a negative amount means they owe money.";

const str = (description: string, extra: Json = {}): Json => ({ type: "string", description, ...extra });
const schema = (properties: Record<string, Json>, required: string[] = []): Schema =>
  ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

const household = str("Household id from list_households.");

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
];
