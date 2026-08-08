# 39Note

A local-first desktop-ready PDF reader designed for academic papers.

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

39Note remains fully local. Stored PDFs, annotations, notes, organization metadata,
and reading positions stay in the browser's IndexedDB.

## Web deployment

The static application can be published with the included GitHub Pages workflow.
The workflow supplies a repository-aware `VITE_BASE_PATH`, while ordinary local
development continues to use `/`.

Each website origin and browser profile has its own independent IndexedDB Library.
PDFs and Notes are not uploaded by 39Note. Use **Back up Library** regularly,
especially before clearing browser data or changing the published domain.
