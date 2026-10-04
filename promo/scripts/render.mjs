// Renders index.html by calling seek(t) for every subframe with Playwright.
//
//   node scripts/render.mjs beats [en|vi]      -> out/beats-<lang>.png, one frame per beat
//   node scripts/render.mjs still 3.2 [en|vi]  -> out/still-<lang>.png at t seconds
//   node scripts/render.mjs full [en|vi]       -> out/stm-promo-<lang>.mp4 (60fps, subframes blended)
//                                                 and out/stm-promo-<lang>.gif (small, cut from the MP4)
//   node scripts/render.mjs gif [en|vi]        -> out/stm-promo-<lang>-hq.gif, rendered at its own frame rate
//                                                 (50fps by default, the fastest GIF delay players honor)
//
// Writes out/cues-<lang>.json so scripts/mix_audio.mjs can place every UI sound on its event.
// Needs Playwright (npm i -D playwright, or a global install on NODE_PATH) and ffmpeg.
/* global window, document -- the page.evaluate callbacks run in the browser */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'out')
const FPS = 60
const SUB = Number(process.env.SUB || 2)
const WORKERS = Number(process.env.WORKERS || 4)
const SIZE = 1080
const GIF_SIZE = Number(process.env.GIF_SIZE || 400)
const GIF_FPS = Number(process.env.GIF_FPS || 15)
// GIF delays are counted in hundredths of a second and players stretch anything under 2, so 50fps is the ceiling;
// frame rates that do not divide 100 (like 60) play unevenly
const HQ_FPS = Number(process.env.HQ_FPS || 50)
const HQ_SIZE = Number(process.env.HQ_SIZE || 720)

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${cmd} ${args.join(' ')}`)
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })
}

async function openPage(browser, lang) {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
  await page.addInitScript(() => { window.__RENDER__ = true })
  page.on('pageerror', (e) => console.error('pageerror', e))
  await page.goto('file://' + path.join(root, 'index.html') + '?lang=' + lang)
  // touch every section once so each font subset is requested, then wait for them
  await page.evaluate(async () => {
    for (let t = 0; t < window.timeline().duration; t += 0.3) window.seek(t)
    await document.fonts.ready
    await window.ready
  })
  return page
}

async function shot(page, t, file) {
  await page.evaluate((tt) => window.seek(tt), t)
  await page.locator('#stage').screenshot({ path: file, type: 'png', animations: 'disabled' })
}

// every subframe of the loop at fps * SUB, split across WORKERS pages
async function renderFrames(browser, first, lang, duration, fps, dir) {
  const total = Math.round(duration * fps) * SUB
  const pages = [first, ...(await Promise.all(Array.from({ length: WORKERS - 1 }, () => openPage(browser, lang))))]
  let done = 0
  const started = Date.now()
  await Promise.all(pages.map(async (page, w) => {
    for (let i = w; i < total; i += WORKERS) {
      // subframes centered on each output frame: the shutter spans one full frame
      const t = (i - (SUB - 1) / 2) / (fps * SUB)
      await shot(page, t, path.join(dir, `${String(i).padStart(6, '0')}.png`))
      done++
      if (done % 200 === 0) console.log(`subframe ${done}/${total} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
    }
  }))
  console.log(`rendered ${total} subframes`)
}

async function main() {
  const mode = process.argv[2] || 'beats'
  const lang = ['en', 'vi'].includes(process.argv.at(-1)) ? process.argv.at(-1) : 'en'
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch()
  const first = await openPage(browser, lang)
  const tl = await first.evaluate(() => window.timeline())
  fs.writeFileSync(path.join(outDir, `cues-${lang}.json`), JSON.stringify(tl, null, 2))
  console.log(`lang=${lang} beat=${tl.beat.toFixed(4)}s duration=${tl.duration.toFixed(3)}s cues=${tl.cues.length}`)

  if (mode === 'still') {
    const t = Number(process.argv[3] || 0)
    await shot(first, t, path.join(outDir, `still-${lang}.png`))
    console.log(`wrote out/still-${lang}.png`)
  } else if (mode === 'beats') {
    // one frame per beat, sampled late in the beat so the state has settled
    const dir = path.join(root, 'tmp', 'beats')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const offset = Number(process.env.OFFSET ?? 0.7)
    for (let b = 0; b < tl.beats; b++) {
      await shot(first, (b + offset) * tl.beat, path.join(dir, `${String(b).padStart(2, '0')}.png`))
    }
    await run('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, '%02d.png'),
      '-vf', `scale=270:270,tile=8x${Math.ceil(tl.beats / 8)}`, '-frames:v', '1', path.join(outDir, `beats-${lang}.png`)])
    console.log(`wrote out/beats-${lang}.png`)
  } else if (mode === 'full') {
    const framesDir = path.join(root, 'tmp', `frames-${lang}`)
    fs.rmSync(framesDir, { recursive: true, force: true })
    fs.mkdirSync(framesDir, { recursive: true })
    await renderFrames(browser, first, lang, tl.duration, FPS, framesDir)
    const audio = path.join(outDir, `mix-${lang}.wav`)
    const hasAudio = fs.existsSync(audio)
    const mp4 = path.join(outDir, `stm-promo-${lang}.mp4`)
    await run('ffmpeg', [
      '-v', 'error', '-y', '-framerate', String(FPS * SUB), '-i', path.join(framesDir, '%06d.png'),
      ...(hasAudio ? ['-i', audio] : []),
      '-vf', `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/(${FPS}*TB)`,
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
      '-movflags', '+faststart', mp4,
    ])
    console.log(`wrote ${path.relative(root, mp4)}${hasAudio ? ' (with audio)' : ''}`)
    // the GIF is cut from the blended video so it keeps the motion blur; the loop is seamless by construction
    const gif = path.join(outDir, `stm-promo-${lang}.gif`)
    await run('ffmpeg', [
      '-v', 'error', '-y', '-i', mp4,
      '-filter_complex', `fps=${GIF_FPS},scale=${GIF_SIZE}:${GIF_SIZE}:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`,
      '-loop', '0', gif,
    ])
    console.log(`wrote ${path.relative(root, gif)}`)
  } else if (mode === 'gif') {
    // a smooth GIF for hosts that take large uploads: its own frames, blended like the MP4,
    // and a palette per frame so the color floods and gradients do not band
    const framesDir = path.join(root, 'tmp', `gif-${lang}`)
    fs.rmSync(framesDir, { recursive: true, force: true })
    fs.mkdirSync(framesDir, { recursive: true })
    await renderFrames(browser, first, lang, tl.duration, HQ_FPS, framesDir)
    const gif = path.join(outDir, `stm-promo-${lang}-hq.gif`)
    await run('ffmpeg', [
      '-v', 'error', '-y', '-framerate', String(HQ_FPS * SUB), '-i', path.join(framesDir, '%06d.png'),
      '-filter_complex', `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/(${HQ_FPS}*TB),scale=${HQ_SIZE}:${HQ_SIZE}:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a:diff_mode=rectangle`,
      '-r', String(HQ_FPS), '-loop', '0', gif,
    ])
    console.log(`wrote ${path.relative(root, gif)} (${(fs.statSync(gif).size / 1e6).toFixed(1)} MB)`)
  }
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
