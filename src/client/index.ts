/**
 * @tabw/dsh-secret-prompt browser half: the `conversation.composer` chain entry
 * that claims question cards whose questions all carry the `dsh-secret` header
 * marker, rendering masked password fields instead of the generic option list
 * (one field per question, so a batch collects several credentials in one
 * dialog). The values ride the question card's own answer channel as each
 * question's `custom` text; the host tool stores them and returns only handles,
 * so the values never appear in the agent loop, the trajectory, or any log.
 *
 * Chain contract (dsh 0.2.2): the slot's owner props carry the Session's
 * `pendingInteraction`, and an entry's `select` returns the matched currency
 * (here the question card) or null. Entries are tried in ascending priority
 * order, so this entry sorts before the generic question composer.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pull the client Context augmentations (ctx.slots, ctx.locale) into the typecheck program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the 'conversation.composer' chain declaration and its owner
// props into the program, so a change to the chain currency is a compile error.
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { SecretQuestionComposer } from './SecretQuestionComposer.tsx'

// Exported so the render test can drive the card without the chain.
export { SecretQuestionComposer }

/** Services required by this plugin (the slot registry and the locale service). */
export const inject = ['slots', 'locale']

/**
 * Marker that rides the schema'd `header` field of a question (the browser's
 * wire schema strips unknown fields, so a custom field cannot reach the UI).
 * Must match the host half's `SECRET_HEADER_MARKER` in src/index.ts. For a
 * multi-field batch, the first question's header carries the dialog title
 * after a colon: `dsh-secret: <title>`.
 */
export const SECRET_HEADER_MARKER = 'dsh-secret'

/** Dictionary namespace owned by this plugin. */
const NS = 'secret'

/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
  'badge': '安全输入',
  'placeholder': '输入机密值',
  'submit': '提交',
  'cancel': '取消',
  'show': '显示',
  'hide': '隐藏',
  'reveal': '显示输入',
  'conceal': '隐藏输入',
  'required': '请先输入值。',
  'requiredAll': '请填写所有字段。',
  'submitting': '提交中…',
  'nav.cancel': '放弃本次输入',
}

/** English dictionary, checked complete against the zh key set. */
const en = {
  'badge': 'Secure input',
  'placeholder': 'Enter the secret',
  'submit': 'Submit',
  'cancel': 'Cancel',
  'show': 'Show',
  'hide': 'Hide',
  'reveal': 'Show what I typed',
  'conceal': 'Hide what I typed',
  'required': 'Enter a value first.',
  'requiredAll': 'Fill in every field.',
  'submitting': 'Submitting…',
  'nav.cancel': 'Dismiss the secret prompt',
}

/** Whether one question is a secret-marked field (marker, or marker with a dialog title). */
function isSecretQuestion(question: { header?: string } | undefined): boolean {
  return typeof question?.header === 'string'
    && (question.header === SECRET_HEADER_MARKER || question.header.startsWith(`${SECRET_HEADER_MARKER}:`))
}

/** The dialog title carried in the first question's header, when the batch declares one. */
export function secretDialogTitle(questions: readonly { header?: string }[]): string | undefined {
  const header = questions[0]?.header
  const prefix = `${SECRET_HEADER_MARKER}:`
  if (typeof header !== 'string' || !header.startsWith(prefix)) return undefined
  const title = header.slice(prefix.length).trim()
  return title.length > 0 ? title : undefined
}

/**
 * Narrow one pending interaction to a secret question card, by shape rather
 * than by `instanceof`: this bundle must not require a dynamic client package
 * (the module table seeds only the platform rows), so it checks the documented
 * surface it uses (`kind`, `questions`, `answer`, `dismiss`). A read-only review
 * card is never claimed: it replays the answers of a settled call, which is not
 * something this card may edit or resubmit.
 */
export function asSecretCard(interaction: unknown): PendingQuestion | null {
  if (typeof interaction !== 'object' || interaction === null) return null
  const card = interaction as Partial<PendingQuestion>
  if (card.kind !== 'question') return null
  if (card.review !== undefined) return null
  const questions = card.questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  if (!questions.every((question: AskUserQuestionItem) => isSecretQuestion(question))) return null
  if (typeof card.answer !== 'function' || typeof card.dismiss !== 'function') return null
  return card as PendingQuestion
}

/**
 * Claim the composer seat only for secret-marked question cards. Everything
 * else (ordinary questions, approvals, plan reviews) returns null so the next
 * entry of the chain keeps it; the generic question composer stays at the
 * default priority 0 and this entry sorts before it.
 */
export function selectSecretQuestion({ pendingInteraction }: Pick<ComposerChainProps, 'pendingInteraction'>): PendingQuestion | null {
  return asSecretCard(pendingInteraction)
}

/**
 * Register the `secret` dictionaries and the secret-question composer into
 * the composer chain.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'secret-prompt: zh dictionary')
  ctx.effect(() => ctx.locale.register(NS, 'en', en), 'secret-prompt: en dictionary')
  // The copy is injected as a plain prop rather than through the slot's
  // `locale` option: the option's key domain is the LocaleNamespaceMap merge
  // table, and a plugin namespace outside it would have to be declared against
  // a slot package that ships compiled into the web shell. Binding here keeps
  // the same translate function with no type-level coupling.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: -20,
    select: selectSecretQuestion,
    inject: () => ({ t }),
  }, SecretQuestionComposer))
}
