import { describe, expect, test } from "vitest";

import { allowedWebOrigin } from "./lib/cors";

describe("web app origins", () => {
  test("production accepts only listed https origins", () => {
    const env = { NUMA_SHARED_DEPLOYMENT_CLASS: "cloud", NUMA_SHARED_WEB_ORIGINS: "https://shared.numaworth.com" };
    expect(allowedWebOrigin(env, "https://shared.numaworth.com")).toBe("https://shared.numaworth.com");
    expect(allowedWebOrigin(env, "http://localhost:8081")).toBeNull();
    expect(allowedWebOrigin(env, "https://evil.example")).toBeNull();
  });

  test("the anonymous local deployment also accepts a web app on this computer", () => {
    const env = { NUMA_SHARED_DEPLOYMENT_CLASS: "anonymous-local" };
    expect(allowedWebOrigin(env, "http://localhost:8081")).toBe("http://localhost:8081");
    expect(allowedWebOrigin(env, "http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
    expect(allowedWebOrigin(env, "http://192.168.1.4:8081")).toBeNull();
    expect(allowedWebOrigin(env, "https://evil.example")).toBeNull();
  });
});
