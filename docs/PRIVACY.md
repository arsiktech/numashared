# Device privacy

`Hide amounts` is a device-local preference stored in the app's standard user
defaults under `privacy.hideAmounts`. It is never written to the ledger or sync
transport. Every rendered financial value flows through the app formatter and
uses the fixed currency placeholder when the preference is enabled.

The root surface and every app-owned sheet or full-screen cover install the
same scene-phase shield. When the scene is inactive or backgrounded, the shield
replaces financial content with a neutral Numa Shared surface before iOS takes
the app-switcher snapshot. It does not add Face ID or another authentication
boundary; those remain outside v1 scope.

Account deletion is separate from this device-only display preference. Its
server and local erasure boundaries, retained shared arithmetic, attribution
anonymization, and retry behavior are specified in `ACCOUNT-DELETION.md`.
