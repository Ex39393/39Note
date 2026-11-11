# Browser fixtures

These pages use synthetic records and isolated browser storage. They must never be
configured with a real Google account, Drive token, production storage origin, or
personal paper data.

Most fixtures are invoked by the native verification scripts in `scripts/`. The
following two pages are intentionally retained as manual developer evidence and are
not release gates:

- `accountMismatchViewportMatrix.html` opens the synthetic account-mismatch drawer
  at 390, 768, 1280, and 1536 CSS pixels for visual layout inspection. Its child
  fixture uses a fake coordinator and records zero Drive writes.
- `restorePhaseANativeBrowser.html` is the isolated BKP-03 Phase A IndexedDB/Web
  Locks prototype. It imports no 39Note production module and sends no network
  request. It intentionally leaves only synthetic databases on its isolated
  localhost fixture origin; the automated Phase B/C suites are the authoritative
  release checks.

Do not reinterpret either fixture as real Drive, production restore, mobile-device,
or cross-browser acceptance.
