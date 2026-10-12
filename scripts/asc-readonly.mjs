#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import { buildUploadState, combinedBuildFloor } from "./asc-build-floor.mjs";

const required = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`ASC read-only preflight missing env names: ${missing.join(", ")}`);
  process.exit(66);
}

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1_000);
const header = encode({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" });
const payload = encode({
  iss: process.env.ASC_ISSUER_ID,
  iat: now,
  exp: now + 600,
  aud: "appstoreconnect-v1",
});
const key = createPrivateKey(await readFile(process.env.ASC_KEY_PATH));
const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
  key,
  dsaEncoding: "ieee-p1363",
}).toString("base64url");
const authorization = `Bearer ${header}.${payload}.${signature}`;

async function request(path) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: authorization },
  });
  if (!response.ok) {
    console.error(`ASC read-only preflight failed: HTTP ${response.status}`);
    process.exit(69);
  }
  return response.json();
}

const bundleID = "tech.arsik.numashared";
const apps = await request(`/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(bundleID)}&limit=2`);
if (apps.data.length === 0) {
  console.log(`ASC_APP missing bundle=${bundleID}`);
  process.exit(2);
}
if (apps.data.length !== 1) {
  console.error(`ASC_APP ambiguous bundle=${bundleID} count=${apps.data.length}`);
  process.exit(70);
}

const app = apps.data[0];
console.log(
  `ASC_APP present bundle=${bundleID} appleId=${app.id} name=${JSON.stringify(app.attributes.name)}`,
);
const bundleIDs = await request(
  `/v1/bundleIds?filter%5Bidentifier%5D=${encodeURIComponent(bundleID)}&include=bundleIdCapabilities&limit=2`,
);
if (bundleIDs.data.length !== 1) {
  console.error(`ASC_BUNDLE_ID unavailable bundle=${bundleID} count=${bundleIDs.data.length}`);
  process.exit(71);
}
const capabilities = (bundleIDs.included ?? [])
  .filter((item) => item.type === "bundleIdCapabilities")
  .map((item) => item.attributes.capabilityType)
  .sort();
console.log(`ASC_CAPABILITIES ${capabilities.join(",") || "none"}`);
const builds = await request(
  `/v1/builds?filter%5Bapp%5D=${encodeURIComponent(app.id)}&sort=-uploadedDate&limit=200&include=preReleaseVersion`,
);
const included = new Map((builds.included ?? []).map((item) => [item.id, item]));
for (const build of builds.data) {
  const versionID = build.relationships?.preReleaseVersion?.data?.id;
  const marketingVersion = included.get(versionID)?.attributes?.version ?? "unknown";
  console.log(
    `ASC_BUILD version=${marketingVersion} build=${build.attributes.version} state=${build.attributes.processingState}`,
  );
}
const buildUploads = await request(
  `/v1/apps/${encodeURIComponent(app.id)}/buildUploads?filter%5Bplatform%5D=IOS&sort=-uploadedDate&limit=200`,
);
const maximumBuild = combinedBuildFloor(builds.data, buildUploads.data);
for (const upload of buildUploads.data) {
  const attributes = upload.attributes ?? {};
  const stateDetails = attributes.state;
  const state = buildUploadState(upload);
  const errors = Array.isArray(stateDetails?.errors) ? stateDetails.errors : [];
  const warnings = Array.isArray(stateDetails?.warnings) ? stateDetails.warnings : [];
  console.log(
    `ASC_BUILD_UPLOAD version=${attributes.cfBundleShortVersionString ?? "unknown"} build=${attributes.cfBundleVersion ?? "unknown"} state=${state} created=${attributes.createdDate ?? "unknown"} uploaded=${attributes.uploadedDate ?? "unknown"} errors=${errors.length} warnings=${warnings.length}`,
  );
  for (const error of errors) {
    console.log(
      `ASC_BUILD_UPLOAD_ERROR code=${JSON.stringify(error.code ?? "unknown")} detail=${JSON.stringify(error.detail ?? error.title ?? "unknown")}`,
    );
  }
}

const betaGroups = await request(
  `/v1/apps/${encodeURIComponent(app.id)}/betaGroups?limit=200`,
);
if (betaGroups.data.length === 0) console.log("ASC_BETA_GROUP none");
for (const group of betaGroups.data) {
  const testers = await request(
    `/v1/betaGroups/${encodeURIComponent(group.id)}/betaTesters?fields%5BbetaTesters%5D=inviteType,state&limit=200`,
  );
  const testerStates = new Map();
  for (const tester of testers.data) {
    const state = tester.attributes?.state ?? "UNKNOWN";
    testerStates.set(state, (testerStates.get(state) ?? 0) + 1);
  }
  const stateReceipt = [...testerStates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}:${count}`)
    .join(",");
  const attributes = group.attributes ?? {};
  console.log(
    `ASC_BETA_GROUP name=${JSON.stringify(attributes.name ?? "unknown")} internal=${attributes.isInternalGroup ?? "unknown"} publicLinkEnabled=${attributes.publicLinkEnabled ?? "unknown"} testers=${testers.data.length} testerStates=${stateReceipt || "none"}`,
  );
}
const appStoreVersions = await request(
  `/v1/apps/${encodeURIComponent(app.id)}/appStoreVersions?filter%5Bplatform%5D=IOS&limit=10`,
);
if (appStoreVersions.data.length === 0) console.log("ASC_APP_STORE_VERSION none");
for (const version of appStoreVersions.data) {
  const attributes = version.attributes ?? {};
  console.log(
    `ASC_APP_STORE_VERSION version=${attributes.versionString ?? "unknown"} state=${attributes.appStoreState ?? "unknown"} releaseType=${attributes.releaseType ?? "unknown"} created=${attributes.createdDate ?? "unknown"}`,
  );
  const details = await request(
    `/v1/appStoreVersions/${encodeURIComponent(version.id)}?include=appStoreVersionLocalizations,appStoreReviewDetail,build&limit%5BappStoreVersionLocalizations%5D=50`,
  );
  const included = details.included ?? [];
  const localizations = included.filter((item) => item.type === "appStoreVersionLocalizations");
  if (localizations.length === 0) console.log("ASC_VERSION_LOCALIZATION none");
  for (const localization of localizations) {
    const localized = localization.attributes ?? {};
    console.log(
      `ASC_VERSION_LOCALIZATION locale=${localized.locale ?? "unknown"} description=${localized.description?.length ?? 0} keywords=${localized.keywords?.length ?? 0} supportUrl=${Boolean(localized.supportUrl)} marketingUrl=${Boolean(localized.marketingUrl)} promotionalText=${localized.promotionalText?.length ?? 0} whatsNew=${localized.whatsNew?.length ?? 0}`,
    );
    const screenshotSets = await request(
      `/v1/appStoreVersionLocalizations/${encodeURIComponent(localization.id)}/appScreenshotSets?limit=200`,
    );
    if (screenshotSets.data.length === 0) console.log("ASC_SCREENSHOT_SET none");
    for (const screenshotSet of screenshotSets.data) {
      const screenshots = await request(
        `/v1/appScreenshotSets/${encodeURIComponent(screenshotSet.id)}/appScreenshots?limit=50`,
      );
      const deliveryStates = new Map();
      for (const screenshot of screenshots.data) {
        const delivery = screenshot.attributes?.assetDeliveryState;
        const state = typeof delivery === "string" ? delivery : delivery?.state ?? "UNKNOWN";
        deliveryStates.set(state, (deliveryStates.get(state) ?? 0) + 1);
      }
      const deliveryReceipt = [...deliveryStates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([state, count]) => `${state}:${count}`)
        .join(",");
      console.log(
        `ASC_SCREENSHOT_SET display=${screenshotSet.attributes?.screenshotDisplayType ?? "unknown"} count=${screenshots.data.length} states=${deliveryReceipt || "none"}`,
      );
    }
  }
  const reviewDetail = included.find((item) => item.type === "appStoreReviewDetails");
  if (reviewDetail) {
    const review = reviewDetail.attributes ?? {};
    const contactComplete = [
      review.contactFirstName,
      review.contactLastName,
      review.contactPhone,
      review.contactEmail,
    ].every(Boolean);
    const demoComplete = !review.demoAccountRequired || (
      Boolean(review.demoAccountName) && Boolean(review.demoAccountPassword)
    );
    console.log(
      `ASC_REVIEW_DETAIL present contactComplete=${contactComplete} demoRequired=${Boolean(review.demoAccountRequired)} demoComplete=${demoComplete} notes=${review.notes?.length ?? 0}`,
    );
  } else {
    console.log("ASC_REVIEW_DETAIL missing");
  }
  const attachedBuild = included.find((item) => item.type === "builds");
  console.log(
    attachedBuild
      ? `ASC_APP_STORE_BUILD attached=${attachedBuild.attributes?.version ?? "unknown"}`
      : "ASC_APP_STORE_BUILD none",
  );
}

const appInfos = await request(
  `/v1/apps/${encodeURIComponent(app.id)}/appInfos?include=appInfoLocalizations,ageRatingDeclaration,primaryCategory&limit=10&limit%5BappInfoLocalizations%5D=50`,
);
if (appInfos.data.length === 0) console.log("ASC_APP_INFO none");
for (const info of appInfos.data) {
  const attributes = info.attributes ?? {};
  const relatedIDs = new Set(
    Object.values(info.relationships ?? {})
      .flatMap((relationship) => {
        const data = relationship?.data;
        return Array.isArray(data) ? data : data ? [data] : [];
      })
      .map((item) => item.id),
  );
  const included = (appInfos.included ?? []).filter((item) => relatedIDs.has(item.id));
  const localizations = included.filter((item) => item.type === "appInfoLocalizations");
  const ageRating = included.find((item) => item.type === "ageRatingDeclarations");
  const primaryCategory = included.find((item) => item.type === "appCategories");
  console.log(
    `ASC_APP_INFO state=${attributes.appStoreState ?? attributes.state ?? "unknown"} ageRating=${attributes.appStoreAgeRating ?? "unknown"} ageDeclaration=${Boolean(ageRating)} primaryCategory=${primaryCategory?.id ?? "none"}`,
  );
  if (localizations.length === 0) console.log("ASC_APP_INFO_LOCALIZATION none");
  for (const localization of localizations) {
    const localized = localization.attributes ?? {};
    console.log(
      `ASC_APP_INFO_LOCALIZATION locale=${localized.locale ?? "unknown"} name=${localized.name?.length ?? 0} subtitle=${localized.subtitle?.length ?? 0} privacyPolicyUrl=${Boolean(localized.privacyPolicyUrl)} privacyChoicesUrl=${Boolean(localized.privacyChoicesUrl)}`,
    );
  }
}

const reviewSubmissions = await request(
  `/v1/apps/${encodeURIComponent(app.id)}/reviewSubmissions?filter%5Bplatform%5D=IOS&limit=200`,
);
if (reviewSubmissions.data.length === 0) console.log("ASC_REVIEW_SUBMISSION none");
for (const submission of reviewSubmissions.data) {
  const attributes = submission.attributes ?? {};
  console.log(
    `ASC_REVIEW_SUBMISSION state=${attributes.state ?? "unknown"} submitted=${attributes.submittedDate ?? "none"}`,
  );
}
console.log(`ASC_BUILD_FLOOR ${maximumBuild}`);
