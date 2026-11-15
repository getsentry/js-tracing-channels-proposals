/**
 * Lifecycle invariant matrix for the `express.router.request` channel (pillarjs/router#223).
 * Dimensions and invariants are described in SKILL.md, "Lifecycle invariant matrix".
 * Usage: node router-invariant-matrix.js <router dir>
 */
const dc = require('node:diagnostics_channel')
const http = require('node:http')
const Router = require(process.argv[2])

const events = []
const rec = (phase) => (ctx) => events.push({
  phase, name: ctx.handler.name, hasResult: 'result' in ctx, hasError: 'error' in ctx, error: ctx.error
})
dc.tracingChannel('express.router.request').subscribe({
  start: rec('start'), end: rec('end'), asyncStart: rec('asyncStart'), asyncEnd: rec('asyncEnd'), error: rec('error')
})

const OUTCOMES = {
  'next()': { act: (req, next) => { next(); return 'value' }, fails: false, newErrors: 0 },
  'throw new': { act: () => { throw new Error('new') }, fails: true, newErrors: 1 },
  'throw seen': { act: (req) => { throw req.failure }, fails: true, newErrors: 0 },
  'next(new)': { act: (req, next) => { next(new Error('new')) }, fails: true, newErrors: 1 },
  'next(seen)': { act: (req, next) => { next(req.failure) }, fails: false, newErrors: 0 }, // forwarding
  'next(new)+throw new': { act: (req, next) => { next(new Error('n1')); throw new Error('n2') }, fails: true, newErrors: 2 }
}
const MODES = ['sync', 'async', 'async-after-await']
const KINDS = ['handler', 'error handler', 'param']

function makeSubject (kind, mode, act) {
  if (kind === 'error handler') {
    if (mode === 'sync') return function subject (err, req, res, next) { return act(req, next) }
    if (mode === 'async') return async function subject (err, req, res, next) { return act(req, next) }
    return async function subject (err, req, res, next) { await null; return act(req, next) }
  }
  if (mode === 'sync') return function subject (req, res, next) { return act(req, next) }
  if (mode === 'async') return async function subject (req, res, next) { return act(req, next) }
  return async function subject (req, res, next) { await null; return act(req, next) }
}

async function runCase (kind, mode, outcomeName) {
  const outcome = OUTCOMES[outcomeName]
  const router = new Router()
  const subject = makeSubject(kind, mode, outcome.act)

  router.use(function fail (req, res, next) { req.failure = new Error('seen'); next(req.failure) })
  if (kind === 'error handler') {
    router.use(subject)
  } else {
    router.use(function swallow (err, req, res, next) { next() })
    if (kind === 'param') router.param('id', subject)
    router.get('/u/:id', kind === 'handler' ? subject : function user (req, res) { res.end('ok') })
  }
  router.use(function last (err, req, res, next) { if (!res.headersSent) { res.statusCode = 500; res.end(err.message) } })

  events.length = 0
  const server = http.createServer((req, res) => router(req, res, () => { if (!res.headersSent) res.end('done') }))
  await new Promise((resolve) => server.listen(0, resolve))
  try {
    await fetch(`http://localhost:${server.address().port}/u/1`, { signal: AbortSignal.timeout(2000) })
  } catch (e) { return [`request failed: ${e.message}`] }
  finally { server.close() }
  await new Promise((resolve) => setTimeout(resolve, 20))

  const problems = []
  const mine = events.filter((e) => e.name === 'subject')
  const phases = mine.map((e) => e.phase)
  const count = (p) => phases.filter((x) => x === p).length
  if (count('start') !== 1 || count('end') !== 1) problems.push(`start/end count ${count('start')}/${count('end')}`)

  const end = mine.find((e) => e.phase === 'end')
  const asyncEnd = mine.find((e) => e.phase === 'asyncEnd')
  const done = end && (end.hasResult || end.hasError)
  // terminal signal
  if (done && (count('asyncStart') || count('asyncEnd'))) problems.push('end looked done but asyncEnd followed')
  if (end && !done && count('asyncEnd') !== 1) problems.push('end not done and no asyncEnd: span never ends')
  if (asyncEnd && phases.indexOf('asyncEnd') < phases.indexOf('end')) problems.push('asyncEnd before end')

  const terminal = done ? end : asyncEnd
  if (terminal) {
    if (outcome.fails && !terminal.hasError) problems.push(`failed but no error at ${terminal.phase}`)
    if (!outcome.fails && !terminal.hasError && !terminal.hasResult) problems.push(`no result at ${terminal.phase}`)
  }

  // error channel: once per new error, at its origin
  const subjectErrors = mine.filter((e) => e.phase === 'error').length
  if (subjectErrors !== outcome.newErrors) problems.push(`subject published ${subjectErrors} errors, expected ${outcome.newErrors}`)
  const allErrors = events.filter((e) => e.phase === 'error')
  const failErrors = allErrors.filter((e) => e.name === 'fail').length
  if (failErrors !== 1) problems.push(`fail published ${failErrors} errors`)
  const others = allErrors.filter((e) => e.name !== 'fail' && e.name !== 'subject')
  if (others.length) problems.push(`errors published on ${others.map((e) => e.name).join(',')}`)

  return problems.map((p) => `${p}   [${phases.join(' ')}]`)
}

;(async () => {
  let total = 0; let failed = 0
  for (const kind of KINDS) for (const mode of MODES) for (const outcome of Object.keys(OUTCOMES)) {
    total++
    const problems = await runCase(kind, mode, outcome)
    if (problems.length) {
      failed++
      console.log(`✗ ${kind} | ${mode} | ${outcome}`)
      for (const p of problems) console.log(`    ${p}`)
    }
  }
  console.log(`\n${total - failed}/${total} cases ok`)
})()
