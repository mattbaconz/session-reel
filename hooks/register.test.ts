import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const typed = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

// Stands in for the engine under /reel: the session, the renderer process and the UI it reports to.
function engine(on: On, output: { stream: 'stdout' | 'stderr'; text: string }[], code = 0) {
  const seen = { argv: [] as readonly string[], statuses: [] as (string | undefined)[], toast: '' }
  let toasted = () => {}
  const toast = new Promise<void>(resolve => { toasted = resolve })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: '3f2a9c1e-7b1d-4c2a-9e55-0a1b2c3d4e5f' }))
  on('session.cwd', () => ({ value: '/work/proj' }))
  on('process.spawn', async function* (_, e) {
    seen.argv = e.argv
    for (const chunk of output) yield chunk
    return { value: { code, signal: null } }
  })
  on('ui.status', (_, e) => { seen.statuses.push(e.text); return { value: undefined } })
  on('ui.toast', (_, e) => { seen.toast = e.text; toasted(); return { value: undefined } })
  return { seen, toast }
}

test('/reel renders this session with the settings, and a typed flag wins', { options: { theme: 'paper' } }, async ($, on) => {
  const { seen, toast } = engine(on, [
    { stream: 'stdout', text: 'progress 40\n' },
    { stream: 'stdout', text: 'done /out/proj-16x9.mp4\ndone /out/proj-9x16.mp4\n' },
  ])
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })

  const answer = await $.command.run({ command: 'reel', args: '--format vertical', ...typed })
  expect(answer.text).toContain('3f2a9c1e')
  await toast

  const argv = [...seen.argv]
  expect(argv[0]).toBe('node')
  expect(argv[1]?.endsWith('/renderer/reel.mjs')).toBe(true)
  expect(argv[2]).toBe('3f2a9c1e-7b1d-4c2a-9e55-0a1b2c3d4e5f')
  expect(argv[argv.indexOf('--theme') + 1]).toBe('paper')
  expect(argv[argv.indexOf('--sound') + 1]).toBe('off') // silent unless turned on
  expect(argv[argv.lastIndexOf('--format') + 1]).toBe('vertical')
  expect(seen.statuses).toEqual(['reel 40%', undefined])
  expect(seen.toast).toBe('Reel saved: /out/proj-16x9.mp4 and /out/proj-9x16.mp4')
})

test('/reel says why a render failed', async ($, on) => {
  const { seen, toast } = engine(on, [{ stream: 'stderr', text: 'ffmpeg not found on PATH\n' }], 1)
  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'reel', args: '', ...typed })
  await toast
  expect(seen.toast).toBe('Reel failed: ffmpeg not found on PATH')
})

test('/reel help lists every flag', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })

  const answer = await $.command.run({ command: 'reel', args: 'help', ...typed })
  for (const flag of ['--theme', '--sound', '--volume', '--text', '--camera', '--accent', '--watermark', '--fps']) expect(answer.text).toContain(flag)
})
