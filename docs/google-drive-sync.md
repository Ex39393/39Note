# Google Drive sync

39Note is local-first. Optional sync copies original PDFs and allowlisted editable study data directly between the browser and a visible `39Note` folder in the user's Google Drive. A small Cloudflare Worker and D1 database act only as an OAuth and device-session broker; the Worker never receives PDFs, annotations, Notes, AI conversations, or Drive file/folder IDs.

## Security model

- The only requested Google scope is `https://www.googleapis.com/auth/drive.file`.
- The Worker uses Google's OAuth 2.0 Web Server authorization-code flow with state, PKCE S256, `access_type=offline`, and `include_granted_scopes=true`.
- After code exchange, the Worker calls Drive `about.get(fields=user(permissionId))`. Google's opaque Drive permission ID identifies the same Google account on additional devices without requesting `openid`, email, or profile scopes.
- The Google client secret exists only as a Cloudflare Worker secret.
- Refresh tokens are encrypted with AES-256-GCM using a separate 32-byte secret key. D1 stores ciphertext, a random 96-bit IV, and a key version—not the encryption key.
- A browser receives a random 256-bit device-session token once. D1 stores only its SHA-256 hash. Each device session is independently revocable.
- Personal-device sessions may be persisted locally. Public/temporary sessions stay in browser-session storage and have a fixed server-enforced 12-hour lifetime that activity cannot extend.
- Google access tokens are returned to an authenticated browser when needed, cached in memory only, and never written to IndexedDB, backups, sync payloads, URLs, or logs.
- OAuth state and browser grant-exchange values are one-time, origin/device-bound, and short-lived. The grant returns in a URL fragment so it is not sent to GitHub Pages.
- Allowed browser origins are exactly `http://127.0.0.1:5173`, `http://localhost:5173`, and `https://ex39393.github.io`. CORS never uses `*`.

Drive content is protected in transit by HTTPS and at rest by Google Drive, but it is not end-to-end encrypted by 39Note. The authentication service stores the account's encrypted refresh token and non-content session metadata. AI provider keys remain device-local and never sync.

## D1 contents

The migrations in `sync-worker/migrations/0001_auth.sql` and `0002_temporary_sessions.sql` create only:

- `users`: opaque Drive user ID, encrypted refresh token, IV, key version, granted scopes, timestamps, revocation state;
- `device_sessions`: user/device IDs, session-token hash, timestamps, revocation state;
- `oauth_states` and `authorization_grants`: one-time, expiring authorization metadata;
- `rate_limits`: short-window abuse-control counters.

Migration 0002 adds only personal/temporary mode and absolute-expiry metadata to OAuth state, grants, and device sessions. Existing records deterministically remain personal sessions.

D1 has no PDF bytes, study JSON, annotations, Notes, conversations, Drive file IDs, or folder IDs.

The Worker exposes `GET /health`, `POST /api/oauth/start`, `GET /api/oauth/callback`, `POST /api/oauth/exchange`, `POST /api/google/access-token`, `GET /api/sessions`, `POST /api/session/disconnect`, and `POST /api/session/disconnect-all`. Authenticated endpoints require `Authorization: Bearer <device-session>` and an allowed `Origin`; none accepts Drive content.

## Paper-centric immutable Drive protocol

The current cloud layout is version 3. It keeps the existing immutable Paper-v2
package bytes and adds an app-owned control plane directly under the same visible
managed root:

```text
39Note/
  39Note Control/
    layout descriptor
    migration-completion evidence
    immutable paper-presence generations
  Paper name/
    Paper name.pdf
    Paper name - Print.pdf        # only when real PDF bytes exist
    39Note Data/
      immutable manifests
      immutable editable-state payloads
      immutable conflict journals
```

The names `39Note`, `39Note Control`, paper-folder names, and filenames are
cosmetic. Strong 39Note app properties, exact parent relationships, and stable
`documentId` values provide identity. The control folder must be directly under
the exact verified root and outside every paper folder. Cached and user-selected
roots are re-read and accepted only when Drive reports that the current account
owns the folder and its role, layout, protocol, control-folder, and migration
evidence bindings are valid.

Each paper has a canonical, content-hashed presence DAG using protocol version 1.
Its logical state is `present` or `removed`; parent heads, not timestamps or Drive
creation order, determine ancestry. Presence is authoritative over physical folder
existence, so `removed` plus a stale folder remains removed. Concurrent removals
converge to removed, and a stale ordinary writer cannot override a removal. Only an
explicit restore generation acknowledging every current removed head may return a
paper to `present`.

### Lightweight discovery and selective transfer

Authentication performs a bounded-concurrency metadata scan. It lists managed paper folders and reads immutable manifests, but does not download source PDFs, Notes bodies, annotations, print drafts, conflict bodies, or other payloads. The paper browser exposes explicit **Download selected** and **Download all** actions. Full hashes and payload validation occur only for selected papers.

Modification time and device labels are display information only. Correctness comes from the complete immutable generation graph: canonical content hashes, declared parents, ancestry validation, and deterministic head derivation. A mutable hint or timestamp is never the sole head authority.

### Per-paper publication and convergence

Each paper has independent dirty reasons, baselines, heads, tombstones, and conflict evidence. Publication resolves the current remote heads, deterministically reconciles them with the local paper, writes only changed immutable payloads, uploads an unchanged source PDF zero times, publishes the manifest last, re-reads the exact manifest and references by known file ID, and performs fresh head discovery. A concurrent head causes that paper to remain dirty and retry/reconcile; unrelated papers continue independently. Metadata work is limited to four concurrent operations and payload/PDF transfer to two.

The editable Print Draft, selected built-in template, and overrides travel with the paper. The browser print dialog does not give 39Note PDF bytes, so the app does not fabricate `Paper name - Print.pdf`. The protocol already has a distinct hashed rendered-PDF descriptor with `renderedFromDraftHash` for a future real PDF-generation path.

### Controlled layout upgrades

The earlier whole-library schema-1 layout is detected explicitly and ordinary paper
sync is blocked. **Upgrade Drive layout from this device** republishes authoritative
local papers into verified Paper-v2 packages and activates that intermediate layout
only after publication succeeds. Unknown files and legacy evidence are preserved;
the implementation performs no destructive garbage collection.

An existing layout-2 root then requires the separate, explicit **Upgrade Drive
sync** cutover. Before starting, close every other 39Note tab, window, and device,
and do not reopen an older build afterward. The migration exhaustively verifies all
current Paper-v2 folders and heads, creates/verifies the control area, publishes one
initial `present` presence generation per valid paper, verifies durable completion
evidence, and changes the root to layout 3 last. A local checkpoint records exact
root, control, paper-folder, package-head, and presence-generation identities so a
pre-activation interruption can safely retry while the root remains layout 2. If
activation completed before the local checkpoint was cleared, recovery verifies
the root-bound completion evidence and resumes as v3; it never downgrades.

Future or malformed root versions fail closed. Initialization and every
authoritative publish re-read the exact root after acquiring serialized Drive
operation ownership, so a stale earlier layout check cannot authorize a later
write.

### Removal and restore

**Remove from Google Drive** first publishes and verifies authoritative `removed`
presence, then moves only the exact verified app-owned paper folder to Drive Trash.
The local PDF and editable state remain on the device. If Trash fails, the paper is
still logically removed and is shown with cleanup pending; retry may finish only the
physical cleanup. Ordinary edits and autosync cannot recreate it.

**Restore to Google Drive** is explicit. It verifies and republishes the package
first, then publishes `present` last while acknowledging all current removal heads.
A failure before that final step leaves the paper removed. The Library presents a
deduplicated `documentId` union of local and cloud papers; cloud-only rows are
metadata-only until the user chooses Download. **Remove from this device** remains
separate from **Remove from Google Drive**. Destructive cloud removal and restore
are disabled in Public/temporary mode.

All generation discovery, transfer, hashing, and merge work happens directly between the browser and Google Drive under `drive.file`. The OAuth Worker remains a token broker only. Tokens, authorization headers, device-session secrets, OAuth codes, AI keys, and Worker secrets are excluded from manifests, payloads, filenames, diagnostics, and logs.

## 1. Create the Google OAuth Web client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
3. Open **Google Auth Platform**. Complete Branding and Audience, and add the intended Google account as a test user while the app is in testing.
4. Under **Data Access**, add only `https://www.googleapis.com/auth/drive.file`. Do not add full Drive, email, profile, or OpenID scopes.
5. Under **Clients**, create an OAuth client of type **Web application**.
6. Keep its client ID and client secret out of chat, source control, GitHub variables, Pages, `.env` files, and D1. They will be entered directly into Cloudflare secrets.
7. Once the Worker URL is known, add its exact callback as an **Authorized redirect URI**:

   ```text
   https://39note-sync-auth.39note.workers.dev/api/oauth/callback
   ```

   The match is exact, including HTTPS, hostname, path, and absence of a trailing slash.

Google references: [Web Server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), and [`about.get` authorization](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).

## 2. Create D1 and configure the Worker

Use a terminal on the repository checkout. Do not paste any secret into an issue, commit, command argument, or chat.

```powershell
cd sync-worker
npm ci
npx wrangler login
npx wrangler d1 create 39note-sync-auth
```

Copy the returned D1 UUID into `sync-worker/wrangler.jsonc` as `database_id`, replacing `REPLACE_WITH_D1_DATABASE_ID`. The database UUID is configuration, not a credential.

Apply the schema:

```powershell
npx wrangler d1 migrations apply 39note-sync-auth --remote
```

Enter the Google values only at Wrangler's hidden prompts:

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Generate an independent cryptographically random 32-byte AES key and send it directly to Wrangler without printing it:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

Deploy, record the resulting HTTPS Worker URL, and add its exact `/api/oauth/callback` URI to the Google client:

```powershell
npm run deploy
```

Confirm `https://YOUR-WORKER-URL/health` returns `status: "ok"`. Cloudflare references: [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), and [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

For local Worker development after creating an ignored `sync-worker/.dev.vars`, use `npm run dev` inside `sync-worker`. In a second terminal, run the 39Note frontend with `npm run dev` from the repository root and point `VITE_39NOTE_SYNC_AUTH_URL` at Wrangler's local HTTP URL. Never commit `.dev.vars`.

## 3. Configure 39Note

For local Vite, create an ignored `.env.local` containing only the public Worker URL:

```text
VITE_39NOTE_SYNC_AUTH_URL=https://39note-sync-auth.39note.workers.dev
```

For GitHub Pages, create the repository variable `VITE_39NOTE_SYNC_AUTH_URL` with that same public URL. Do not create `VITE_GOOGLE_DRIVE_CLIENT_ID`; browser-side Google client IDs and GIS token clients are not used.

The Pages workflow and Worker workflow are intentionally separate. The Worker workflow deploy job runs only when repository variable `SYNC_WORKER_DEPLOY_ENABLED` equals `true`; it also needs GitHub Actions secrets `CLOUDFLARE_ACCOUNT_ID` and a narrowly scoped `CLOUDFLARE_API_TOKEN`. Google secrets remain in Cloudflare, not GitHub.

## 4. Real acceptance

1. Close every old 39Note tab/window/device before a real v2 → v3 cutover. Start
   only this build at `http://127.0.0.1:5173` and do not reopen an older deployed
   build after migration begins.
2. Choose **Drive sync**, connect the intended Google account, and confirm the exact
   existing visible `39Note` root is discovered rather than duplicated.
3. If the drawer reports a layout-2 library, open Advanced, read the cutover warning,
   and choose **Upgrade Drive sync** once. Confirm the root stays usable after a
   reload and the Library lists every expected paper exactly once.
4. Verify the control folder is directly under the existing root and every valid
   paper remains present with the same `documentId`; no source PDF/package is
   rewritten merely by migration.
5. Reload the page. It must reconnect and sync without another Google prompt.
6. Close and reopen the browser. It must reconnect without another Google prompt.
7. Connect a clean second current-build browser/device to the same Google account.
   Both independent sessions must appear under **Authorized devices**.
8. Exercise A → B and B → A changes for PDFs, annotations/Notes, organization,
   reading position, Print Composer, and safe AI data. AI keys must still be
   requested separately on B.
9. From Library, remove one locally available paper from Drive. Verify its local
   content survives on both current-build devices, a stale physical folder cannot
   resurrect it, and an ordinary local edit remains local.
10. Explicitly restore that paper and verify the package becomes active only after
    the restore completes. Also verify cloud-only Download/removal and the distinct
    **Remove from this device** action.
11. Disconnect only A. B must continue to sync.
12. Reconnect A, then use **Disconnect all devices**. Every device session must fail
    closed and Google authorization revocation must be submitted.
13. Exercise explicit **Switch Google account** and verify the browser changes
    accounts only after the Google account chooser.
14. Verify offline editing and a temporary Worker outage leave local data available
    and queued. Confirm Public/temporary mode cannot remove or restore Personal
    Drive papers.

## Operations and recovery

- Normal active usage makes roughly one Worker refresh request per access-token lifetime per device, plus occasional session-list calls. D1 writes occur for authorization/revocation, bounded rate counters, and a throttled `last_used_at` update—not for each Drive operation. All Drive file traffic bypasses the Worker.
- A conservative planning model for one active device per user, an eight-hour active day, one startup token, eight hourly renewals, and one session-list read is approximately:

  | Active users | Worker auth requests/day | D1 statements/day (modeled upper range) | Worker PDF bytes |
  | -----------: | -----------------------: | --------------------------------------: | ---------------: |
  |            1 |                       10 |                                      50 |                0 |
  |           10 |                      100 |                                     500 |                0 |
  |          100 |                    1,000 |                                   5,000 |                0 |

  Initial OAuth, device addition, and revocation add a small burst outside this steady-state model. Actual use depends on browser activity and token lifetime.

- Review current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) for the Cloudflare account. Free-tier suitability depends on actual active devices and refresh frequency; monitor usage rather than treating a tier as guaranteed capacity.
- Back up `TOKEN_ENCRYPTION_KEY` in a secure password manager. Losing it makes stored refresh tokens undecryptable; affected users must reauthorize. Never store the key beside a D1 export.
- Records carry `encryption_key_version = 1`. A future rotation must deploy code capable of decrypting both old and new versions, re-encrypt records, verify completion, and only then remove the old key. The current Worker deliberately fails closed on unknown versions.
- If a client secret or encryption key may be compromised, rotate it in Google/Cloudflare, revoke all affected Google grants and device sessions, and require reauthorization.
- D1 migrations are versioned and should be applied before the matching Worker deployment. Cloudflare D1 Time Travel/backup features protect database state; they do not replace secure retention of the external encryption key.

## Troubleshooting

- **Persistent sync backend not configured**: set `VITE_39NOTE_SYNC_AUTH_URL` and rebuild/restart Vite.
- **redirect_uri_mismatch**: register the exact Worker `/api/oauth/callback` URI in the Google Web client. Browser origins are not redirect URIs.
- **Reauthorize Google Drive**: Google omitted the first refresh token, invalidated the grant, or the account was revoked. Approve the consent request again.
- **Sync service unavailable**: local use continues. Check `/health`, Worker logs, D1 availability, and Cloudflare status; the browser keeps its device session for bounded retry.
- **Multiple 39Note folders**: select the intended app-visible folder. 39Note never merges multiple roots automatically.
- **Folder renamed**: 39Note follows the cached Drive folder ID. If it is deleted/trashed/inaccessible, the UI asks before creating a replacement.
