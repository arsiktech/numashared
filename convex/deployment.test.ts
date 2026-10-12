import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";

import { requireApprovedWriteTarget } from "./lib/deployment";

function stubProductionTarget(): void {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "cloud");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "adept-camel-457");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://adept-camel-457.convex.cloud");
  vi.stubEnv("CONVEX_SITE_URL", "https://adept-camel-457.convex.site");
}

function expectDeploymentRejected(): void {
  try {
    requireApprovedWriteTarget();
    throw new Error("Expected deployment target to be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data.code).toBe(
      "DEPLOYMENT_NOT_APPROVED",
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("approved write deployment", () => {
  test("accepts only the dedicated Numa Shared production deployment", () => {
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);
    stubProductionTarget();
    expect(() => requireApprovedWriteTarget()).not.toThrow();
    expect(audit).toHaveBeenCalledExactlyOnceWith(
      "NUMA_SHARED_WRITE_TARGET_APPROVED product=numa-shared class=cloud deployment=adept-camel-457",
    );
  });

  test.each([
    ["NUMA_SHARED_PRODUCT", "another-product"],
    ["NUMA_SHARED_DEPLOYMENT_CLASS", "production"],
    ["NUMA_SHARED_DEPLOYMENT_NAME", "another-deployment"],
    ["CONVEX_CLOUD_URL", "https://another-deployment.convex.cloud"],
    ["CONVEX_CLOUD_URL", "http://adept-camel-457.convex.cloud"],
    ["CONVEX_SITE_URL", "https://another-deployment.convex.site"],
    ["CONVEX_SITE_URL", "https://adept-camel-457.convex.site/path"],
  ])("rejects production when %s is not exact", (name, value) => {
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);
    stubProductionTarget();
    vi.stubEnv(name, value);
    expectDeploymentRejected();
    expect(audit).not.toHaveBeenCalled();
  });

  test("continues to accept the asserted anonymous-local target", () => {
    const audit = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
    vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
    vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    expect(() => requireApprovedWriteTarget()).not.toThrow();
    expect(audit).toHaveBeenCalledExactlyOnceWith(
      "NUMA_SHARED_WRITE_TARGET_APPROVED product=numa-shared class=anonymous-local",
    );
  });
});
