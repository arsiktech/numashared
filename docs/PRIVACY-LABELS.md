# App Store privacy labels

Status: DRAFT — technical candidate audited for L02 on 2026-09-20 at base
968c132. G2 owner/legal approval and exact production verification remain
required before publication. No App Store Connect declaration was changed.
Source paths, limits and open findings are tracked in private release notes.

## Data linked to the user

| Apple category | Data type | Purpose | Product evidence |
| --- | --- | --- | --- |
| Contact info | Email address | App functionality, account recovery | Verified Sign in with Apple relay email, when Apple supplies it |
| Contact info | Name | App functionality | Per-pot display names |
| Financial info | Other financial info | App functionality | User-entered expenses, allocations, balances, and settlements; Numa Shared never moves money |
| Purchases | Purchase history | App functionality | User-entered purchase/expense records; not limited to in-app purchases |
| User content | Other user content | App functionality | Pot names, expense titles/categories/notes, void reasons |
| User content | Customer support | App functionality | User-sent support email and any attachments the sender chooses |
| Identifiers | User ID | App functionality, security | Pseudonymous account/session/member identifiers and hashed Apple subject |
| Identifiers | Device ID | App functionality | APNs device token used only for notifications |
| Diagnostics | Other diagnostic data | App functionality | Support mail template includes app version/build, OS version and a newly generated diagnostic UUID |
| Diagnostics (provisional) | Performance data | App functionality if confirmed | Convex documents function duration/resource timing; actual project collection/linkage needs coordinator inspection, not an invented app analytics pipeline |

Tracking: **No**. Advertising: **No**. Third-party advertising, marketing,
data brokerage, and cross-app tracking: **None**.

## Not declared as app collection

- Payment information: the app does not collect cards, bank accounts, or move money.
- No dedicated collection for location, address book, photos, health, browsing,
  search history, advertising data or product-interaction analytics was found.
  Arbitrary free text/support attachments can still contain sensitive data;
  do not describe that as an inability to receive it.
- No app crash-upload pipeline or diagnostics consent toggle was found.
  Apple/TestFlight reports are a separate platform route whose actual enabled
  sharing/access must be checked by the coordinator; no Crash Data declaration
  is invented from UI copy. Default-off collection is still collection when
  enabled. Lack of a payments feature or analytics SDK proves neither absence
  of financial data nor absence of diagnostics.
- The support route is optional and requires the user's mail-send action; the
  draft conservatively includes it rather than assuming Apple's optional
  disclosure exception (whose conditions must all be met).
- All listed types are treated as linked: account-associated ledger/server
  records and support email are not rendered anonymous by pseudonymous IDs.
  There is no verified de-identification basis for claiming unlinked logs.

## Retention and deletion

The deletion implementation removes account/authentication records and push
tokens, redacts expense text sidecars and member names, archives shared
membership, and deletes a sole-active-member pot. Retained member/event IDs,
amounts, timestamps and pot names can still identify people in context.
`potRenamed.payload.name` and `pots.name` are not erased by the expense-text
redaction path. Do not promise that all authored text or all identifiers vanish.
For a stored, unrevoked Apple authorization, token revocation is awaited before
redaction/completion. Provider failure returns an error and leaves deletion
pending; the client does not erase local data on that failed server call.
Persisted progress and the same request ID support resumption; a completed
receipt covers repeat requests. No automatic provider retry or completion
deadline is established. Coordinator-owned provider-failure/recovery execution
is still required, not an authorized L02 authentication rewrite.
A receipt expires after 30 days; later deletion requests physically delete a
bounded expired batch. This is request-triggered cleanup, not a scheduled purge
deadline. Resolve open findings R1, R2 and R4 in the private release notes before publication.

## Human confirmation required

Confirm controller/contact, lawful bases, retention and backup deletion,
processor contracts/region/transfer mechanism, actual log access/sinks/plan,
Apple report handling, and the final corrected deletion behavior. These are
not all owner-only questions: coordinator read-only production/account
inspection can resolve operational facts without asking the owner to guess.

Official taxonomy: https://developer.apple.com/app-store/app-privacy-details/
(retrieved 2026-09-20). Other Financial Info expressly includes debts; Purchase
History includes an individual's purchases or purchasing tendencies. Customer
Support and Other Diagnostic Data are distinct from Product Interaction.

The local app `PrivacyInfo.xcprivacy` declares the nine source-backed types with
App Functionality, linked=true, tracking=false. The provisional Performance Data
row is not included pending actual production-log evidence; reconcile the final
label and manifest after that inspection. It also declares required-reason
UserDefaults CA92.1 plus SystemBootTime 35F9.1. It is not an ASC submission or
an archive privacy validation. L16 must inspect the exact archived bundle and
dependencies again after source reconciliation.
