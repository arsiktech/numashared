# App Store and TestFlight metadata — English (U.S.)

Status: local copy and screenshots are prepared. The 2026-07-26 ASC inventory
recorded an incomplete draft; refresh that state when draft work resumes. Use
`docs/RELEASE.md` for the authorized operation. Candidate evidence is kept
outside this public repository.
App record: `tech.arsik.numashared`, Apple ID `6790012321`.

## Product page

- Name: **Numa Shared**
- Subtitle: **Shared expenses, made clear**
- Primary category: **Finance**
- Secondary category: **Lifestyle**
- Age rating answers: no objectionable content; no gambling, contests, medical,
  unrestricted web access, or user-generated public feed.
- Copyright: pending exact publishing entity/year confirmation.
- Privacy policy URL: `https://adept-camel-457.convex.site/privacy`; apply only
  after the exact origin passes release preflight.
- Support URL: `https://adept-camel-457.convex.site/support`; apply only after
  the exact origin passes release preflight.

Description, keywords, promotional text, and TestFlight copy live under
`app-store/en-US/` so they can be applied without rewriting prose in ASC.

## Review notes

Numa Shared is a shared-expense ledger. It records who paid, who benefited, and
who owes whom; it does not transfer money. Sign in with Apple is required only
when a person enables sync or joins an invite. Reviewers can exercise the local
onboarding and ledger without an account; production multi-user review access
requires the dedicated synthetic review identity documented in the candidate
operations receipt. Account deletion is in Settings and explains which shared
arithmetic remains redacted for other household members.

Provide the reviewer with the approved synthetic account/invite method only in
App Review's private credentials field. Never put credentials in this repo.

## Screenshot set

The English iPhone 6.9-inch set contains five opaque 1320 × 2868 captures: home
balance, add expense, exact split preview, settle plan, and Activity history.
The current files came from the normal-entry
`testCaptureReleaseAppStoreJourney` journey under the shared
`NumaSharedReleaseScreenshots` scheme's Release configuration on an iPhone 17
Pro Max simulator. The passing result bundle was
`test_sim_2026-08-23T20-45-01-239Z_pid95405_6f3d25ea.xcresult`; all five images
were visually inspected, converted to opaque 1320 × 2868 JPEGs, and frozen by
`app-store/screenshots/en-US/6.9-inch/SHA256SUMS`. The release preflight verifies
that manifest before any ASC write.
