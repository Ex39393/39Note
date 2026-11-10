# 39Note

A local-first desktop-ready PDF reader designed for academic papers. PDF is the
first-class Reader format.

## Supported formats

- PDF opens directly in the Reader.
- DOCX and PPTX are utility import formats that 39Note converts locally to PDF
  before adding the result to the Library.
- Legacy `.doc` and `.ppt` files are not supported.

## Browser support

39Note v1 targets current Chromium-based desktop browsers. Automated release
checks exercise targeted Drive recovery and restore-safety flows in Google Chrome
and Microsoft Edge, including a 390 x 844 touch-emulation viewport. They are not
whole-app browser qualification, Android or iOS real-device qualification, or
Safari/WebKit qualification; those environments are not claimed as supported.

## Initial setup

```bash
npm install
```

Node.js and npm are required. Dependencies are installed once; the launchers do not
run `npm install` automatically.

## One-click local start

- Double-click `Start 39Note.cmd` for a visible server window with diagnostic messages.
- Double-click `Create 39Note Desktop Shortcut.cmd` to create or replace `39Note.lnk`
  on the actual Windows Desktop. The shortcut explicitly targets Windows
  `wscript.exe` and passes `Start 39Note Hidden.vbs` as an argument, so Windows
  executes the launcher instead of opening it through a file association.
- `Start 39Note Hidden.vbs` can also be launched directly for a hidden console.
- The Windows default browser opens at `http://127.0.0.1:5173` only after the
  local server responds with 39Note's exact application identity marker.
- Keep the local server running while reading. Closing it stops localhost access.
- Port 5173 is strict: if another application owns it, that application is not opened
  or stopped, and 39Note reports the conflict instead of silently using port 5174.
- Hidden-start diagnostics are written to `39note-launch.log` in the project folder.

For normal development, use `npm run dev`. To reproduce the launcher command, use
`npm run start:local`.

39Note is local-first. Stored PDFs, annotations, notes, organization metadata,
and reading positions are written to the browser's IndexedDB immediately and all
reader features continue to work offline.

Optional personal Google Drive sync can mirror original PDFs and editable state to
a visible `39Note` folder in My Drive. It uses the limited `drive.file` permission
and a separately deployed Cloudflare Worker/D1 OAuth broker so authorized devices
can reconnect after reload without storing Google refresh tokens in the browser.
Drive content still travels directly between the browser and Google; AI API keys,
client secrets, passwords, and custom authentication headers are excluded. See
[Google Drive sync setup](docs/google-drive-sync.md).

## Local Office conversion and known limitations

DOCX and PPTX files can be converted locally to PDF before being added to the
Library. Conversion is best-effort and does not promise Microsoft Office
pixel-perfect fidelity.

- Some presentations containing flattened slide images plus retained PowerPoint
  text objects may show duplicated or ghosted text after conversion.
- Text that exists only inside bitmap images is labelled only after PDF.js reports
  no selectable text and records rendered image content. The user can then run
  explicit English OCR locally for one page or, through a cancellable serial queue,
  every verified image-only page in the document. Native-text pages are skipped.
  Raw recognition text and coordinates remain session-only and may contain errors.
  If the user explicitly creates a Highlight, Underline, Link, or Note from that
  text, the resulting user record includes the selected text and geometry and follows
  normal local persistence, backup, and optional Drive sync. Neither the raw result
  nor a derived record replaces the PDF, its fingerprint, or its document identity.
  39Note does not start OCR automatically or expose low-confidence output as
  selectable text.

Third-party license and attribution notices for shipped runtime code, data, and
assets are included in [`public/licenses`](public/licenses),
[`public/dictionary/WORDNET-LICENSE.txt`](public/dictionary/WORDNET-LICENSE.txt),
[`public/pdfjs-wasm`](public/pdfjs-wasm), and
[`DICTIONARY_SOURCES.md`](DICTIONARY_SOURCES.md).

## Web deployment

The static application can be published with the included GitHub Pages workflow.
The workflow supplies a repository-aware `VITE_BASE_PATH`, while ordinary local
development continues to use `/`.

Each website origin and browser profile has its own independent IndexedDB Library.
Unless the user explicitly connects Google Drive, nothing is uploaded by 39Note.
Use **Back up Library** regularly, especially before clearing browser data or
changing the published domain.

Define the public GitHub Actions repository variable `VITE_39NOTE_SYNC_AUTH_URL`
with the deployed Worker origin. Google client credentials and the token-encryption
key are Cloudflare Worker secrets; never expose them to Pages or commit them.

## License

Copyright (c) 2026 Ex39393. All rights reserved.

The original 39Note source code and project materials are publicly viewable but
are not licensed for reuse and are not open-source software. See [`LICENSE`](LICENSE)
for the complete terms. Third-party software, fonts, data, models, and other assets
remain subject to their respective licenses and attribution requirements in
[`public/licenses`](public/licenses),
[`public/dictionary/WORDNET-LICENSE.txt`](public/dictionary/WORDNET-LICENSE.txt),
[`public/pdfjs-wasm`](public/pdfjs-wasm),
[`DICTIONARY_SOURCES.md`](DICTIONARY_SOURCES.md), and the dependency metadata.

## Policies

The release includes a public [Privacy Policy](public/privacy.html) and
[Terms of Service](public/terms.html). The application Home and Settings pages link
to the deployed copies using the active Vite base path.
