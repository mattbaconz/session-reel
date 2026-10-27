import type { EngineInterface, Register } from 'claude-code'

const USAGE = [
  '/reel                      replay this session as 16:9 and 9:16 MP4s',
  '/reel <id>                 replay another session (ids from /reel list)',
  '/reel list                 recent sessions in this project',
  'options: --format both|horizontal|vertical  --theme desktop|desktop-light|paper|terminal  --length 60  --title "hook text"',
  '         --sound on|off  --volume 0-100  --text normal|large  --camera on|off  --accent #D97757  --watermark on|off  --fps 60|30',
  'defaults come from the plugin settings in /config',
].join('\n')

export const register: Register = (on, options) => {
  // Settings first, so flags typed after /reel win.
  const defaults = [
    '--theme', String(options.theme ?? 'desktop'),
    '--format', String(options.format ?? 'both'),
    '--length', String(options.length ?? 60),
    '--sound', String(options.sound ?? 'off'),
    '--volume', String(options.volume ?? 80),
    '--text', String(options.text ?? 'normal'),
    '--camera', String(options.camera ?? 'on'),
    '--watermark', String(options.watermark ?? 'on'),
    '--fps', String(options.fps ?? 60),
    ...(options.accent ? ['--accent', String(options.accent)] : []),
  ]

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reel',
      description: 'Turn this session (or a past one) into an MP4 replay',
    })

    return next(e)
  })

  on('command.run', { command: 'reel' }, async ($, e) => {
    const words = (e.args.match(/"[^"]*"|\S+/g) ?? []).map(w => w.replace(/^"(.*)"$/, '$1'))
    const script = `${$.plugin.root}/renderer/reel.mjs`
    if (words[0] === 'help') return { text: USAGE }
    if (words[0] === 'list') {
      const listed = await $.process.run(['node', script, 'list', '--cwd', await $.session.cwd()])

      return { text: listed.exitCode === 0 ? listed.stdout : listed.stderr || USAGE }
    }
    const session = !words[0] || words[0].startsWith('--') ? await $.session.id() : words.shift() ?? ''
    void render($, ['node', script, session, ...defaults, ...words])

    return { text: `Rendering a reel of session ${session.slice(0, 8)}. Progress is in the status line; a toast says where it saved.` }
  })
}

// Runs after the command has answered, so a long render never blocks the prompt.
async function render($: EngineInterface, argv: string[]) {
  const saved: string[] = []
  let failure = '', buffered = ''
  try {
    for await (const { stream, text } of $.process.spawn({ argv })) {
      if (stream === 'stderr') { failure += text; continue }
      const lines = (buffered + text).split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const pct = line.match(/^progress (\d+)/)
        if (pct) $.ui.status(`reel ${pct[1]}%`)
        const done = line.match(/^done (.+)/)
        if (done?.[1]) saved.push(done[1].trim())
      }
    }
  } catch (err) {
    failure ||= `${err} (session-reel needs Node 18+ and ffmpeg on PATH)`
  }
  $.ui.status(undefined)
  $.ui.toast(saved.length ? `Reel saved: ${saved.join(' and ')}` : `Reel failed: ${failure.trim().split('\n').pop() || 'no output'}`)
}
