# Android release

Android uses Expo Continuous Native Generation. `app/android/` is ignored and must
be regenerated from `app.json`, `app.config.ts` and config plugins. Do not commit
the generated tree, signing files, Firebase credentials or local SDK paths.
The committed iOS project remains unchanged and `npm run native:check` still
checks it for drift.

## Local signed bundle

Use Node 22, JDK 17, Android command-line tools, platform-tools, the Android 36
platform, Build Tools 36.0.0 and the NDK selected by React Native. The locked
native dependencies also request NDK 27.0.12077973 and CMake 3.22.1; React Native
selects NDK 27.1.12297006. Let the SDK manager install both side by side.
Expo SDK 57
uses compile SDK 36 and target SDK 36. Google Play requires target API 36 for
new phone apps and updates from 31 August 2026.

From `app/`, install locked dependencies with `npm ci`. Provide these environment
variables privately, then run `npm run android:bundle`:

- `JAVA_HOME`, `ANDROID_HOME`
- `NUMA_ANDROID_KEYSTORE`, `NUMA_ANDROID_KEY_ALIAS` with alias `upload`
- `NUMA_ANDROID_STORE_PASSWORD`, `NUMA_ANDROID_KEY_PASSWORD`
- `NUMA_ANDROID_AAB_OUTPUT`
- `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_SITE_URL`, `EXPO_PUBLIC_SITE_URL`
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` for Google sign-in

The script disables dotenv loading, regenerates Android and builds `bundleRelease`.
The signing plugin replaces Expo's debug-signed release default and fails a
release packaging task when signing credentials are missing. Never pass secrets
as command-line Gradle properties, print the environment, or store passwords in
Gradle files. Retain a protected offline backup of the upload key and its password.
Google Play's app-signing key and this upload key are different keys.

For isolated QA, set all three URLs to explicit loopback HTTP endpoints and
`NUMA_DISABLE_UPDATES=1`. The latter disables OTA loading so a production update
cannot replace the isolated bundle. A loopback build is a local-only QA artifact,
not a cloud-enabled store build. Rebuild with the approved public HTTPS URLs and
OAuth configuration before distribution. Never seed or test against production.

## Google sign-in

No Firebase project is needed for Google sign-in itself. In Google Cloud project
`numa-shared-app`, use Google Auth Platform > Clients to create Android OAuth
clients for package `tech.arsik.numashared`:

1. One Android client for the upload certificate's SHA-1, for direct signed installs.
2. A separate Android client for the Play app-signing certificate's SHA-1, copied
   from Play Console > Test and release > Setup > App signing, for Play installs.
3. If testing debug builds, add a third client for that machine's debug certificate.
   Never substitute the debug certificate for either release certificate.

Use this **Web application** client as `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, which
GoogleSignin passes as `webClientId` / server client ID:

```text
557524817870-l7l310rff8edmlqrcmve5l3md8u4uv0r.apps.googleusercontent.com
```

Do not paste an Android client ID into that value. Do not embed a client secret.
The backend must accept this Web client's token audience. Review the existing
Google Auth Platform branding, verified domains, data access and audience before
publishing the consent screen. Testing mode limits access to listed test users.
Do not add tester identities to source control. Verify real Google sign-in on a
Play-installed build after its app-signing fingerprint has been registered.

Apple authentication is intentionally hidden on Android. The native Apple module
is iOS-only; the current Apple Services ID popup flow uses browser DOM APIs and
runs only on web. It is not an Android browser-redirect flow. Google plus local-only
mode is the minimal supported Android entry; no Apple console change is needed.

Reviewers can choose Start a household > Start without an account and use the
ledger, balances, recorded repayments, history and CSV export without an account.
The app records money owed and repayments made elsewhere. It never moves money.

## Android push is not enabled

Android notification registration is currently unsupported. Settings says so and
has no Android notification toggle. No notification permission request or FCM token
request should occur on Android, including Android 13 and later. iOS APNs behavior
is unchanged. Merely adding `google-services.json` does not enable delivery:
`convex/notifications.ts` accepts APNs hex tokens and the sender uses APNs.

To enable Android push in a separately authorized change:

1. In Firebase, add Firebase to the existing Google Cloud project
   `numa-shared-app`, rather than creating an unrelated project.
2. Register Android package `tech.arsik.numashared`, add the upload and Play
   app-signing SHA-1/SHA-256 certificates, then download `google-services.json`.
3. Keep the JSON outside the public repo. Set `NUMA_ANDROID_GOOGLE_SERVICES_FILE`
   to its protected absolute path before prebuild. Rebuild the native app.
4. Enable the Firebase Cloud Messaging API, configure a least-privilege server
   identity for FCM HTTP v1, and store its credential only in approved server-side
   secret storage. Never bundle a service-account private key. If using Expo Push
   Service instead, upload its FCM v1 credential privately to EAS and implement
   Expo push-token registration and sending, not the APNs-only endpoint.
5. Add typed platform/token registration, token rotation, session-bound logout and
   account-deletion cleanup, FCM delivery and invalid-token removal on an isolated
   backend first. Preserve all existing APNs behavior and notification recipients.
6. Only then enable the Android notification control. Create a notification channel
   before requesting Android 13+ permission. Request permission contextually, handle
   denial without claiming notifications are on, and register only after approval.
7. Verify foreground/background delivery, notification taps, denial, token refresh,
   sign-out and account deletion on a Play-installed physical Android device before
   any separately approved backend deployment or rollout.

## Play Console checklist

No store-console operation is part of the local build command.

1. Create the Numa Shared app, select the correct default language and app category,
   and complete developer verification and any required organization verification.
   The first uploaded artifact fixes package `tech.arsik.numashared` permanently.
2. Enroll in Play App Signing using Google's generated app-signing key. Upload the
   signed AAB with the upload key. Do not provide the upload keystore as Google's
   app-signing key. Record the Play app-signing fingerprints privately and complete
   the matching Android OAuth client above before authentication testing.
3. Start with internal testing. Upload the approved production-configured AAB,
   versionName `2.0.0`, versionCode `20`, or a higher unused code if 20 was already
   uploaded. Add release notes that do not imply payments are sent.
4. Complete the store listing, icon, feature graphic, phone/tablet screenshots,
   support contact and privacy policy. Use the actual current legal URLs and
   verify they are publicly reachable. Do not use isolated QA URLs or private notes.
5. Complete App content, including ads declaration, target audience, content rating,
   data safety and any applicable financial-features declaration. Describe shared
   expense/debt records accurately; do not declare money transfer functionality.
   Reconcile the locked SDKs and actual server collection before submitting Data
   safety. Account creation also needs a publicly reachable account-deletion request
   URL in addition to the in-app deletion control. Verify it, do not invent a URL.
6. In App access, explain the no-account review path above and any remaining
   account-only features. Do not claim every feature is available without sign-in.
   Provide a safe review route for shared-account features if Google requires it.
7. Inspect App bundle explorer and pre-launch reports for signing, target API,
   permissions, supported devices, crashes, accessibility and 16 KB page-size
   compatibility. Test the actual Play-delivered build and Google sign-in.
8. Complete any account-specific closed-testing requirement before requesting
   production access. Review Play's current Console gates, pricing/countries and
   release settings. Submit only after explicit owner approval; no automatic
   production rollout is authorized by a local build.

References: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/),
[Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk),
[Google Sign-In Expo setup](https://react-native-google-signin.github.io/docs/setting-up/expo),
[FCM credentials](https://docs.expo.dev/push-notifications/fcm-credentials/).
