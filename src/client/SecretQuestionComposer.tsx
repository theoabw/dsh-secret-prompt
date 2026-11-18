/**
 * The secret question composer: one masked password field per question in the
 * claimed batch (so a batch collects several credentials in one dialog), with
 * labels, a show/hide toggle, submit, and cancel. The values live only in this
 * component's state until they are submitted through the question card's own
 * answer channel; nothing renders them as plain text unless the owner asks to
 * see what they typed.
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import { secretDialogTitle } from './index.ts'
import css from './SecretQuestionComposer.module.css'

/** Props this card reads: the elected question card and the locale seat. */
interface SecretQuestionProps {
  matched: PendingQuestion
  t: (key: string) => string
}

/** A small lock glyph for the card strip. */
function LockIcon({ color }: { color: string }): ReactElement {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" fill={color} />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

/** An eye glyph for the show/hide toggle; a slash means the value is concealed. */
function EyeIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      {open && (
        <path d="M2.5 2.5 13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
    </svg>
  )
}

/**
 * Render the masked secret card: a title, one labeled field per question in
 * the batch, a show/hide toggle, and Submit/Cancel.
 * @param props - the elected question card plus `t` from the slot's locale binding.
 */
export function SecretQuestionComposer(props: SecretQuestionProps): ReactElement {
  const card = props.matched
  const questions = useMemo(() => card.questions, [card])
  const title = secretDialogTitle(questions) ?? questions[0]?.question ?? ''
  const multi = questions.length > 1
  const [values, setValues] = useState<string[]>(() => questions.map(() => ''))
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState<null | 'submit' | 'cancel'>(null)
  const [error, setError] = useState<string | null>(null)

  const setValue = (index: number, value: string): void => {
    setValues((current) => current.map((item, itemIndex) => itemIndex === index ? value : item))
    setError(null)
  }

  const allFilled = values.every((value) => value.trim().length > 0)

  const submit = (): void => {
    if (!allFilled) {
      setError(props.t(multi ? 'requiredAll' : 'required'))
      return
    }
    setBusy('submit')
    setError(null)
    card.answer({
      answers: questions.map((question, index) => ({
        id: question.id,
        selected: [],
        custom: values[index],
      })),
    }).catch((cause: unknown) => {
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const dismiss = (): void => {
    setBusy('cancel')
    setError(null)
    card.dismiss().catch((cause: unknown) => {
      setBusy(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || busy !== null) return
    event.preventDefault()
    submit()
  }

  const revealLabel = revealed ? props.t('conceal') : props.t('reveal')

  return (
    <div className={css.frame} data-question-key={card.key}>
      <section
        className={css.card}
        aria-label={title}
        data-secret-prompt=""
        data-secret-revealed={revealed ? 'true' : 'false'}
      >
        <header className={css.header}>
          <div className={css.headingBlock}>
            <div className={css.eyebrow}>
              <LockIcon color="var(--dsw-alias-state-business-primary)" />
              {props.t('badge')}
            </div>
            <h2 className={css.title} id={`secret-question-${card.key}`}>{title}</h2>
          </div>
          <div className={css.headerActions}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={revealLabel}
              aria-pressed={revealed}
              title={revealLabel}
              disabled={busy !== null}
              onClick={() => { setRevealed((current) => !current) }}
            >
              <EyeIcon open={revealed} />
              <span className={css.toggleLabel}>{revealed ? props.t('hide') : props.t('show')}</span>
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={props.t('nav.cancel')}
              title={props.t('nav.cancel')}
              disabled={busy !== null}
              onClick={dismiss}
            >
              <svg width={14} height={14} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>
        <div className={css.body}>
          {questions.map((question, index) => (
            <div className={css.fieldBlock} key={question.id}>
              {multi && (
                <label className={css.fieldLabel} htmlFor={`secret-field-${card.key}-${index}`}>
                  {question.question}
                </label>
              )}
              {question.detail !== undefined && (
                <div className={css.fieldHint}>{question.detail}</div>
              )}
              <div className={css.fieldRow}>
                <div className={css.fieldWrap}>
                  <Input
                    id={`secret-field-${card.key}-${index}`}
                    type={revealed ? 'text' : 'password'}
                    name={`dsh-secret-${index}`}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-secret-field={index}
                    placeholder={props.t('placeholder')}
                    aria-label={question.question}
                    autoFocus={index === 0}
                    disabled={busy !== null}
                    value={values[index]}
                    onChange={(event) => { setValue(index, event.target.value) }}
                    onKeyDown={onKeyDown}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <footer className={css.footer}>
          <div className={css.feedback} role="status">{error}</div>
          <div className={css.actions}>
            <Button variant="ghost" disabled={busy !== null} onClick={dismiss}>
              {props.t('cancel')}
            </Button>
            <Button variant="primary" disabled={busy !== null || !allFilled} onClick={submit}>
              {busy === 'submit' ? props.t('submitting') : props.t('submit')}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
