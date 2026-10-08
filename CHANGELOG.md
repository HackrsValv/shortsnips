# Changelog

## [Unreleased] - 2026-10-08

### Added
- Live token-validation deploy gate: deploys now verify every service secret against its issuer first (Cloudflare incl. account membership, Notion incl. data-source reachability, Buttondown, Spiral, optional LLM key). A bad or revoked token aborts the deploy naming the service and HTTP status; optional secrets are skipped, never blocking.
- Fail-closed verdict vocabulary (ok/invalid/error/missing/skipped), per-check 10-second timeouts, and service+status-only logging (no token material in output).

### Fixed
- CLI entry guard uses the platform-correct pathToFileURL identity check, so Windows-style paths can no longer bypass the gate.
- The deploy workflow extracts NOTION_DATA_SOURCE_ID with a plain assignment, so an unparseable wrangler.jsonc aborts with the real error instead of a misleading "not set" verdict.
- README test-count drift corrected (17 -> 20 after the review-pass test additions).
