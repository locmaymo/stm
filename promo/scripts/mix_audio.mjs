// Synthesizes a loopable 8-bar groove and the UI sounds, placed on the cues index.html exports.
//
//   node scripts/mix_audio.mjs [en|vi]   reads out/cues-<lang>.json, writes out/mix-<lang>.wav
//
// No samples and no dependencies: every sound is a few oscillators and envelopes.
// Anything that rings past the end wraps to the start, so the audio loops with the video.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const lang = process.argv[2] === 'vi' ? 'vi' : 'en'
const tl = JSON.parse(fs.readFileSync(path.join(root, 'out', `cues-${lang}.json`), 'utf8'))
const SR = 44100
const N = Math.round(tl.duration * SR)
const B = tl.beat
const L = new Float32Array(N), R = new Float32Array(N)

// seeded noise so every render is identical
let seed = 12345
const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12)

// add a mono voice at time t (seconds) with pan -1..1; fn(i, sec) returns a sample
function add(t, dur, fn, gain = 1, pan = 0) {
  const s0 = Math.round(t * SR), n = Math.round(dur * SR)
  const gl = gain * Math.sqrt((1 - pan) / 2), gr = gain * Math.sqrt((1 + pan) / 2)
  for (let i = 0; i < n; i++) {
    const v = fn(i, i / SR)
    const k = (((s0 + i) % N) + N) % N
    L[k] += v * gl; R[k] += v * gr
  }
}

// ---------- groove ----------
const kickEnv = new Float32Array(N) // for sidechain ducking
function kick(t, g = 1) {
  let ph = 0
  add(t, 0.45, (i, s) => {
    const f = 45 + 110 * Math.exp(-s * 28)
    ph += (2 * Math.PI * f) / SR
    return Math.sin(ph) * Math.exp(-s * 7) * (1 + 0.4 * Math.exp(-s * 80))
  }, 0.9 * g)
  const s0 = Math.round(t * SR)
  for (let i = 0; i < 0.3 * SR; i++) { const k = (s0 + i) % N; kickEnv[k] = Math.max(kickEnv[k], Math.exp(-i / SR * 9)) }
}
function clap(t) {
  let lp = 0, hp = 0
  add(t, 0.25, (i, s) => {
    const x = noise()
    lp += 0.35 * (x - lp); hp = x - lp
    const env = (s < 0.01 ? 1 : 0.6) * Math.exp(-s * 22) + 0.25 * Math.exp(-((s - 0.012) ** 2) * 1e5)
    return hp * env
  }, 0.32, 0.1)
}
function hat(t, g = 1) {
  let p = 0
  add(t, 0.06, (i, s) => { const x = noise(); const h = x - p; p = x; return h * Math.exp(-s * 70) }, 0.13 * g, -0.25)
}
// a soft supersaw-ish pad from a few detuned triangle partials
function pad(t, dur, notes) {
  for (const m of notes) for (const det of [-0.08, 0.08]) {
    const f = mtof(m + det)
    add(t, dur + 0.4, (i, s) => {
      const a = Math.min(1, s / 0.25) * (s > dur ? Math.exp(-(s - dur) * 8) : 1)
      const ph = 2 * Math.PI * f * s
      return a * (Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.08 * Math.sin(3 * ph))
    }, 0.028, det < 0 ? -0.5 : 0.5)
  }
}
function bass(t, dur, m) {
  const f = mtof(m)
  add(t, dur, (i, s) => {
    const a = Math.min(1, s / 0.005) * Math.exp(-s * 5) * (s > dur - 0.02 ? Math.max(0, (dur - s) / 0.02) : 1)
    const ph = 2 * Math.PI * f * s
    return a * (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph))
  }, 0.33)
}
function pluck(t, m, g = 1, pan = 0) {
  const f = mtof(m)
  add(t, 0.5, (i, s) => {
    const ph = 2 * Math.PI * f * s
    return Math.exp(-s * 9) * (Math.sin(ph) + 0.3 * Math.exp(-s * 20) * Math.sin(3 * ph))
  }, 0.085 * g, pan)
}

// F G Am Em | F G C C  (one chord per bar)
const CHORDS = [
  { root: 41, pad: [53, 57, 60, 64] }, { root: 43, pad: [55, 59, 62, 64] },
  { root: 45, pad: [57, 60, 64, 67] }, { root: 40, pad: [52, 55, 59, 62] },
  { root: 41, pad: [53, 57, 60, 64] }, { root: 43, pad: [55, 59, 62, 65] },
  { root: 36, pad: [55, 60, 64, 67] }, { root: 36, pad: [55, 60, 64, 71] },
]
const ARP = [0, 2, 1, 3, 2, 1, 3, 2]
for (let bar = 0; bar < 8; bar++) {
  const t0 = bar * 4 * B, ch = CHORDS[bar]
  const last = bar === 7
  pad(t0, 4 * B - 0.05, ch.pad)
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * B
    const fill = last && b >= 2 // drop the kick for the turnaround so beat 0 lands hard
    if (!fill) kick(t)
    if (b % 2 === 1) clap(t)
    hat(t + B / 2)
    if (b % 2 === 0) hat(t + B * 0.75, 0.5)
    bass(t, B * 0.45, ch.root + 12)
    bass(t + B / 2, B * 0.4, ch.root + (b % 2 ? 19 : 24))
  }
  for (let k = 0; k < 8; k++) pluck(t0 + k * B / 2, ch.pad[ARP[k]] + 12, k % 2 ? 0.7 : 1, k % 2 ? 0.35 : -0.35)
}
// turnaround riser into beat 0, and a soft crash on it
add(30 * B, 2 * B, (i, s) => {
  const p = s / (2 * B)
  return noise() * p * p * 0.5
}, 0.22)
{
  let p = 0
  add(0, 1.6, (i, s) => { const x = noise(); const h = x - p; p = x; return h * Math.exp(-s * 2.6) }, 0.12)
}

// sidechain: everything but the kick ducks under it
function duck() {
  for (let k = 0; k < N; k++) { const g = 1 - 0.55 * kickEnv[k]; L[k] *= g; R[k] *= g }
}
duck()
// kicks were ducked too; put them back on top at full level
for (let bar = 0; bar < 8; bar++) for (let b = 0; b < 4; b++) {
  if (bar === 7 && b >= 2) continue
  kick((bar * 4 + b) * B, 0.55)
}

// ---------- UI sounds, each with its peak on the cue ----------
const UI = {
  click: (t) => {
    add(t - 0.004, 0.05, (i, s) => Math.sin(2 * Math.PI * 2200 * s) * Math.exp(-s * 160) + 0.3 * noise() * Math.exp(-s * 400), 0.22)
  },
  tick: (t, c) => {
    const f = c.key ? 1500 : 3200 + 400 * noise()
    add(t, 0.03, (i, s) => (0.6 * noise() + Math.sin(2 * Math.PI * f * s)) * Math.exp(-s * 260), c.key ? 0.16 : 0.07, 0.2)
  },
  pop: (t, c) => {
    let ph = 0
    add(t - 0.01, 0.12, (i, s) => { ph += 2 * Math.PI * (500 + 900 * Math.min(1, s / 0.04)) / SR; return Math.sin(ph) * Math.exp(-s * 30) }, c.soft ? 0.09 : 0.2)
  },
  msg: (t, c) => {
    const f = c.out ? 880 : 660
    add(t, 0.25, (i, s) => Math.sin(2 * Math.PI * f * s) * Math.exp(-s * 18) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * s) * Math.exp(-s * 26), 0.12, c.out ? 0.3 : -0.3)
  },
  swish: (t, c) => {
    // band-passed noise sweeping up, peaking on the cue
    let lo = 0, bp = 0
    const dur = 0.34
    add(t - dur * 0.7, dur, (i, s) => {
      const p = s / dur
      const fc = 400 + 5000 * p * p
      const f = 2 * Math.sin(Math.PI * fc / SR)
      const hi = noise() - lo - 0.6 * bp
      bp += f * hi; lo += f * bp
      return bp * Math.sin(Math.PI * p) ** 2
    }, c.soft ? 0.05 : 0.11)
  },
  press: (t) => UI.click(t),
  drop: (t) => {
    add(t, 0.2, (i, s) => Math.sin(2 * Math.PI * (180 - 80 * s) * s) * Math.exp(-s * 25), 0.4)
    UI.pop(t + 0.03, {})
  },
  success: (t) => {
    for (const [dt, m] of [[0, 88], [0.08, 95]]) add(t + dt, 0.6, (i, s) => {
      const ph = 2 * Math.PI * mtof(m) * s
      return (Math.sin(ph) + 0.2 * Math.sin(2 * ph)) * Math.exp(-s * 7)
    }, 0.09)
  },
}
for (const c of tl.cues) UI[c.kind]?.(c.t, c)

// ---------- master: normalize, soft clip, 16-bit WAV ----------
let peak = 0
for (let k = 0; k < N; k++) peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]))
const g = 0.9 / peak
const buf = Buffer.alloc(44 + N * 4)
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8)
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40)
for (let k = 0; k < N; k++) {
  buf.writeInt16LE(Math.round(Math.tanh(L[k] * g * 1.1) * 32000), 44 + k * 4)
  buf.writeInt16LE(Math.round(Math.tanh(R[k] * g * 1.1) * 32000), 46 + k * 4)
}
const out = path.join(root, 'out', `mix-${lang}.wav`)
fs.writeFileSync(out, buf)
console.log(`wrote ${path.relative(root, out)} (${tl.duration.toFixed(2)} s, ${tl.cues.length} cues)`)
