# session-reel

Turn any Claude Code session into a short video. `/reel` replays the session's history as it happened: your prompts typed out, every tool call scrolling past, and a live clock and counters for prompts, tool calls, files and lines changed. Six hours of work becomes a 60-second clip you can post.

- **Real, not staged.** Everything on screen comes from the session transcript: the timestamps, the commands, the edit counts. Nothing is invented.
- **Safe to share.** Tool output is never drawn. API keys, tokens, long hashes, emails and your home folder are masked before anything reaches the frame.
- **Made for posting.** Every run renders a 16:9 video for YouTube and X and a 9:16 one for Shorts, Reels and TikTok, laid out clear of those apps' buttons and captions. Each opens close on your first prompt being typed, pulls back to the whole session, and ends on the totals counting up.
- **Looks like the app.** The default theme replays the session the way the Claude Code desktop app shows it: your prompts typed into the composer and sent as bubbles, replies streaming in, and collapsed tool rows ("Ran 4 commands, read a file +518"). Three more looks ship with it.
- **Sound if you want it.** Videos are silent by default, ready for your own music. `--sound on` adds soft typing under every prompt, the Enter key on send, a page flick over long breaks and one knock on the final count. The sounds were made for session-reel, not pulled from a stock library, and there are no whooshes or risers.
- **Smooth.** 60 fps, eased scrolling, a camera that pushes in while you type, and text that stays sharp at any zoom.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-reel --marketplace mattbaconz/session-reel
```

Answer `y` to add the marketplace, then pick a scope (user installs it for every session). From a shell, the same is:

```
claude plugin install session-reel --marketplace mattbaconz/session-reel
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `mattbaconz/session-reel`, then Add plugin.

You also need Node 18+ and ffmpeg; see [Requirements](#requirements).

## Use

```
/reel                       replay this session: a 16:9 and a 9:16 video, about 60 s each
/reel list                  recent sessions in this project, with ids
/reel 3f2a9c1e              replay a past session by id or id prefix
/reel --format vertical     only the 9:16 video (or: horizontal)
/reel --theme paper         another look
/reel --length 30 --title "i let claude build a video tool"
```

Videos land in `~/session-reels/` as `<project>-<date>-<id>-16x9.mp4` and `-9x16.mp4`. The render runs in the background; the status line shows progress and a toast says where it saved.

## Themes

| Theme | Look |
| --- | --- |
| `desktop` (default) | The Claude Code desktop app, dark. Colours sampled from the app. |
| `desktop-light` | The same layout on a light background. |
| `paper` | Warm off-white, with replies set in a serif (Georgia). |
| `terminal` | The Claude Code CLI: `>` prompts, `●` tool lines with their commands and paths. |

## Settings

Every setting is in `/config` under session-reel, and each has a flag that overrides it for one run.

| Setting | Flag | Values |
| --- | --- | --- |
| Theme | `--theme` | `desktop`, `desktop-light`, `paper`, `terminal` |
| Format | `--format` | `both`, `horizontal`, `vertical` |
| Length | `--length` | seconds, 10 to 600 (short sessions come out shorter) |
| Sound | `--sound` | `off` (default), `on` |
| Sound volume | `--volume` | 0 to 100 (default 80) |
| Text size | `--text` | `normal`, `large` (15% bigger, for phones) |
| Camera moves | `--camera` | `on`, `off` (off keeps the frame still) |
| Accent colour | `--accent` | a hex colour such as `#D97757` |
| Watermark | `--watermark` | `on`, `off` (the small "made with session-reel" line) |
| Frame rate | `--fps` | `60`, `30` |

`--title "..."` replaces the opening prompt with your own hook line.

Without the mod, the renderer is a plain Node script that takes the same flags:

```
node renderer/reel.mjs <session-id | file.jsonl> [flags] [--out reel.mp4]
node renderer/reel.mjs list
```

## Requirements

- Node 18 or newer
- ffmpeg with libass on PATH (`winget install ffmpeg`, `brew install ffmpeg`, `apt install ffmpeg`)
- The system fonts: Segoe UI, Georgia and Cascadia Mono on Windows; Helvetica Neue, Georgia and Menlo on macOS; DejaVu Sans, Serif and Sans Mono on Linux. Text is measured from the font file, so speech bubbles fit their text.

## What's drawn, and what isn't

| Drawn | Never drawn |
| --- | --- |
| Your prompts (slash commands included) | Tool results and file contents |
| Claude's replies, first three lines | Thinking, system reminders, injected context |
| Tool name plus a one-line summary (path, command, query) | Subagent transcripts |
| Edit sizes (+added −removed lines) | Secrets, emails, your home path (masked) |
| Breaks longer than 10 minutes, as "··· 2h later" | |

Masking is pattern-based. Watch your reel before you post it.

## Sound

The effects in `sfx/` were generated with ElevenLabs for this project, then trimmed and peak-normalised. Each sound has its level in `LEVEL` in `renderer/reel.mjs`. Repeated sounds rotate takes and vary slightly in pitch and level. The finished mix lands around −31 LUFS with peaks under −2 dBFS, so it sits quietly under music if you add some.

## Tests

```
node --test renderer/
claude plugin test .
```
