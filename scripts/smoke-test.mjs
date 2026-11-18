/**
 * Host-half smoke test for @theoabw/dsh-secret-prompt.
 *
 * Loads the BUILT lib/index.js and drives its apply() against a minimal mock
 * cordis context: captures the registered tools, the shellEnv contributors,
 * and the post-execute listener, then verifies the full secret lifecycle
 * without any real harness. Run: node scripts/smoke-test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../lib/index.js')

/** Build a mock context that captures everything apply() touches. */
function mockContext(config) {
  const captured = {
    tools: new Map(), // name -> tool definition
    contributors: new Map(), // envKey -> contributor
    contributorDisposers: new Map(), // envKey -> disposer
    postExecuteListener: null,
    askedQuestions: null,
    systemPromptSections: [],
    effects: [],
  }
  let askAnswer = null
  const ctx = {
    shellEnv: {
      register(contributor) {
        const envKey = Object.keys(contributor.variables)[0]
        assert.ok(captured.contributors.has(envKey) === false, `duplicate contributor ${envKey}`)
        captured.contributors.set(envKey, contributor)
        const disposer = () => { captured.contributors.delete(envKey) }
        captured.contributorDisposers.set(envKey, disposer)
        return disposer
      },
    },
    tools: {
      register(tool) {
        assert.ok(!captured.tools.has(tool.name), `duplicate tool ${tool.name}`)
        captured.tools.set(tool.name, tool)
        return () => { captured.tools.delete(tool.name) }
      },
    },
    userQuestions: {
      async ask(request) {
        captured.askedQuestions = request
        if (askAnswer === null) throw new Error('test: no ask answer configured')
        return askAnswer
      },
    },
    on(name, listener) {
      assert.equal(name, 'tools/post-execute')
      captured.postExecuteListener = listener
      return () => { captured.postExecuteListener = null }
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') captured.effects.push(disposer)
      return () => { captured.effects.length = 0 }
    },
    systemPrompt: {
      section(section) {
        captured.systemPromptSections.push(section)
      },
    },
  }
  plugin.apply(ctx, config)
  return { captured, setAskAnswer: (answer) => { askAnswer = answer } }
}

/** A minimal exec carrier for the tools. */
function execFor(sessionId) {
  return {
    agent: { session: { header: { id: sessionId } } },
    signal: new AbortController().signal,
  }
}

const sessionId = 'sess-test-1'
const otherSession = 'sess-test-2'
const { captured, setAskAnswer } = mockContext({ ttlMinutes: 60, maxSecretsPerSession: 2, minRedactLength: 4 })

const promptSecret = captured.tools.get('prompt_secret')
const revokeSecret = captured.tools.get('revoke_secret')
assert.ok(promptSecret, 'prompt_secret tool registered')
assert.ok(revokeSecret, 'revoke_secret tool registered')
assert.equal(captured.systemPromptSections.length, 1, 'system prompt section registered')
assert.equal(captured.systemPromptSections[0].name, 'tool:secret-prompt')
assert.match(captured.systemPromptSections[0].text, /prompt_secret/, 'section steers agents to the tool')

/* 1. prompt_secret: question shape, answer stored, handle returned. */
setAskAnswer({ answers: [{ id: 'secret-0', selected: [], custom: 's3cr3t-value-123' }] })
const result = await promptSecret.execute({ prompt: 'GitHub token', hint: 'for repo push' }, execFor(sessionId))
assert.match(result.handle, /^[0-9A-F]{20}$/, `handle shape: ${result.handle}`)
assert.equal(result.env, `DSH_SECRET_${result.handle}`)
assert.equal(result.prompt, 'GitHub token')
assert.deepEqual(captured.askedQuestions.questions, [{
  id: 'secret-0',
  question: 'GitHub token',
  header: 'dsh-secret',
  detail: 'for repo push',
}])
assert.equal(captured.askedQuestions.agent.session.header.id, sessionId)
const value = captured.contributors.get(result.env).resolve(execFor(sessionId))[result.env]
assert.equal(value, 's3cr3t-value-123', 'contributor resolves the value for the owning session')
assert.deepEqual(
  captured.contributors.get(result.env).resolve(execFor(otherSession)),
  {},
  'contributor hides the value from other sessions',
)

/* 2. prompt_secret rejects a missing agent. */
await assert.rejects(() => promptSecret.execute({ prompt: 'x' }, { signal: new AbortController().signal }))

/* 3. post-execute redaction of plain content. */
const listener = captured.postExecuteListener
const accept = { kind: 'accept' }
const redacted = await listener(
  { name: 'bash' },
  { content: [{ type: 'text', text: 'token: s3cr3t-value-123 in line' }] },
  async () => accept,
)
assert.equal(redacted.kind, 'accept')
assert.equal(redacted.content[0].text, 'token: [redacted] in line')

/* 4. block feedback redaction. */
const blocked = await listener({ name: 'bash' }, { content: [] }, async () => ({
  kind: 'block',
  feedback: [{ type: 'text', text: 'leaked s3cr3t-value-123' }],
}))
assert.equal(blocked.kind, 'block')
assert.equal(blocked.feedback[0].text, 'leaked [redacted]')

/* 5. value-replacement redaction. */
const valueReplaced = await listener({ name: 'bash' }, { content: [] }, async () => ({
  kind: 'accept',
  value: { stdout: { text: 'x s3cr3t-value-123' } },
}))
assert.equal(valueReplaced.value.stdout.text, 'x [redacted]')

/* 5b. value-replacement redaction reaches string leaves inside arrays, and a
 * bare string value. The in-place walk skipped string nodes outright, so a
 * canonical value shaped as a string list leaked the secret verbatim. */
const arrayValue = await listener({ name: 'bash' }, { content: [] }, async () => ({
  kind: 'accept',
  value: { lines: ['x s3cr3t-value-123', { nested: 'y s3cr3t-value-123' }] },
}))
assert.deepEqual(
  arrayValue.value.lines,
  ['x [redacted]', { nested: 'y [redacted]' }],
  'array string leaves are redacted',
)
const stringValue = await listener({ name: 'bash' }, { content: [] }, async () => ({
  kind: 'accept',
  value: 'bare s3cr3t-value-123',
}))
assert.equal(stringValue.value, 'bare [redacted]', 'a bare string value is redacted')

/* 6. spill file scrubbing via structured spillPath. */
const dir = mkdtempSync(join(tmpdir(), 'secret-prompt-test-'))
try {
  const spill = join(dir, 'spill.log')
  writeFileSync(spill, 'big output with s3cr3t-value-123 inside')
  const scrubbed = await listener(
    { name: 'bash' },
    { content: [{ type: 'text', text: '[output truncated; full output: /unrelated]' }], value: { stdout: { spillPath: spill } } },
    async () => accept,
  )
  // Content was already clean, so the decision is returned unchanged (the
  // original result content is kept by the post-execute machinery); the
  // point of this case is the spill file scrub.
  assert.equal(scrubbed.content, undefined)
  assert.equal(readFileSync(spill, 'utf8'), 'big output with [redacted] inside', 'spill file scrubbed in place')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

/* 7. spill path discovery from textual notices (background jobs). */
const noticeDir = mkdtempSync(join(tmpdir(), 'secret-prompt-notice-'))
try {
  const spill = join(noticeDir, 'job.log')
  writeFileSync(spill, 'job output s3cr3t-value-123 tail')
  const scrubbed = await listener(
    { name: 'job_output' },
    { content: [{ type: 'text', text: `delta\n[some output was dropped from memory; full output: ${spill}]` }] },
    async () => accept,
  )
  assert.equal(readFileSync(spill, 'utf8'), 'job output [redacted] tail', 'noticed spill file scrubbed')
} finally {
  rmSync(noticeDir, { recursive: true, force: true })
}

/* 8. revoke_secret forgets the value and stops redaction. */
const revokeResult = await revokeSecret.execute({ handle: result.handle }, execFor(sessionId))
assert.equal(revokeResult.revoked, result.handle)
assert.equal(captured.contributors.get(result.env), undefined, 'env contributor disposed')
const untouched = await listener({ name: 'bash' }, { content: [{ type: 'text', text: 's3cr3t-value-123' }] }, async () => accept)
assert.equal(untouched.content, undefined, 'no redaction decision after revoke (original content kept)')
assert.equal(await revokeSecret.execute({ handle: result.handle }, execFor(sessionId)).then((r) => r.revoked), result.handle, 'revoke is idempotent')

/* 1b. multi-field: one dialog, one handle per field, group title in the first header. */
setAskAnswer({ answers: [
  { id: 'secret-0', selected: [], custom: 'AKIA-TEST-KEY' },
  { id: 'secret-1', selected: [], custom: 's3-secret-value' },
] })
const multiResult = await promptSecret.execute({
  prompt: 'S3 credentials',
  fields: [
    { prompt: 'Access key ID', hint: 'from the AWS console' },
    { prompt: 'Secret access key' },
  ],
}, execFor(sessionId))
assert.deepEqual(captured.askedQuestions.questions, [
  { id: 'secret-0', question: 'Access key ID', header: 'dsh-secret: S3 credentials', detail: 'from the AWS console' },
  { id: 'secret-1', question: 'Secret access key', header: 'dsh-secret' },
])
assert.equal(multiResult.prompt, 'S3 credentials')
assert.equal(multiResult.secrets.length, 2)
assert.equal(multiResult.secrets[0].key, 'Access key ID')
assert.equal(multiResult.secrets[1].key, 'Secret access key')
assert.match(multiResult.secrets[0].handle, /^[0-9A-F]{20}$/)
assert.equal(multiResult.secrets[0].env, `DSH_SECRET_${multiResult.secrets[0].handle}`)
assert.equal(multiResult.secrets[1].env, `DSH_SECRET_${multiResult.secrets[1].handle}`)
assert.equal(
  captured.contributors.get(multiResult.secrets[0].env).resolve(execFor(sessionId))[multiResult.secrets[0].env],
  'AKIA-TEST-KEY',
  'first field value injected for the owning session',
)
assert.equal(
  captured.contributors.get(multiResult.secrets[1].env).resolve(execFor(sessionId))[multiResult.secrets[1].env],
  's3-secret-value',
  'second field value injected for the owning session',
)
await revokeSecret.execute({ handle: multiResult.secrets[0].handle }, execFor(sessionId))
await revokeSecret.execute({ handle: multiResult.secrets[1].handle }, execFor(sessionId))


/* 1c. multi-field with an empty answer is rejected before anything is stored. */
setAskAnswer({ answers: [
  { id: 'secret-0', selected: [], custom: 'filled' },
  { id: 'secret-1', selected: [], custom: '' },
] })
await assert.rejects(
  () => promptSecret.execute({ prompt: 'pair', fields: [{ prompt: 'a' }, { prompt: 'b' }] }, execFor(sessionId)),
  /left the field "b" empty/,
)
assert.equal(captured.contributors.size, 0, 'no value stored when a batch field is empty (no partial storage)')


/* 9. per-session capacity is enforced. */
setAskAnswer({ answers: [{ id: 'secret', selected: [], custom: 'one' }] })
const capOne = await promptSecret.execute({ prompt: 'a' }, execFor(sessionId))
setAskAnswer({ answers: [{ id: 'secret', selected: [], custom: 'two' }] })
const capTwo = await promptSecret.execute({ prompt: 'b' }, execFor(sessionId))
setAskAnswer({ answers: [{ id: 'secret', selected: [], custom: 'three' }] })
await assert.rejects(
  () => promptSecret.execute({ prompt: 'c' }, execFor(sessionId)),
  /would exceed the session capacity/,
)
await revokeSecret.execute({ handle: capOne.handle }, execFor(sessionId))
await revokeSecret.execute({ handle: capTwo.handle }, execFor(sessionId))

/* 10. empty secret answer is rejected. */
setAskAnswer({ answers: [{ id: 'secret-0', selected: [], custom: '   ' }] })
await assert.rejects(() => promptSecret.execute({ prompt: 'd' }, execFor(sessionId)), /left the field "d" empty/)

/* 11. values below minRedactLength are not redacted (readability floor). */
setAskAnswer({ answers: [{ id: 'secret', selected: [], custom: '--' }] })
const shortResult = await promptSecret.execute({ prompt: 'short' }, execFor(sessionId))
const shortUntouched = await listener(
  { name: 'bash' },
  { content: [{ type: 'text', text: 'tsc --noEmit' }] },
  async () => accept,
)
assert.equal(shortUntouched.content, undefined, 'short secret skipped by redaction')
await revokeSecret.execute({ handle: shortResult.handle }, execFor(sessionId))

/* 12. values at or above minRedactLength are redacted (length 4). */
setAskAnswer({ answers: [{ id: 'secret', selected: [], custom: 'card' }] })
const fourResult = await promptSecret.execute({ prompt: 'four' }, execFor(sessionId))
const fourRedacted = await listener(
  { name: 'bash' },
  { content: [{ type: 'text', text: 'id card-check' }] },
  async () => accept,
)
assert.equal(fourRedacted.content[0].text, 'id [redacted]-check', 'length-4 secret redacted')
await revokeSecret.execute({ handle: fourResult.handle }, execFor(sessionId))


/* 13. the idle window restarts on use, which is the reported failure it fixes.
 *
 * A one-second window stands in for the configured minutes: the secret is used, the run continues
 * past where a fixed lifetime would have expired it, and the value is still there because the use
 * moved the deadline. Without the refresh this fails at the second assertion, which is the state a
 * long run used to end in: the credential gone in the middle of the work.
 */
{
  const { captured: ttlCaptured, setAskAnswer: ttlAsk } = mockContext({
    ttlMinutes: 1 / 60,
    ttlRefreshOnUse: true,
    maxSecretsPerSession: 2,
    minRedactLength: 4,
  })
  const ttlPrompt = ttlCaptured.tools.get('prompt_secret')
  ttlAsk({ answers: [{ id: 'secret-0', selected: [], custom: 'long-run-token' }] })
  const stored = await ttlPrompt.execute({ prompt: 'live token' }, execFor(sessionId))
  const contributor = ttlCaptured.contributors.get(`DSH_SECRET_${stored.handle}`)
  assert.ok(contributor, 'contributor registered for the refresh case')

  // Half the window passes, then the secret is handed to a command.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const injected = contributor.resolve({ name: 'bash', arguments: { command: 'echo $DSH_SECRET_X' }, agent: { session: { header: { id: sessionId } } } })
  assert.equal(injected[`DSH_SECRET_${stored.handle}`], 'long-run-token', 'value handed to the command')

  // Past the ORIGINAL deadline, and still live because the use restarted the window.
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(ttlCaptured.contributors.has(`DSH_SECRET_${stored.handle}`), true, 'kept past its original deadline because it was used')

  // And a command of ANOTHER session neither receives the value nor keeps it alive.
  const foreign = contributor.resolve({ name: 'bash', arguments: { command: 'echo hi' }, agent: { session: { header: { id: otherSession } } } })
  assert.deepEqual(foreign, {}, 'another session is given nothing')

  // Left alone, it expires: the window is idle time, not immortality.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert.equal(ttlCaptured.contributors.has(`DSH_SECRET_${stored.handle}`), false, 'expires once it is idle for the window')
}

/* 14. with the refresh turned off the lifetime is fixed from collection. */
{
  const { captured: fixedCaptured, setAskAnswer: fixedAsk } = mockContext({
    ttlMinutes: 1 / 60,
    ttlRefreshOnUse: false,
    maxSecretsPerSession: 2,
    minRedactLength: 4,
  })
  const fixedPrompt = fixedCaptured.tools.get('prompt_secret')
  fixedAsk({ answers: [{ id: 'secret-0', selected: [], custom: 'fixed-window-token' }] })
  const stored = await fixedPrompt.execute({ prompt: 'fixed' }, execFor(sessionId))
  const contributor = fixedCaptured.contributors.get(`DSH_SECRET_${stored.handle}`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  contributor.resolve({ name: 'bash', arguments: { command: 'echo $DSH_SECRET_X' }, agent: { session: { header: { id: sessionId } } } })
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(
    fixedCaptured.contributors.has(`DSH_SECRET_${stored.handle}`),
    false,
    'a fixed window is not extended by use when the refresh is off',
  )
}

console.log('smoke test: all assertions passed')
