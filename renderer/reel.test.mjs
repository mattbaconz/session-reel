// node --test renderer/
import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'
import { esc, loadSounds, mix, modelName, plan, promptText, redact, scene, script, stats, THEMES, toolSummary, typed, wrapPx } from './reel.mjs'

test('redact masks secrets, emails and the home folder', () => {
  const home = os.homedir()
  const out = redact(`key sk-ant-api03-abcdefghijklmnopqrstuv mail me@example.com at ${home}/x token=hunter22 C:\\Users\\SOMEONE~1\\y`)
  assert.ok(!out.includes('sk-ant'), out)
  assert.ok(!out.includes('me@example.com'), out)
  assert.ok(!out.includes(home), out)
  assert.ok(!out.includes('hunter22'), out)
  assert.ok(!out.includes('SOMEONE'), out)
})

test('prompts: slash commands kept, injected tag blocks dropped', () => {
  assert.equal(promptText('<command-name>/reel</command-name><command-args>--vertical</command-args>'), '/reel --vertical')
  assert.equal(promptText('<system-reminder>noise</system-reminder>fix the bug'), 'fix the bug')
  assert.equal(promptText([{ type: 'text', text: '[Request interrupted by user]' }]), '')
})

test('wrapPx fits width and caps lines', () => {
  const m = s => s.length * 10
  const lines = wrapPx('a'.repeat(25) + ' bb cc dd', 100, m, 3)
  assert.equal(lines.length, 3)
  assert.ok(lines.every(l => m(l) <= 100), lines.join('|'))
  assert.ok(lines[2].endsWith('…'))
})

test('esc keeps braces and backslashes literal for libass', () => {
  assert.equal(esc('{x}'), '\\{x\\}')
  assert.equal(esc('C:\\new'), 'C:\\\u2060new')
})

test('tool rows read like the desktop app', () => {
  const t = (tool, failed = false) => ({ tool, failed, add: 0, del: 0 })
  assert.equal(toolSummary([t('Bash'), t('Bash'), t('Read'), t('Write', true)]), 'Ran 2 commands, read a file, created a file (1 failed)')
  assert.equal(toolSummary([t('Skill'), t('Agent')]), 'Ran skill, ran an agent')
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
})

test('plan fits a long session into the feed and merges bursts', () => {
  const t0 = Date.parse('2026-10-27T10:00:00Z')
  const events = [{ t: t0, kind: 'prompt', text: 'build it' }]
  for (let i = 1; i <= 2000; i++) events.push({ t: t0 + i * 1000, kind: 'tool', tool: 'Bash', detail: 'ls', add: 0, del: 0 })
  const steps = plan(events, 50)
  const total = steps.reduce((a, s) => a + s.dur, 0)
  assert.ok(total < 60, `feed ran ${total}s`)
  assert.ok(steps.every(s => s.dur >= 0.3), 'every step leaves time to ease')
  assert.equal(stats(events).tools, 2000)
})

test('many prompts still fit the requested length', () => {
  const t0 = Date.parse('2026-10-27T10:00:00Z'), events = []
  for (let i = 0; i < 45; i++) events.push({ t: t0 + i * 60e3, kind: 'prompt', text: 'x'.repeat(80) }, { t: t0 + i * 60e3 + 9e3, kind: 'say', text: 'y'.repeat(200) })
  const total = plan(events, 53).reduce((a, s) => a + s.dur, 0)
  assert.ok(total <= 53.01, `feed ran ${total}s`)
})

test('a cut-off last line always ends in an ellipsis', () => {
  const m = s => s.length * 10
  const lines = wrapPx('aaaaaaaaa bbbbbbbbbb cccccccccc', 100, m, 2)
  assert.equal(lines.length, 2)
  assert.ok(lines[1].endsWith('…') && m(lines[1]) <= 100, lines.join('|'))
})

test('typing resumes part-way instead of starting over', () => {
  const ks = s => [...s.matchAll(/\\k(\d+)/g)].map(m => Number(m[1]))
  const whole = ks(typed([['abcd', '#FFFFFF']], 10, 5))
  const later = ks(typed([['abcd', '#FFFFFF']], 10, 5, 22))
  assert.deepEqual(whole, [10, 5, 5, 5, 5])
  assert.deepEqual(later, [0, 0, 0, 3, 5]) // two letters already typed by 22cs
})

test('the camera cuts a held item into zoomed pieces', () => {
  const s = scene(1920, 1080)
  s.add({ start: 0, end: 2, x: 100, y: 100, body: 'x' })
  s.camera(0.5, 1.5, { z: 2, cx: 960, cy: 540 })
  const lines = s.lines().split('\n')
  assert.ok(lines.length > 10, String(lines.length))
  assert.match(lines.at(-1), /fscx200/)
})

test('the mixer places one-shots in time and loops a bed for its duration', () => {
  const click = new Float32Array(480).fill(0.5)
  const buf = mix([{ t: 0.5, sound: 'enter' }, { t: 1, sound: 'typing', dur: 0.5 }], 2, { enter: [{ rate: 48000, samples: click }], typing: [{ rate: 48000, samples: click }] }, 1)
  const at = t => Math.abs(buf[Math.round(t * 48000)])
  assert.equal(at(0.4), 0)
  assert.ok(at(0.502) > 0)
  assert.ok(at(1.3) > 0, 'bed still playing')
  assert.equal(at(1.6), 0)
})

test('the bundled sounds load', () => {
  const sounds = loadSounds()
  for (const name of ['typing', 'enter', 'pages', 'knock']) assert.ok(sounds[name]?.[0]?.samples.length > 1000, name)
})

for (const theme of Object.keys(THEMES)) {
  for (const vertical of [false, true]) {
    test(`script builds an ASS file (${theme}, ${vertical ? '9:16' : '16:9'})`, () => {
      const t0 = Date.parse('2026-10-27T10:00:00Z')
      const events = [
        { t: t0, kind: 'prompt', text: 'make a {mod}' },
        { t: t0 + 5e3, kind: 'tool', tool: 'Edit', detail: 'a.ts', add: 3, del: 1, file: 'a.ts', model: 'claude-opus-5-5' },
        { t: t0 + 9e3, kind: 'say', text: 'done' },
        { t: t0 + 20e3, kind: 'prompt', text: 'now the video' },
      ]
      const s = script({ events, cwd: '/w/proj', title: 'Demo' }, { length: 20, theme, vertical })
      assert.match(s.ass, /^\[Script Info\]/)
      assert.ok(s.ass.includes('\\{mod\\}'))
      assert.equal(s.W, vertical ? 1080 : 1920)
      assert.equal(s.stats.files, 1)
      assert.ok(s.seconds > 6 && s.seconds < 25, String(s.seconds))
    })
  }
}
