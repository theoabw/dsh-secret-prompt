/**
 * Browser-half test for @tabw/dsh-secret-prompt.
 *
 * Loads the BUILT lib/client.js through a stub `window.__ModuleLoader__`, so the
 * test exercises the shipped bundle rather than src: the composer's routing
 * selector (which is what silently broke when the dsh 0.2.2 composer chain
 * changed its currency) and the card markup it renders. Primitives are stubbed
 * because @deepseek-ai/dsh-client-ui-primitives ships compiled into the web
 * shell; the stub forwards props to a plain <input>, matching the shipped
 * Input component's `{...props}` behavior.
 *
 * Run: node scripts/client-test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const React = require('react')
const jsxRuntime = require('react/jsx-runtime')
const { renderToStaticMarkup } = require('react-dom/server')

/** The subset of the browser module table the bundle requires. */
const primitives = {
  Button: ({ variant, size, icon, children, ...rest }) => React.createElement('button', rest, icon, children),
  Input: (props) => React.createElement('input', props),
  MarkdownText: ({ text }) => React.createElement('span', null, text),
}

let plugin = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, '@tabw/dsh-secret-prompt')
      plugin = factory((specifier) => {
        switch (specifier) {
          case 'react': return React
          case 'react/jsx-runtime': return jsxRuntime
          case '@deepseek-ai/dsh-client-ui-primitives': return primitives
          default: throw new Error(`client-test: unexpected require(${JSON.stringify(specifier)})`)
        }
      })
    },
  },
}

// Load the bundle body (it only registers its factory).
await import('../lib/client.js')
assert.ok(plugin, 'the bundle registered its factory')
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.inject, ['slots', 'locale'])
assert.equal(plugin.SECRET_HEADER_MARKER, 'dsh-secret')

/* ── the routing selector ───────────────────────────────────────────────── */

/** One question card shaped like the chain currency (see PendingQuestion). */
function questionCard({ headers, details, review, answer, dismiss } = {}) {
  const questions = (headers ?? ['dsh-secret']).map((header, index) => ({
    id: `secret-${index}`,
    question: `Field ${index}`,
    header,
    ...details?.[index] !== undefined ? { detail: details[index] } : {},
  }))
  return {
    kind: 'question',
    key: 'session-x:call-1',
    sessionId: 'session-x',
    questions,
    ...review !== undefined ? { review } : {},
    answer: answer ?? (async () => {}),
    dismiss: dismiss ?? (async () => {}),
  }
}

const select = plugin.selectSecretQuestion

// Not a question at all: approvals and other interactions fall through.
assert.equal(select({ pendingInteraction: undefined }), null, 'no interaction declines')
assert.equal(select({}), null, 'missing interaction declines')
assert.equal(select({ pendingInteraction: { kind: 'approval', id: 'x' } }), null, 'approval declines')

// An ordinary question (no marker) stays with the generic composer.
const ordinary = questionCard({ headers: ['Some choice'] })
assert.equal(select({ pendingInteraction: ordinary }), null, 'ordinary question declines')

// The secret marker claims the seat, for one field and for a titled batch.
const single = questionCard()
assert.equal(select({ pendingInteraction: single }), single, 'secret question is claimed')
const titled = questionCard({ headers: ['dsh-secret: S3 credentials', 'dsh-secret'] })
assert.equal(select({ pendingInteraction: titled }), titled, 'titled secret batch is claimed')

// A mixed batch is left to the generic flow: every question must be a secret.
const mixed = questionCard({ headers: ['dsh-secret: pair', 'Not a secret'] })
assert.equal(select({ pendingInteraction: mixed }), null, 'mixed batch declines')

// A settled call replays as a read-only review card, which this card may not edit.
const reviewed = questionCard({ review: [{ id: 'secret-0', selected: [], custom: 'gone' }] })
assert.equal(select({ pendingInteraction: reviewed }), null, 'review card declines')

// A carrier missing the answer verbs is not claimed: the card would be a dead end.
assert.equal(select({ pendingInteraction: { ...questionCard(), answer: undefined } }), null, 'no answer channel declines')
assert.equal(select({ pendingInteraction: { ...questionCard(), dismiss: undefined } }), null, 'no dismiss channel declines')

// Dialog title parsing.
assert.equal(plugin.secretDialogTitle(titled.questions), 'S3 credentials')
assert.equal(plugin.secretDialogTitle(single.questions), undefined)

/* ── the card ───────────────────────────────────────────────────────────── */

function render(card, t = (key) => key) {
  return renderToStaticMarkup(React.createElement(plugin.SecretQuestionComposer, { matched: card, t }))
}

const singleMarkup = render(single)
assert.match(singleMarkup, /data-secret-prompt=""/, 'card is identifiable')
assert.match(singleMarkup, /data-secret-revealed="false"/, 'the card starts masked')
assert.match(singleMarkup, /type="password"/, 'the only input is a masked password field')
assert.doesNotMatch(singleMarkup, /type="text"/, 'no plain-text field is rendered by default')
assert.match(singleMarkup, /data-secret-field="0"/, 'the field carries its index')
assert.match(singleMarkup, /aria-label="reveal"/, 'a reveal control is offered')
assert.match(singleMarkup, /aria-pressed="false"/, 'the reveal control starts unpressed')
assert.match(singleMarkup, /autocomplete="off"/i, 'browser autofill is off')
assert.match(singleMarkup, /spellcheck="false"/, 'spellcheck is off')
// The label is only rendered once the fields need telling apart.
assert.doesNotMatch(singleMarkup, /<label/, 'single field needs no label')

const multiMarkup = render(questionCard({
  headers: ['dsh-secret: S3 credentials', 'dsh-secret'],
  details: ['from the console', undefined],
}))
assert.match(multiMarkup, /Field 0/, 'first field label')
assert.match(multiMarkup, /Field 1/, 'second field label')
assert.match(multiMarkup, /from the console/, 'per-field hint')
assert.equal((multiMarkup.match(/type="password"/g) ?? []).length, 2, 'one masked field per question')
assert.match(multiMarkup, /S3 credentials/, 'dialog title from the marker header')

// Hostile copy in a label stays text, never markup.
const escapedMarkup = render(questionCard({ headers: ['dsh-secret: <img src=x onerror=alert(1)>'] }))
assert.doesNotMatch(escapedMarkup, /<img/, 'label text is escaped')

console.log('client test: all assertions passed')
