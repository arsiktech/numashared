# CSV event-log export

Settings exports one UTF-8 CSV file with a byte-order mark and RFC 4180 quoting.
Every field is quoted, rows end with CRLF, and one data row represents one
locally stored event. Rows use the store's deterministic server-sequence then
local-ordinal order. A regenerated export replaces the prior file in the app's
protected temporary export directory.

Archived pots refresh authored-text deletions before export. If that refresh is
temporarily unavailable, the saved local history remains exportable with an
explicit freshness warning; authentication and invalid-response failures block
preparation. An export belongs to its request, pot, repository and account. A
switch, account exit, or newer applied snapshot prevents an in-flight file from
being published; newer snapshots also remove an already prepared share file.
Starting a refresh retires the previous share file immediately. If a later
redaction page fails, deletions already committed locally still reach the UI;
the failed refresh cannot leave an older, unredacted CSV available for sharing.

The human-readable `pot_name` column prefixes formula-like values with a tab
inside the quoted field. This prevents formula evaluation in the tested direct
LibreOffice import and follows the [OWASP spreadsheet-export guidance](https://community.owasp.org/attacks/CSV_Injection).
The tab remains part of that display field; names already beginning with control
characters and formula prefixes following whitespace are also protected.
Canonical JSON and numeric replay columns are unchanged. Re-saving CSV in a
spreadsheet can change its escaping; this is not a guarantee for every importer
or subsequent transformation.

## Schema version 1

| Column | Meaning |
| --- | --- |
| `format_version` | CSV schema version, currently `1`. |
| `pot_name` | Current redaction-capable local pot name. |
| `pot_configuration_json` | Canonical static reducer configuration, repeated so each row is self-describing. |
| `event_id` / `event_kind` / `event_schema_version` | Immutable event identity and vocabulary. |
| `server_sequence` / `local_ordinal` | Server order when known and durable local insertion order. |
| `applied_order` | Zero-based order in the current last-valid reducer projection; blank means the event is retained but not applied. |
| `delivery_state` / `event_origin` / `attempt_count` / `terminal_reason` | Local delivery and provenance state. |
| `occurred_at_utc` / `saved_at_utc` / `originating_time_zone` | Exact event and storage timing context. |
| `event_json` | Canonical hydrated `EventEnvelope`; JSON dates are milliseconds since Unix epoch. |

`event_json` hydrates sidecar-backed `title`, `category`, `note` and `reason`
fields at export time. A missing sidecar field is emitted as the fixed
`[redacted]` placeholder; the exporter
never reads a legacy raw-text cache or reconstructs deleted content. Unsupported
future payload sidecars follow the same purge boundary.

Structural pot/preset names in existing event payloads are not yet covered by
that sidecar-erasure contract. ARS-257's held structural-name migration must be
resolved and verified before claiming complete authored-text erasure in replay
or export.

To reconcile the export with the on-screen ledger, decode the repeated pot
configuration, sort rows with a nonblank `applied_order` by that integer, decode
their `event_json`, and run the same reducer. Integer minor units and ISO 4217
currency remain unchanged; the device-only Hide amounts preference does not
alter exported arithmetic.
