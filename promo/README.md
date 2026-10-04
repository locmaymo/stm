# STM promo

A 19.2-second motion-graphics loop of SillyTavern Manager's main features. It has 8 bars at 100 BPM, in English and Vietnamese.

The shape on screen never cuts. It morphs from one UI to the next while each section floods the canvas with a new color from the cursor. The last frame is identical to the first, so the MP4 and the GIF loop seamlessly.

Every component is a light card with one idea and as little text as possible.

| Beats | Section |
| --- | --- |
| 0–4 | Intro: the logo is clicked and opens into the brand pill |
| 4–8 | 01 Quick install: an install button, a progress bar, a green "Ready" pill |
| 8–12 | 02 Pick any version: the version list opens and 1.17.0 is picked |
| 12–16 | 03 Bring your old data: a backup ZIP is dragged in and restored |
| 16–20 | 04 Cloud backup: a switch turns on and the pill becomes a progress ring with a check |
| 20–24 | 05 Chat bubbles (Android): a character chat head pops a badge and opens into a chat |
| 24–28 | 06 Open on iPhone and any device: a QR code is scanned, the phone takes the PIN and unlocks |
| 28–32 | Outro: brand pill, platforms, the website, then back to the logo |

```
index.html              the whole animation: closed-form springs, cyclic tracks, color floods, seek(t)
scripts/render.mjs      Playwright: seek(t) per subframe -> ffmpeg tmix -> 60fps MP4, then a looping GIF
scripts/mix_audio.mjs   synthesized groove and UI sounds, placed on the cues index.html exports
assets/fonts/           Be Vietnam Pro and JetBrains Mono (SIL Open Font License 1.1)
```

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
| `GIF_SIZE` | 540 | GIF width and height in pixels |
| `GIF_FPS` | 25 | GIF frame rate |

The rendered files go to `out/` and the frames go to `tmp/`. Git ignores both folders.
