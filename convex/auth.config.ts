import type { AuthConfig } from "convex/server";

import { authConfigFromEnvironment } from "./lib/authConfig";

declare const process: { env: Record<string, string | undefined> };

const config = authConfigFromEnvironment(process.env) satisfies AuthConfig;

export default config;
