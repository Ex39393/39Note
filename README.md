# 39Note

A local-first desktop-ready PDF reader designed for academic papers. PDF is the
first-class Reader format.

## Supported formats

- PDF opens directly in the Reader.
- DOCX and PPTX are utility import formats that 39Note converts locally to PDF
  before adding the result to the Library.
- Legacy `.doc` and `.ppt` files are not supported.

## Browser support

39Note v1 targets current modern browsers. Release qualification was performed
with Google Chrome 153. Other browsers and significantly older browser releases
have not been qualified and are not claimed as supported.

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
- Text that exists only inside bitmap images is not selectable or searchable
  because OCR is not implemented.

Third-party license notices for shipped runtime code and assets are included in
[`public/licenses`](public/licenses).

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
