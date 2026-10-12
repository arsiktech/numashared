import { fail } from "./access";

declare const process: { env: Record<string, string | undefined> };

const productMarker = "numa-shared";
const productionDeploymentName = "adept-camel-457";
const productionCloudURL = "https://adept-camel-457.convex.cloud";
const productionSiteURL = "https://adept-camel-457.convex.site";

/**
 * Writes are admitted only on the asserted anonymous-local harness or the
 * operator-approved dedicated production deployment. An absent, partial, or
 * merely Convex-valid target never authorizes a Numa Shared mutation.
 */
export function requireApprovedWriteTarget(): void {
  if (process.env.NUMA_SHARED_PRODUCT !== productMarker) {
    fail("DEPLOYMENT_NOT_APPROVED");
  }
  if (isApprovedAnonymousLocalTarget()) {
    console.info(
      "NUMA_SHARED_WRITE_TARGET_APPROVED product=numa-shared class=anonymous-local",
    );
    return;
  }
  if (isApprovedProductionTarget()) {
    console.info(
      "NUMA_SHARED_WRITE_TARGET_APPROVED product=numa-shared class=cloud deployment=adept-camel-457",
    );
    return;
  }
  fail("DEPLOYMENT_NOT_APPROVED");
}

function isApprovedAnonymousLocalTarget(): boolean {
  return process.env.NUMA_SHARED_DEPLOYMENT_CLASS === "anonymous-local"
    && Boolean(process.env.NUMA_SHARED_DEPLOYMENT_NAME?.startsWith("anonymous-"))
    && isLoopbackURL(process.env.CONVEX_CLOUD_URL)
    && isLoopbackURL(process.env.CONVEX_SITE_URL);
}

function isApprovedProductionTarget(): boolean {
  return process.env.NUMA_SHARED_DEPLOYMENT_CLASS === "cloud"
    && process.env.NUMA_SHARED_DEPLOYMENT_NAME === productionDeploymentName
    && process.env.CONVEX_CLOUD_URL === productionCloudURL
    && process.env.CONVEX_SITE_URL === productionSiteURL;
}

function isLoopbackURL(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

export function requireLocalE2EAuthTarget(): void {
  requireApprovedWriteTarget();
  if (
    process.env.NUMA_SHARED_E2E_AUTH_ENABLED !== "1"
    || !isLoopbackURL(process.env.CONVEX_CLOUD_URL)
    || !isLoopbackURL(process.env.CONVEX_SITE_URL)
  ) {
    fail("E2E_AUTH_NOT_AVAILABLE");
  }
}
