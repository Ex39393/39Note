# Changelog

## [1.0.0] - 2026-11-10

### Reader and study workflow

- Added explicit local English OCR for verified image-only PDF pages. OCR can run
  for one page or through a cancellable whole-document queue, and its session-only
  text supports Search, selection, Highlight, and Underline without changing the
  PDF, its fingerprint, or its document identity.
- Added paired cross-document Links with stable document-scoped identities,
  naming, search, two-way navigation, persistence, backup, and sync support.
- Added custom Highlight and Underline colours and bounded document-scoped
  Undo/Redo for annotations, Notes, Glossary entries, and Links.
- Added Markdown Notes download for the exact hydrated current PDF.
- Improved annotated PDF export with a bundled Unicode font for Chinese Notes and
  precise fail-closed reporting for unsupported characters.
- Preserved editable Print Composer drafts, templates, and independently verified
  rendered Print PDFs.

### Library and recovery

- Added Collections with create, view, edit, search, and unavailable-source
  recovery flows.
- Added explicit **Import as new paper**, which creates a unique paper instance
  while retaining the original PDF fingerprint for duplicate detection. Existing,
  restored, and downloaded paper identities remain unchanged.
- Expanded Library backup format 5 to cover Collections, Links, custom annotation
  colours, Office sources, productivity state, and rendered Print PDFs while
  retaining read compatibility with backup formats 1 through 4.
- Added a native Getting Started walkthrough and shared actionable recovery
  feedback.
- Added crash-safe restore fencing with Web Locks, durable journals, exact
  fingerprints, rollback/startup recovery, and an explicit publication hold.

### Optional Google Drive sync

- Added immutable presence-ancestry validation and redacted typed diagnostics for
  missing proof, conflicting ancestry, protocol cutover, and resolver failure.
- Added exact-paper **Forget inaccessible paper** quarantine. It excludes one
  verified broken cloud paper from ordinary local sync and can be reviewed or
  reversed without deleting, repairing, or marking any remote object as synced.
- Added bounded read-operation deadlines, retained redacted phase/request
  diagnostics, read-only retry checks, and deterministic single-flight operation
  ownership.
- Strengthened personal account/root binding and temporary-device OAuth provenance
  so ambiguous identity remains fail-closed.
- Restricted OAuth code exchange and refresh to an exact singleton `drive.file`
  grant, disabled incremental scope reuse, and bounded OAuth-state creation by both
  device and Cloudflare client-address buckets.
- Kept destructive recovery and targeted-purge paths behind exact identity,
  ownership, ancestry, and explicit-confirmation checks.

### Interface, accessibility, and performance

- Reader Tools now starts closed. Portrait/coarse-input actions use accessible
  drawers with scrims, focus containment, Escape restoration, safe-area handling,
  and larger touch targets.
- Kept the collapsed Reader Tools opener in the accessibility tree while its hidden
  contents remain inert, and prioritized unsaved-edit warnings ahead of export
  feedback until local persistence succeeds.
- Made Print Composer's load event and readiness fallback share one idempotent print
  action, with bounded cleanup if a browser omits `afterprint`.
- Improved Library hierarchy, long-title handling, Back to top, keyboard-modal
  confirmations, compact Drive diagnostics, and Bright, Bay, and Sea presentation.
- Kept Viewer/PDF.js, annotated export and Unicode font support, OCR, sync, AI, and
  Print Composer behind production lazy-loading boundaries and explicit bundle
  budgets.

### Privacy and integrity

- 39Note remains local-first. Optional Drive file traffic goes directly between
  the browser and Google Drive; the OAuth Worker does not receive paper content.
- AI credentials remain local and are excluded from backups and Drive payloads.
- Local AI custom headers and remember-key preferences now survive synced settings
  only for the exact same credential profile. Remote AI endpoints require HTTPS;
  plain HTTP is accepted only for strict loopback development addresses.
- Backup, Office import, cloud payload, and recovery validation reject malformed,
  ambiguous, mismatched, or forward-version data before applying it.
- Release workflows use least-privilege Pages permissions, require explicit
  master-branch deployment runs, and reject a production build whose Worker origin
  does not exactly match the reviewed 1.0.0 endpoint.

### Compatibility and known limitations

- 39Note 1.0.0 targets current Chromium-based desktop browsers. Chrome and Edge
  are automated release targets; Android, iOS, Safari, and WebKit are not currently
  claimed as supported. A 390 x 844 touch-emulation check is not phone or tablet
  real-device qualification.
- PDF is the first-class Reader format. DOCX and PPTX are converted locally to PDF
  on a best-effort basis and may not preserve pixel-perfect Office layout. Legacy
  `.doc` and `.ppt` files are unsupported.
- OCR is explicit and English-only. Raw recognition results are session-only and may
  contain errors; Native-text pages are skipped, and low-confidence output is not
  exposed as selectable text. Highlights, Underlines, Links, and Notes explicitly
  created from recognized text are ordinary user records and therefore follow normal
  persistence, backup, and optional Drive sync.
- Each website origin and browser profile has a separate IndexedDB Library. Clearing
  site data or changing the deployment origin can remove local data; regular Library
  backups remain necessary.
- **Forget inaccessible paper** is a local account/root-scoped quarantine, not cloud
  deletion or repair. Reviewing it again can expose the unresolved cloud issue.
- Google Drive sync requires a separately configured Worker, D1 database, OAuth
  credentials, Pages repository variable, and real multi-device acceptance before
  the release can be published with Drive support.

### License

The original 39Note code and project materials are rights-reserved and marked
`UNLICENSED`. Third-party software, fonts, data, models, and assets remain under
their respective licenses.
