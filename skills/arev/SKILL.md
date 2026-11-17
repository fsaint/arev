---
name: arev
description: Use when you generate an image, video or PDF that a human should review before it is final (designs, thumbnails, renders, brochures, slides exported to PDF). Submits the asset with `arev`, waits for the human's decision, reads structured feedback, and iterates until approved. Triggers: "get my approval", "let me review it", "send it for review", "iterate until I approve".
---

# Asset review loop with `arev`

`arev` stores every version of a named asset, shows it to the human in a local browser
review page, and hands their feedback back to you as JSON. Use it instead of asking
"does this look good?" in chat.

## Setup (once per project)

```bash
arev init            # creates .arev/ in the project root (skip if it exists)
```

## The loop

1. **Submit** the file under a stable name. Reuse the same name for every iteration.
   ```bash
   arev --json submit out/hero.png --name homepage-hero --note "first pass: blue palette" --wait --timeout 30m
   ```
   This opens the review page for the human and blocks until they decide.
   Run it with `run_in_background` if you have other work; you are notified when it exits.

2. **Branch on the exit code:**

   | exit | meaning | what you do |
   |---|---|---|
   | 10 | approved | Stop iterating. Use `arev get <name> --approved -o <dest>` if you need the file. |
   | 11 | changes requested | Read the feedback (step 3), fix, resubmit (step 4). |
   | 12 | rejected | **Do not iterate on this direction.** Report the summary to the user and ask how to proceed. |
   | 3  | timeout | Nobody reviewed yet. Run `arev wait <name>` again, or tell the user it is waiting. |
   | 1/2 | error / not found | Read the `error.message` in the JSON output. |

3. **Read the feedback.** With `--json`, the `feedback` object in the output is:
   - `summary` — the reviewer's overall verdict.
   - `comments[]` — each has `id` (e.g. `c12`), `text`, `anchor`, and `snapshot`.
     - `anchor` says *where*: image `region`/`point` (coordinates normalized 0–1, origin top-left),
       video `time`/`range` in seconds (optionally with a `region`), PDF `page` (optionally with a `region`).
     - `snapshot` is a PNG path of the frame/page/image with the spot outlined in red.
       **Look at it** (Read the file) — it is the fastest way to understand the comment.
   - `unresolved_from_previous[]` — older comments still open. They count too.

   You can also run `arev feedback <name>` (Markdown) or `arev feedback <name> --json` at any time.

4. **Fix and resubmit**, saying which comments you addressed:
   ```bash
   arev --json submit out/hero-v2.png --name homepage-hero \
     --note "bigger logo, removed checkerboard" --resolves c12,c15 --wait
   ```
   Only list comments you actually addressed. The reviewer sees "agent marked fixed" and checks.

## Rules

- One asset name per deliverable; never invent a new name to dodge feedback.
- Identical bytes are refused (`E_DUPLICATE`) — make a real change before resubmitting.
- Ask the human a question with `arev comment <name> "question" ` rather than guessing.
- Never approve or reject on the human's behalf (`arev approve/reject` are for humans).
- `arev status` shows everything; `arev versions <name>` shows the history.
