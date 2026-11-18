# arev — asset review for AI agents

`arev` is a command-line tool that lets an AI agent put an **image, video or PDF** in front of a
human, collect **precise feedback**, and iterate until the human **approves** it.

```
agent: arev submit hero.png --name homepage-hero --wait
          │                         ▲
          ▼                         │ exit 10 approved / 11 changes requested / 12 rejected
human: browser review page ── comments on regions, timestamps, pages ── Approve / Request changes / Reject
```

![The review page: the asset, its version history, and an approved decision](docs/review-page.png)

- Every submission becomes an immutable **version** (v1, v2, …) of a named **asset**.
- The reviewer comments on a **region** of an image, a **moment or range** of a video (optionally a
  region of that frame), or a **page** (or region) of a PDF. Each anchored comment saves a
  **snapshot** PNG with the spot outlined, so a vision-capable agent sees exactly what was meant.
- The agent reads feedback as stable JSON, resubmits with `--resolves c3,c4`, and the reviewer
  sees which comments the agent claims to have fixed.
- Everything is local: a `.arev/` directory holding a SQLite database and the files themselves.
  The review server binds to 127.0.0.1 only.

See [SPEC.md](SPEC.md) for the full design.

## Install

### Homebrew (macOS, Linux)

```bash
brew install fsaint/tap/arev
```

This builds arev against Homebrew's `node`. To teach Claude Code the review loop, copy the skill
it installs (the exact path is printed after install):

```bash
mkdir -p ~/.claude/skills && cp -r "$(brew --prefix arev)/share/arev/skills/arev" ~/.claude/skills/
```

Upgrade with `brew upgrade arev`.

### From source

Requires Node 22+. `ffmpeg` is optional; it captures video frames for comments added from the CLI.

```bash
git clone https://github.com/fsaint/arev.git && cd arev
npm install
npm run build
npm link                                   # puts `arev` on your PATH
```

If `npm link` installs into a directory that is not on your `PATH`, link the binary yourself:

```bash
ln -s "$PWD/dist/cli.js" ~/bin/arev        # any directory on your PATH
```

## Quick start

```bash
arev init                                              # create .arev/ here
arev submit hero.png --name homepage-hero --note "v1"  # opens the review page
arev wait homepage-hero                                # blocks until you decide
arev feedback homepage-hero                            # Markdown; add --json for agents
arev submit hero2.png --name homepage-hero --resolves c1
arev status
arev get homepage-hero --approved -o dist/
```

## A review loop, end to end

1. The agent runs `arev --json submit thumb.png --name thumbnail --wait`. The review page opens.
2. You drag a box over the headline, write "Need this in pink", and click **Request changes**.
3. The agent's `submit` exits with code **11** and prints the feedback: the comment text, its
   anchor (`{"type":"region","x":0.04,"y":0.40,"w":0.82,"h":0.18}`) and a snapshot PNG.
4. The agent fixes it and runs `arev submit thumb-v2.png --name thumbnail --resolves c1 --wait`.
   Your open page switches to v2 by itself, and c1 shows "agent marked fixed in v2".
5. You click **Approve**. The agent's command exits **10**, and `arev get thumbnail --approved`
   returns the final file.

## Commands

| Command | Purpose |
|---|---|
| `arev init` | Create a `.arev/` store in the current directory (found from subdirectories, like git). |
| `arev submit <file> -n <asset> [--note] [--resolves c1,c2] [--wait] [--timeout 30m] [--force] [--no-open]` | Store a new version and request review. |
| `arev wait <asset> [-v N] [--timeout 30m]` | Block until decided. Exit 10 approved, 11 changes requested, 12 rejected, 3 timeout. |
| `arev feedback <asset> [-v N] [--all] [--format json\|md]` | Feedback for the latest decided version. |
| `arev status [asset]` / `arev list [--status s]` | Overview. |
| `arev versions <asset>` | Version history. |
| `arev get <asset> [-v N \| --approved] [-o path]` | Get a version's file. |
| `arev comment <asset> "text" [--anchor JSON] [--author who]` | Add a comment from the CLI. |
| `arev approve <asset> [-m]` / `request-changes -m` / `reject -m` | Decide from the terminal. |
| `arev serve [-p port]` / `arev open [asset]` | Review UI (`submit` and `open` start it in the background). |
| `arev rm <asset>` | Archive an asset. |

Global flags: `--json` (machine output, errors as `{"error":{code,message}}`), `--store <dir>`,
`--global` (use `~/.arev`). `arev -V` prints the version.

Exit codes: `0` ok, `1` error, `2` not found, `3` timeout, `10` approved, `11` changes requested,
`12` rejected.

## The review page

`http://localhost:7717` (one port per store, chosen automatically).

- **Image:** drag to comment on a region, click for a point; zoom with Fit / 1:1 / ± buttons.
- **Video:** press **C** to comment at the current time; "Set end" turns it into a range;
  "Draw region" marks an area of the frame; step frame by frame.
- **PDF:** drag on a page to mark a region, or "Comment on page".
- **History:** every version with its status, the agent's note, your summary and comment count.
  Click one to view it.
- **Compare** with any other version: side by side, or a slider for images.
- **Decide:** Approve, Request changes, Reject. The last two need a comment or a summary. A
  confirmation appears once the decision is saved, and the decision bar keeps showing it.
- **Live:** when the agent submits a new version, the page switches to it. If you are in the
  middle of writing a comment, it shows a banner instead so nothing is lost.

Settings live in `.arev/config.json`: `port`, `open_browser`, `notifications` (macOS).

## For agents

[`skills/arev/SKILL.md`](skills/arev/SKILL.md) teaches Claude Code the loop: submit with
`--wait`, branch on the exit code, read comments and snapshots, resubmit with `--resolves`, and
never approve or reject on the human's behalf. Homebrew users: see [Install](#homebrew-macos-linux).
From a source checkout, symlink it so it stays in sync with the repo:

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/arev" ~/.claude/skills/arev
```

## Development

```bash
npm test     # builds, then runs unit, server and end-to-end CLI tests (vitest)
npm run dev  # tsc --watch
```

Layout: `src/store/` (SQLite schema, versioning, feedback), `src/server/` (HTTP API, SSE, file
serving with Range support, background auto-start), `src/cli.ts` (commands), `web/` (review UI,
plain JS + pdf.js), `skills/arev/SKILL.md`, `test/`.
