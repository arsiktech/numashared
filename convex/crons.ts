// Scheduled jobs.
import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// An agent's request rows hold what a write recorded (amounts, names). The privacy policy promises
// they are gone within 24 hours: they expire after 23 (agentWrites.requestKeepMillis), and this
// deletes them within the next hour.
crons.hourly("purge expired agent requests", { minuteUTC: 17 }, internal.agentWrites.purgeExpiredRequests, {});

export default crons;
