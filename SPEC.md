# Spec: `arev` — AI Asset Review CLI

## Context
AI agents (Claude Code, etc.) generate visual assets — images, videos, PDFs — but have no structured way to put them in front of a human, collect precise feedback, and iterate. Today feedback arrives as loose chat text ("make the logo bigger"), versions get overwritten, and there is no record of what was approved.

`arev` is a local command-line tool that gives an agent a review loop:
1. Agent **submits** a file under a stable **name** → a new **version** is stored.
2. Human **reviews** it in a local browser viewer, leaving general and anchored comments (image region, video timestamp, PDF page).
3. Human **decides**: Approve / Request changes / Reject (feedback required for the last two).
4. Agent **waits** for the decision, **reads the feedback** as structured JSON, produces a new version, resubmits — until approved.

Status: v1 implemented (2026-11-13). See README.md for usage.

**Defaults chosen (redirect if wrong):** TypeScript on Node 20+, SQLite (`better-sqlite3`), single local user, no cloud. Command name `arev`.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Store** | A `.arev/` directory (found by walking up from cwd, like `.git`; `arev init` creates it). Global fallback `~/.arev/` with `--global`. |
| **Asset** | A named, logical deliverable, e.g. `homepage-hero`. Name is a slug (`[a-z0-9-_/]`, `/` allowed for grouping: `ep12/thumbnail`). Has a kind: `image`, `video`, `pdf` (detected from MIME; fixed after v1). |
| **Version** | An immutable snapshot of the file: `v1, v2, …`. Content stored by SHA-256; resubmitting identical bytes is rejected (`E_DUPLICATE`) unless `--force`. Carries an agent **note** ("what changed"). |
| **Review** | One review per version. Status: `pending` → `approved` \| `changes_requested` \| `rejected`. |
| **Comment** | Feedback item on a version. General or anchored. Can be marked `resolved` by the agent in a later version. |
| **Decision** | The final action on a review: who, when, status, summary text. |

Asset status = status of its latest version. An asset is **done** when its latest version is `approved`. `rejected` means "stop this direction" (agent should not simply iterate; it should report back or change approach). `changes_requested` means "iterate".

### Anchors
- **image**: `{ "type": "region", "x": 0.12, "y": 0.30, "w": 0.20, "h": 0.15 }` (normalized 0–1) or `{ "type": "point", "x", "y" }`
- **video**: `{ "type": "time", "t": 12.4 }` or `{ "type": "range", "start": 12.4, "end": 15.0 }`, optionally with a region on that frame
- **pdf**: `{ "type": "page", "page": 3 }` optionally with a region on that page

When an anchored comment is created, the viewer also saves a **crop/frame snapshot** PNG (region crop, video frame at `t`, PDF page render) so an agent with vision can see exactly what was pointed at.

## 2. Lifecycle

```
submit v1 ──► pending ──► approved            (done)
                     ├──► changes_requested ──► submit v2 ──► pending ──► …
                     └──► rejected             (agent must not auto-iterate)
```
- Submitting a new version while the previous is `pending` supersedes it (old review → `superseded`).
- Approving/rejecting requires the version to be the latest.
- `rejected` and `changes_requested` require at least one comment or a summary.

## 3. CLI (agent-facing)

`arev -V` prints the tool version (`--version` is taken by subcommands to pick an asset version). All commands support `--json` (stable machine-readable output to stdout, logs to stderr). Exit codes: `0` ok, `1` error, `2` not found, `3` timeout, `10` approved, `11` changes requested, `12` rejected (exit codes 10–12 only from `wait` / `submit --wait`).

| Command | Purpose |
|---|---|
| `arev init` | Create `.arev/` in cwd. |
| `arev submit <file> --name <asset> [--note "…"] [--resolves c12,c15] [--wait] [--timeout 30m] [--no-open]` | Store a new version, start the review server if needed and open the page in the browser (`--no-open` skips both), print `{asset, version, review_url}`. `--resolves` marks prior comments as addressed (shown to the reviewer as "agent says fixed"). `--wait` blocks like `wait`. |
| `arev wait <asset> [--version N] [--timeout 30m]` | Block until the review is decided. Prints the decision + feedback (same shape as `feedback`). Polls the DB; no server required. |
| `arev status [<asset>]` | One asset or a table of all: name, kind, latest version, status, open comment count. |
| `arev list [--status pending\|approved\|…]` | List assets. |
| `arev feedback <asset> [--version N] [--all] [--format json\|md]` | Feedback for the latest decided version (or all versions with `--all`). Includes comment text, anchors, snapshot paths, decision summary. |
| `arev get <asset> [--version N\|--approved] [-o path]` | Copy a version's file out (default: latest). `--approved` = latest approved version. |
| `arev versions <asset>` | Version history: number, hash, note, status, decision summary, timestamps. |
| `arev comment <asset> "text" [--version N]` | Agent or human adds a general comment from CLI (e.g. agent asks a clarifying question). |
| `arev approve <asset> [-m "…"]` / `arev reject <asset> -m "…"` / `arev request-changes <asset> -m "…"` | Human decides from the terminal without the UI. |
| `arev serve [--port 7717]` | Run the review UI server (auto-started in the background by `submit` if not running). |
| `arev open <asset>` | Open the review page in the browser. |
| `arev rm <asset>` | Archive an asset (soft delete). |

### `feedback --json` shape (the contract agents depend on)
```json
{
  "asset": "homepage-hero",
  "kind": "image",
  "version": 3,
  "status": "changes_requested",
  "decided_at": "2026-11-13T10:22:01Z",
  "summary": "Closer, but the CTA still reads weak.",
  "file": "/abs/.arev/objects/ab/ab12….png",
  "comments": [
    {
      "id": "c21",
      "text": "Make this button higher contrast",
      "anchor": { "type": "region", "x": 0.62, "y": 0.71, "w": 0.18, "h": 0.08 },
      "snapshot": "/abs/.arev/snapshots/c21.png",
      "author": "human",
      "created_at": "…",
      "resolved": false,
      "resolved_in_version": null,
      "version": 3
    }
  ],
  "latest_version": 3,
  "note": "agent's note for this version",
  "decided_by": "human",
  "unresolved_from_previous": [ { "id": "c15", "version": 2, "text": "…", "anchor": null, "...": "same shape as comments[]" } ]
}
```
`unresolved_from_previous` holds full comment objects (not just ids), so the agent has everything in one call.
`--format md` renders the same data as a Markdown checklist for pasting into a prompt.

## 4. Review UI (human-facing)

Local web app served by `arev serve` at `http://localhost:7717`, bound to 127.0.0.1 only.

- **Inbox** (`/`): assets awaiting review first, then the rest; status badges.
- **Review page** (`/a/<asset>/v/<n>`):
  - Viewer by kind: image (zoom/pan), video (HTML5 player, frame step, comment at current time), PDF (pdf.js, page thumbnails).
  - Draw a box / click a point / press `C` at a video time to add an anchored comment; side panel lists comments, clickable to jump to the anchor.
  - Agent's version note and "resolves" list shown at the top.
  - Version switcher; **compare** mode for images (side-by-side and slider) and PDFs (page side-by-side).
  - Decision bar: **Approve**, **Request changes**, **Reject** + summary textarea. Request changes/Reject disabled until there is a comment or summary.
- Live update via SSE: a new version submitted while the page is open shows a banner.
- Optional macOS notification on submit (`osascript`), toggle in `.arev/config.json`.

## 5. Storage

```
.arev/
  arev.db              SQLite: assets, versions, reviews, comments, events
  objects/ab/ab12….png content-addressed files (original extension kept)
  snapshots/c21.png    comment crops / frames / page renders
  config.json          port, notifications, open_browser
```
Tables: `assets(id, name UNIQUE, kind, created_at, archived)`, `versions(id, asset_id, n, sha256, path, mime, bytes, note, created_at)`, `reviews(id, version_id, status, summary, decided_at, decided_by)`, `comments(id, version_id, text, anchor_json, snapshot_path, author, resolved_in_version, created_at)`, `events(id, ts, type, payload_json)` (audit log). WAL mode so the CLI `wait` and server can share it.

Video frame extraction and thumbnails use `ffmpeg` if present (degrade gracefully: video comments still work, just no frame snapshot). PDF rendering uses pdf.js in the browser; snapshots are captured client-side and uploaded to the server.

## 6. Agent integration

- Ship `skills/arev/SKILL.md` (Claude Code skill) describing the loop: `submit --wait` → on exit 11 read `feedback --json`, look at snapshots, fix, resubmit with `--resolves`; on 10 stop; on 12 report to user and stop.
- `wait` must be safe to run in the background (Claude Code `run_in_background`) — it only polls SQLite, prints once, exits.
- Future (out of scope v1): MCP server exposing the same commands as tools.

## 7. Non-goals (v1)
Multi-user/auth, remote hosting, real-time collaboration, editing tools, audio-only assets, non-PDF documents (docx, pptx), version branching.

## 8. Implementation layout (when built)
```
package.json, tsconfig.json
src/cli.ts            commander-based entry, command registry
src/store/            db.ts (schema + migrations), objects.ts (hashing/copy), find-store.ts
src/commands/         one file per command
src/server/           express/hono app, routes, SSE
web/                  review UI (vanilla TS + pdf.js; no framework needed)
skills/arev/SKILL.md
test/                 vitest
```
Milestones: (1) store + submit/status/versions/get; (2) server + image review + decisions; (3) wait/feedback JSON contract; (4) video + PDF viewers + snapshots; (5) compare mode, notifications, skill.

## 9. Verification
- Unit tests (vitest) for store: versioning, duplicate detection, state transitions, feedback JSON shape (snapshot test of the contract).
- E2E script: `arev init` in a temp dir → `submit sample.png --name t --no-open` → `arev request-changes t -m "x"` → `wait t` exits 11 and JSON matches schema → submit v2 with `--resolves` → `approve t` → `wait` exits 10 → `get t --approved` returns v2 bytes.
- Manual: run `arev serve`, review an image, a video (comment at timestamp, check frame snapshot), and a PDF (page region comment) in the browser; confirm a background `arev wait` returns when the decision button is clicked.

