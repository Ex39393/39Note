# 39Note 1.0.0 release checklist

Last updated: 2026-11-10

Current state: **release candidate, not yet published**. Local automated gates and
release-set review pass. Remote CI, D1 migration verification, deployment, public URL
verification, and the final Google OAuth production transition remain incomplete.

## Completed local gates

- [x] Main application and Sync Worker identify as `1.0.0`.
- [x] Original 39Note material is marked `UNLICENSED` and rights-reserved; third-party
      notices remain separate.
- [x] Main test suite: 1203 tests passed.
- [x] ESLint and full Prettier checks passed.
- [x] TypeScript and production application build passed with no Vite warnings.
- [x] PDF.js, local OCR assets, production recovery UI, and production bundle budgets
      passed their build-time verification.
- [x] Chrome and Edge native matrix passed desktop, 390 x 844 touch emulation, and
      Restore Phase B/C checks using synthetic data.
- [x] The real production `dist` startup smoke passed with same-origin GET-only
      requests and optional heavy assets remaining idle.
- [x] Main and Worker dependency audits reported zero known vulnerabilities on
      2026-11-10.
- [x] Worker test suite: 27 tests passed; type-check and Wrangler dry-run build also
      passed.
- [x] Collapsed Reader Tools keep only their visible opener in the accessibility
      tree, and a local persistence failure remains visible ahead of lower-risk
      export feedback until storage succeeds.
- [x] Synced AI settings cannot carry private headers to another credential profile,
      credentials cannot reach a non-loopback HTTP endpoint, and Print Composer can
      invoke a browser print dialog only once per request.
- [x] Deployment workflows use job-scoped Pages write permissions, reject production
      builds with an unexpected Worker origin, and reject deploy jobs from non-master
      branches. Worker and Pages deployments each require an explicit manual run.
- [x] Privacy Policy and Terms of Service documents are included, and Home plus
      Settings expose base-path-safe links to both documents.

## External configuration required

- [x] Repository owner confirmed `VITE_39NOTE_SYNC_AUTH_URL` is the exact deployed
      Worker HTTPS origin. The Pages workflow also rejects any other value.
- [x] Repository owner confirmed `SYNC_WORKER_DEPLOY_ENABLED` exists. Keep it false
      except during the deliberate Worker deployment window.
- [x] Repository owner confirmed GitHub Actions secrets `CLOUDFLARE_ACCOUNT_ID` and
      a narrowly scoped `CLOUDFLARE_API_TOKEN` exist.
- [x] Repository owner confirmed the Cloudflare Worker secrets contain the Google
      client ID, Google client secret, and `TOKEN_ENCRYPTION_KEY`; none is exposed to
      Pages.
- [x] Repository owner confirmed `TOKEN_ENCRYPTION_KEY` is backed up separately from
      D1 data.
- [ ] Apply all D1 migrations before deploying the matching Worker.
- [x] Google Auth Platform was inspected on 2026-11-10: the OAuth client uses the
      exact Worker `/api/oauth/callback` redirect URI. The production consent
      transition remains a separate final step below.
- [x] Add only `https://www.googleapis.com/auth/drive.file` under Google Auth
      Platform **Data Access**; do not add Drive-wide, email, profile, or OpenID
      scopes. Confirmed in Google Cloud on 2026-11-10; sensitive and restricted
      scope lists were empty after saving.
- [ ] After the current Pages release is public, set Google Auth Platform Branding to
      the exact deployed homepage, Privacy Policy, and Terms of Service URLs and
      verify that all three return the current 1.0.0 content without authentication.
- [ ] Move the external OAuth app from Testing to Production only after Branding and
      Data Access are complete and the public policy links have been reviewed.
- [x] `GET /health` on the deployed Worker returned HTTP 200 on 2026-11-04 with
      `{"status":"ok","service":"39note-sync-auth","workerSchemaVersion":2}`.
- [ ] Build Pages with the production base path and sync Worker URL, then verify the
      deployed app no longer reports an unconfigured Drive backend.

## Read-only public deployment audit — 2026-11-04

- [x] Public Pages returned HTTP 200, but it is the older 2026-10-01 deployment at
      commit `f6442ac6ca3d220e8a2a3a721a89bcaf5b919470`, not this local 1.0.0
      release candidate.
- [x] The older deployed lazy sync chunk contains the exact Worker origin
      `https://39note-sync-auth.39note.workers.dev`. This proves only that deployed
      bundle was configured; it does not confirm the current GitHub repository
      variable.
- [x] The public Worker health response matched the expected service and schema
      version exactly.
- [x] The latest public
      [Pages workflow run](https://github.com/Ex39393/39Note/actions/runs/36814181265)
      succeeded on the older commit. The latest public
      [Worker workflow run](https://github.com/Ex39393/39Note/actions/runs/36814181241)
      validated that same commit, while its deploy job was skipped.
- [ ] The 1.0.0 release branch has not yet been pushed and therefore has no remote CI
      or deployment evidence.
- [ ] Authenticated GitHub and Cloudflare verification plus the D1 migration state
      still need to be checked during the controlled deployment sequence.

## Real Google Drive acceptance

Run this section only with a controlled acceptance account and current builds. These
steps intentionally include real Drive mutations and have not been performed by the
automated or Codex checks.

- [ ] 1. Close every older 39Note tab, window, and device before beginning a real
      layout-2 to protocol-3 cutover. Do not reopen an older deployed build.
- [ ] 2. Connect the intended Google account and confirm the exact existing visible
      `39Note` root is discovered instead of creating a duplicate.
- [ ] 3. If a layout-2 library is reported, review the Advanced warning and run
      **Upgrade Drive sync** once. Reload and confirm every expected paper appears
      exactly once.
- [ ] 4. Confirm the control folder is directly under the existing root, every paper
      retains its `documentId`, and migration alone rewrites no source PDF or paper
      package.
- [ ] 5. Reload the page and confirm reconnection without another Google prompt.
- [ ] 6. Close and reopen the browser and confirm reconnection without another Google
      prompt.
- [ ] 7. Connect a clean second current-build desktop browser/profile to the same
      account and confirm both sessions under **Authorized devices**.
- [ ] 8. Verify A to B and B to A synchronization of PDFs, annotations and Notes,
      organization, reading position, Print Composer, and safe AI data. AI keys must
      still be requested separately on B.
- [ ] 9. Remove one locally available paper from Drive through Library. Confirm local
      content survives on both current-build devices, stale cloud folders cannot
      resurrect it, and ordinary local edits remain local.
- [ ] 10. Explicitly restore that paper and confirm it becomes active only after
      restoration finishes. Also verify cloud-only Download/removal and the separate
      **Remove from this device** action.
- [ ] 11. Disconnect only device A and confirm B continues to sync.
- [ ] 12. Reconnect A, run **Disconnect all devices**, and confirm every session fails
      closed and Google authorization revocation is submitted.
- [ ] 13. Run **Switch Google account** and confirm the account changes only after the
      Google account chooser.
- [ ] 14. Verify offline editing and a temporary Worker outage retain local data and
      queued work. Confirm Public/temporary mode cannot remove or restore Personal
      Drive papers.

## Release-set and publication controls

- [x] Review every tracked modification and untracked source, test, workflow,
      documentation, and third-party notice intended for the release.
- [x] Release-set hygiene audit confirmed generated output, browser profiles,
      screenshots, logs, databases, environment files, credentials, and local
      backups remain ignored and absent from the 134 modified plus 87 untracked
      candidate files.
- [x] Confirm the shipped third-party notices in `public/licenses`,
      `public/dictionary/WORDNET-LICENSE.txt`, `public/pdfjs-wasm`, and
      `DICTIONARY_SOURCES.md` are included, including the Tesseract data and runtime
      notices.
- [x] Confirm the two manual-only browser fixtures documented in
      `tests/fixtures/README.md` are intentionally included as developer evidence;
      they are not automated or production acceptance gates.
- [ ] Create a reviewed release commit or pull request; wait for every remote CI gate
      to pass.
- [ ] Tag the reviewed commit as `v1.0.0`.
- [ ] Deploy the Worker only after migrations and secrets are confirmed.
- [ ] Deploy Pages only after the Worker and repository variable are confirmed.
- [ ] Repeat production smoke, OAuth connection, and read-only Drive discovery on the
      deployed origin.
- [ ] Publish the final 1.0.0 notes only after all required checks above are recorded.

## Explicitly outside the 1.0.0 support claim

- Android and iOS real-device qualification.
- Safari and WebKit qualification.
- Legacy `.doc` and `.ppt` import.
- Automatic OCR, persistence of raw OCR results, or OCR modification of original
  PDFs. User-created records derived from recognized text remain ordinary persistent
  records.
- Automatic deletion or repair of quarantined/broken Drive records.

These are scope limits, not unrecorded release gates.
