# STM promo

A 26.4-second motion-graphics loop of SillyTavern Manager's main features. It has 11 bars at 100 BPM, in English and Vietnamese. It is sized to be read at a glance in a chat embed: large cards, a title per section, and slow camera moves where there is detail to read.

The shape on screen never cuts. It morphs from one UI to the next while each section floods the canvas with a new color from the pointer, a hand that taps and drags. The last frame is identical to the first, so the MP4 and the GIF loop seamlessly. Each section shows a title only.

Each section's start beat is set once in `AT` in `index.html`, and everything in the section is timed from it, so sections can be reordered there.

| Beats | Section |
| --- | --- |
| 0–4 | Intro: the logo is clicked and opens into the brand pill |
| 4–8 | 01 Quick install: the Android package installer installs `STM.apk`, then opens it |
| 8–12 | 02 Pick any version: the version list opens and 1.17.0 is picked |
| 12–24 | 03 Chat bubbles (Android): chat heads pop on a phone's home screen with a notification, the camera pushes in slowly, and each bubble opens its own SillyTavern chat while a reply streams in; then the camera pulls back |
| 24–28 | 04 Bring your old data: a backup ZIP is dragged in and restored |
| 28–32 | 05 Cloud backup: auto backup is switched on, the ring fills, a check appears |
| 32–40 | 06 Open on your other devices: a QR is scanned, the phone takes the PIN, then a laptop and a tablet show the same chat |
| 40–44 | Outro: brand pill, the supported systems in their own colors, then back to the logo |

The SillyTavern screens are a small rebuild of its chat layout: the top bar (response settings, connections, formatting, world info, user settings, backgrounds, persona, characters), message blocks with the avatar and message number over the tavern background, narration in italics, speech in the quote color, and the send form with its options and extensions (wand) buttons. The characters are SillyTavern's own Seraphina and Coding Sensei; see `THIRD_PARTY_NOTICES.md` for the image credits. To use other characters, replace the files in `assets/st/` with art you have the rights to.

```
index.html              the whole animation: closed-form springs, cyclic tracks, color floods, seek(t)
scripts/render.mjs      Playwright: seek(t) per subframe -> ffmpeg tmix -> 60fps MP4, then a looping GIF
scripts/mix_audio.mjs   synthesized groove and UI sounds, placed on the cues index.html exports
assets/fonts/           Be Vietnam Pro and JetBrains Mono (SIL Open Font License 1.1)
```

The operating system marks in the outro come from Simple Icons (CC0 1.0) and are inlined in `index.html`.

## Preview

Open `index.html` in a browser. Add `?lang=vi` for Vietnamese, or `?t=7.5` to freeze one moment.

## Render

You need Node.js 22+, ffmpeg and Playwright with Chromium (`npm i -D playwright`, or a global install on `NODE_PATH`).

```bash
node scripts/render.mjs beats en   # out/beats-en.png, one frame per beat, to check the timeline
node scripts/mix_audio.mjs en      # out/mix-en.wav (reads out/cues-en.json from the step above)
node scripts/render.mjs full en    # out/stm-promo-en.mp4 (with audio) and out/stm-promo-en.gif
```

Use `vi` in place of `en` for Vietnamese. These environment variables tune the output:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKERS` | 4 | Parallel browser pages |
| `SUB` | 2 | Subframes blended into each output frame (motion blur) |
| `GIF_SIZE` | 400 | GIF width and height in pixels |
| `GIF_FPS` | 15 | GIF frame rate |

The rendered files go to `out/` and the frames go to `tmp/`. Git ignores both folders.
