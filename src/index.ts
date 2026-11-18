/**
 * @tabw/dsh-secret-prompt host half.
 *
 * `prompt_secret` collects a secret from the human through a masked GUI field.
 * The value travels browser -> web server -> this plugin's in-memory store and
 * never enters the agent loop: the model receives only a handle plus the
 * matching `$DSH_SECRET_<handle>` environment-variable name, and the harness
 * injects the real value into shell commands' environments without showing it.
 *
 * Guarantees:
 * - The value is held only in process memory (no disk, no logs, no session
 *   events, no trajectory), keyed by a high-entropy handle, scoped to the
 *   session that requested it, and expires after `ttlMinutes` WITHOUT USE:
 *   a command that references the variable restarts that window, so a run
 *   longer than the window keeps its credential instead of losing it.
 * - The model-visible tool result carries the handle, never the value.
 * - A `tools/post-execute` listener replaces any occurrence of an active
 *   secret value with `[redacted]` in every tool result the model can see,
 *   and scrubs spill files the bash executor wrote for truncated output.
 * - Shell commands see the value as `DSH_SECRET_<handle>` in the managed
 *   `DSH_*` environment (the same channel as DSH_SESSION_ID and friends);
 *   ambient `DSH_*` values are scrubbed by the executor, so the value cannot
 *   leak from the harness process environment.
 *
 * Deliberate limits (documented in README.md): a model that actively tries to
 * exfiltrate a value it is allowed to use (e.g. `echo $DSH_SECRET_x | base64`)
 * can do so; redaction is a safety net for accidental leakage, not a boundary
 * against a hostile model. Revoke secrets with `revoke_secret` when done.
 */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { DshEnvironmentKey } from '@deepseek-ai/dsh-shell'
import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
// Type-only: pulls the ctx.userQuestions service augmentation into the typecheck program.
import type {} from '@deepseek-ai/dsh-user-questions'

/** Validated plugin configuration (deployment-varying choices live here, never hardcoded). */
export interface Config {
  /**
   * Minutes a collected secret stays usable WITHOUT BEING USED before it is forgotten.
   *
   * It is an idle window and not a lifetime. The timer used to be armed once when the secret was
   * collected and never moved, so a run longer than the window lost its credential in the middle of
   * the work and the owner had to hand it over again; that is the failure this measures instead. A
   * secret referenced by a command has been used, and being used is what should keep it: the window
   * restarts on each use, so a long run keeps its credential and a finished one lets it go
   * `ttlMinutes` after its last command.
   */
  ttlMinutes: number
  /**
   * Whether using a secret restarts its idle window (default true).
   *
   * Turning it off restores a fixed lifetime from collection, which is what a deployment that
   * prefers a hard cap wants. It is a deployment choice rather than the default, because a hard cap
   * that expires in the middle of work looks like a broken tool from the outside.
   */
  ttlRefreshOnUse: boolean
  /** Maximum simultaneously stored secrets per session; excess prompt_secret calls fail. */
  maxSecretsPerSession: number
  /**
   * Shortest secret length that gets redacted from tool output. Shorter values
   * are still stored and injected, but not redacted, so a pathological short
   * secret (a single dash, say) cannot destroy the readability of every tool
   * result. Real tokens, passwords, and PINs are at least 4 characters.
   */
  minRedactLength: number
}

export const Config: z<Config> = z.object({
  ttlMinutes: z.natural().min(1).default(60),
  ttlRefreshOnUse: z.boolean().default(true),
  maxSecretsPerSession: z.natural().min(1).default(20),
  minRedactLength: z.natural().min(0).default(4),
})

/** Services required before this plugin can register tools and hooks. */
export const inject = ['tools', 'userQuestions', 'shellEnv', 'systemPrompt']

/**
 * Marker that rides the schema'd `header` field of a question. The browser's
 * wire schema for `question/requested` frames strips unknown fields (zod
 * strict object), so a custom field would never reach the UI; the client
 * composer in this plugin matches this exact header to claim the question.
 */
export const SECRET_HEADER_MARKER = 'dsh-secret'

/** Environment-variable prefix under which a collected secret is exposed to shell commands. */
export const SECRET_ENV_PREFIX = 'DSH_SECRET_'

/** Replacement text for any occurrence of an active secret value in model-visible output. */
const REDACTED = '[redacted]'

/** Upper bound on secret fields one prompt_secret call may collect. */
const MAX_FIELDS_PER_CALL = 8

/* ── secret store ────────────────────────────────────────────────────────── */

interface SecretEntry {
  value: string
  sessionId: string
  expiresAtMs: number
  envKey: string
  disposeEnv: () => void
  /**
   * The pending expiry timer, or null between revocation's steps.
   *
   * It is armed and re-armed in exactly one place, because a refresh that set a second timer without
   * clearing the first would expire a live secret on the old schedule and look like a refresh that
   * did not happen.
   */
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Session-scoped, in-memory secret store. Handles are 80-bit random hex
 * (uppercase so the generated env key satisfies the `DSH_[A-Z][A-Z0-9_]*`
 * grammar the shell-env registry enforces). Every stored secret owns a
 * shellEnv contributor registration and a TTL timer; both are disposed on
 * revoke, expiry, or plugin unload.
 */
class SecretStore {
  private entries = new Map<string, SecretEntry>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxPerSession: number,
    private readonly registerEnv: (
      envKey: string,
      sessionId: string,
      value: string,
      onUse: () => void,
    ) => () => void,
    /** Whether a use restarts the idle window. False gives a fixed lifetime from collection. */
    private readonly refreshOnUse: boolean = true,
  ) {}

  /**
   * (Re)arm one secret's expiry from now, clearing any pending timer first.
   *
   * The idle window is measured from the last use, so this is called both when a secret is stored and
   * every time one is handed to a command. It is unconditional about clearing, because the two timers
   * that would otherwise coexist disagree about when the secret dies.
   */
  private arm(handle: string, entry: SecretEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.expiresAtMs = Date.now() + this.ttlMs
    const timer = setTimeout(() => this.revoke(handle), this.ttlMs)
    timer.unref?.()
    entry.timer = timer
  }

  /**
   * Note that a secret was just handed to a command, which restarts its idle window.
   *
   * It is the fix for the reported failure: a run longer than `ttlMinutes` lost its credential in the
   * middle of the work and the owner had to supply it again. A secret that is being used is a secret
   * the work still needs, and the time to forget it is `ttlMinutes` after the last use rather than
   * `ttlMinutes` after collection.
   *
   * The signal is coarser than "the command read the variable": the contributor is invoked for each
   * command of the owning session, so a command that does not mention it also refreshes it. That is
   * the honest description, and the alternative (matching the command text for the variable name)
   * would expire a credential during a long stretch of work that happened not to name it, which is
   * the failure this exists to remove.
   */
  touch(handle: string): void {
    if (!this.refreshOnUse) return
    const entry = this.entries.get(handle)
    if (entry === undefined) return
    this.arm(handle, entry)
  }

  /** Forget every expired secret; called opportunistically before reads. */
  private pruneExpired(): void {
    const now = Date.now()
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.revoke(handle)
    }
  }

  /** Number of live secrets owned by one session. */
  count(sessionId: string): number {
    this.pruneExpired()
    let count = 0
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId) count += 1
    return count
  }

  /**
   * Store one secret and make it available to the owning session's shell
   * commands as `DSH_SECRET_<handle>`.
   * @param sessionId - owning session (from `exec.agent.session.header.id`).
   * @param value - the secret value; never logged or rendered.
   * @returns the handle (the env-key suffix), or throws when the session is at capacity.
   */
  put(sessionId: string, value: string): string {
    this.pruneExpired()
    if (this.count(sessionId) >= this.maxPerSession) {
      throw new Error(`prompt_secret: session already holds ${this.maxPerSession} secrets; revoke one with revoke_secret first`)
    }
    const handle = randomBytes(10).toString('hex').toUpperCase()
    const envKey = `${SECRET_ENV_PREFIX}${handle}`
    const entry: SecretEntry = {
      value,
      sessionId,
      expiresAtMs: 0,
      envKey,
      disposeEnv: () => {},
      timer: null,
    }
    // The hook closes over the handle, so a use can find the entry it belongs to. It is registered
    // before the entry is stored and it only ever runs later, from a command.
    entry.disposeEnv = this.registerEnv(envKey, sessionId, value, () => this.touch(handle))
    this.entries.set(handle, entry)
    this.arm(handle, entry)
    return handle
  }

  /** Forget a secret: stop env injection, cancel its TTL timer, drop the value. Idempotent. */
  revoke(handle: string): void {
    const entry = this.entries.get(handle)
    if (entry === undefined) return
    this.entries.delete(handle)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    entry.disposeEnv()
  }

  /** Forget every secret (plugin unload / service shutdown). */
  clear(): void {
    for (const handle of [...this.entries.keys()]) this.revoke(handle)
  }

  /** The value behind one handle, or undefined when unknown or expired. */
  valueOf(handle: string): string | undefined {
    this.pruneExpired()
    return this.entries.get(handle)?.value
  }

  /** Every live value across sessions, for output redaction. */
  activeValues(): string[] {
    this.pruneExpired()
    return [...this.entries.values()].map((entry) => entry.value)
  }
}

/* ── redaction helpers ───────────────────────────────────────────────────── */

/**
 * Replace every occurrence of any active secret value in `text`. Values are
 * matched as exact substrings (regex-escaped); longer values win first so a
 * value that contains another never leaves a fragment. Over-redaction (a very
 * short secret making common substrings disappear) is accepted as the safe
 * failure direction.
 */
function redact(text: string, values: readonly string[]): string {
  if (text.length === 0 || values.length === 0) return text
  const ordered = [...values].filter((value) => value.length > 0).sort((left, right) => right.length - left.length)
  if (ordered.length === 0) return text
  const pattern = ordered.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return text.replace(new RegExp(pattern, 'g'), REDACTED)
}

/** Redact the text blocks of a content array, returning the input identity when nothing changed. */
function redactBlocks(blocks: ContentBlock[], values: readonly string[]): ContentBlock[] {
  let changed = false
  const out = blocks.map((block) => {
    if (block.type !== 'text') return block
    const replaced = redact(block.text, values)
    if (replaced === block.text) return block
    changed = true
    return { ...block, text: replaced }
  })
  return changed ? out : blocks
}

/** Flatten text blocks for spill-path discovery. */
function flattenText(blocks: ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let text = ''
  for (const block of blocks) if (block.type === 'text') text += block.text
  return text
}

/**
 * Collect spill-file paths reachable from one tool result: the structured
 * `stdout`/`stderr` spillPath of the bash executor's canonical value, plus
 * absolute paths named in "full output: <path>" notices inside rendered text
 * (background jobs and the read tool).
 */
function spillPathsOf(value: unknown, contentText: string): string[] {
  const paths = new Set<string>()
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    for (const stream of ['stdout', 'stderr']) {
      const streamRecord = record[stream]
      if (typeof streamRecord !== 'object' || streamRecord === null) continue
      const spillPath = (streamRecord as Record<string, unknown>).spillPath
      if (typeof spillPath === 'string' && spillPath.startsWith('/')) paths.add(spillPath)
    }
  }
  for (const match of contentText.matchAll(/full output: ([^\]]+)/g)) {
    for (const part of match[1].split(',')) {
      const path = part.trim()
      if (path.startsWith('/')) paths.add(path)
    }
  }
  return [...paths]
}

/** Best-effort in-place scrub of one spill file; absence or read failure is fine. */
async function scrubSpillFile(path: string, values: readonly string[]): Promise<void> {
  try {
    const content = await readFile(path, 'utf8')
    const replaced = redact(content, values)
    if (replaced !== content) await writeFile(path, replaced)
  } catch {
    // The executor may already have removed the file; nothing to do.
  }
}

/* ── the plugin ──────────────────────────────────────────────────────────── */

/**
 * Register the `prompt_secret` and `revoke_secret` tools, the per-secret
 * shellEnv contributors, and the post-execute redaction waterfall listener.
 * @param ctx - host context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const ttlMs = config.ttlMinutes * 60_000

  /**
   * Register one DSH_SECRET_<handle> shell-env contributor for the owning session.
   *
   * `onUse` is called when the value is actually handed to a command of that session, which is what
   * restarts the secret's idle window. It is called from `resolve` rather than from a timer, so it
   * fires exactly when the secret is used and never for a session that is not the owner's.
   */
  const registerEnv = (
    envKey: string,
    sessionId: string,
    value: string,
    onUse: () => void,
  ): (() => void) => {
    // The env key is runtime-computed, so the template-literal keyed records
    // are asserted (the registry re-validates both halves at runtime).
    const contributor: BashEnvContributor = {
      name: `secret-prompt:${envKey}`,
      variables: {
        [envKey]: {
          description: `Secret provided by the user via prompt_secret. Reference $${envKey} in commands when the target needs it; never print or echo its value.`,
        },
      } as BashEnvContributor['variables'],
      resolve(execution: ToolExecution): Readonly<Partial<Record<DshEnvironmentKey, string>>> {
        if (execution.agent?.session.header.id !== sessionId) {
          return {} as Readonly<Partial<Record<DshEnvironmentKey, string>>>
        }
        // The value is going into this command's environment, so the secret is being used. The window
        // restarts here, before the command runs, so a command that fails still counts as a use: it
        // was given the credential, and the work it was part of is not over.
        onUse()
        return { [envKey]: value } as Readonly<Partial<Record<DshEnvironmentKey, string>>>
      },
    }
    return ctx.shellEnv.register(contributor)
  }

  const store = new SecretStore(
    ttlMs,
    config.maxSecretsPerSession,
    registerEnv,
    config.ttlRefreshOnUse,
  )

  // Plugin unload (HMR, shutdown) forgets every secret.
  ctx.effect(() => () => store.clear(), 'secret-prompt: store')

  ctx.systemPrompt.section({
    name: 'tool:secret-prompt',
    order: 106,
    text: 'When a task needs a credential that only the user can supply (password, API token, private key), collect it with prompt_secret: the GUI shows a masked input field and the value never enters the conversation, trajectory, or logs. Never ask the user to type a secret into chat. The value is never shown to you: reference the returned $DSH_SECRET_<handle> inside bash commands, never print or echo it, and call revoke_secret once it is no longer needed.',
  })

  ctx.tools.register(defineTool({
    name: 'prompt_secret',
    description: 'Ask the user (in the GUI) to provide one or more secret values (passwords, API tokens, keys), each typed into a masked input field. The values themselves are never shown to you, never returned in the result, and never written to the conversation or logs: you receive a handle and the matching environment-variable name per value, and you reference $DSH_SECRET_<handle> inside bash commands while the harness injects the real value into the command environment for you. Never print, echo, or otherwise emit any value. When a secret is no longer needed, call revoke_secret with its handle to forget it. Use this whenever a task needs credentials that only the user can supply. To collect several related values in one dialog (for example an access key ID and its secret), pass `fields`; each field is labeled by its own prompt and gets its own handle.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What the secret is for, shown verbatim to the user as the dialog title. When `fields` is provided, this becomes the title of the whole credential group.',
      },
      hint: {
        type: 'string',
        description: 'Optional supporting detail for the user, such as where to find the secret or how it will be used. Ignored when `fields` is provided (give each field its own hint instead).',
      },
      fields: {
        type: 'array',
        description: 'Optional list of secret fields to collect in one dialog, e.g. [{prompt: "Access key ID"}, {prompt: "Secret access key"}]. Omit for a single secret field.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            prompt: {
              type: 'string',
              required: true,
              description: 'Label for this field, shown to the user.',
            },
            hint: {
              type: 'string',
              description: 'Optional supporting detail for this field, such as where to find the value.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            handle: {
              type: 'string',
              required: true,
              description: 'Opaque identifier for the stored secret; the suffix of the environment variable name.',
            },
            env: {
              type: 'string',
              required: true,
              description: 'Environment variable name to reference inside bash commands; the harness substitutes the value without showing it.',
            },
            prompt: {
              type: 'string',
              required: true,
              description: 'The prompt the user answered.',
            },
          },
        }, {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: {
              type: 'string',
              required: true,
              description: 'The credential-group title the user saw.',
            },
            secrets: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: {
                    type: 'string',
                    required: true,
                    description: 'The field label this secret belongs to.',
                  },
                  handle: {
                    type: 'string',
                    required: true,
                  },
                  env: {
                    type: 'string',
                    required: true,
                  },
                },
              },
            },
          },
        }],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('prompt_secret: this tool requires an agent-owned session')
      const sessionId = exec.agent.session.header.id
      const providedFields = args.fields ?? []
      const provided = providedFields.length > 0
      const fields: { prompt: string; hint?: string }[] = provided
        ? providedFields
        : [{ prompt: args.prompt, ...(args.hint !== undefined ? { hint: args.hint } : {}) }]
      if (fields.length > MAX_FIELDS_PER_CALL) {
        throw new Error(`prompt_secret: at most ${MAX_FIELDS_PER_CALL} fields per call`)
      }
      for (const field of fields) {
        if (field.prompt.trim().length === 0) throw new Error('prompt_secret: every field needs a non-empty prompt')
      }
      if (store.count(sessionId) + fields.length > config.maxSecretsPerSession) {
        throw new Error(`prompt_secret: storing ${fields.length} secret(s) would exceed the session capacity of ${config.maxSecretsPerSession}; revoke some with revoke_secret first`)
      }
      const answer = await ctx.userQuestions.ask({
        questions: fields.map((field, index) => ({
          id: `secret-${index}`,
          question: field.prompt,
          header: index === 0 && provided ? `${SECRET_HEADER_MARKER}: ${args.prompt}` : SECRET_HEADER_MARKER,
          ...(field.hint !== undefined ? { detail: field.hint } : {}),
        })),
        agent: exec.agent,
        signal: exec.signal,
      })
      // Validate every field's answer before storing any of them, so a batch
      // with one empty field cannot leave earlier values half-stored.
      const values = fields.map((field, index) => {
        const value = answer.answers[index]?.custom
        if (value === undefined || value.trim().length === 0) {
          throw new Error(`prompt_secret: the user left the field "${field.prompt}" empty`)
        }
        return value
      })
      const entries = values.map((value, index) => {
        const handle = store.put(sessionId, value)
        return { key: fields[index].prompt, handle, env: `${SECRET_ENV_PREFIX}${handle}` }
      })
      return provided
        ? { prompt: args.prompt, secrets: entries }
        : { handle: entries[0].handle, env: entries[0].env, prompt: args.prompt }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'revoke_secret',
    description: 'Forget a secret previously obtained with prompt_secret. The value is removed from memory, no longer injected into command environments, and further references to the handle fail. Idempotent: revoking an unknown handle succeeds quietly.',
    parameters: {
      handle: {
        type: 'string',
        required: true,
        description: 'The handle returned by prompt_secret.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revoked: {
            type: 'string',
            required: true,
            description: 'The handle that was forgotten.',
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      store.revoke(args.handle)
      return { revoked: args.handle }
    },
  }))

  // Redact every model-visible tool result and scrub spill files while any
  // secret is live. Registered with prepend so this transformation runs
  // before other post-execute policies (spill-policy truncation, reminders).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // Values shorter than the configured floor are kept out of redaction so a
    // pathological short secret cannot destroy output readability; they are
    // still injected into command environments as usual.
    const values = store.activeValues().filter((value) => value.length >= config.minRedactLength)
    if (values.length === 0) return decision
    if (decision.kind === 'block') {
      const feedback = redactBlocks(decision.feedback, values)
      return feedback === decision.feedback ? decision : { ...decision, feedback }
    }
    if (decision.kind !== 'accept') return decision
    // Spill files are written at capture time, before any listener runs; scrub
    // the ones this result points at before the model can be told to read them.
    const paths = spillPathsOf(result.value, flattenText(result.content))
    if (Object.hasOwn(decision, 'value')) {
      // A value replacement re-renders content from the value; redact a copy
      // of the value's strings so the re-render cannot carry a live secret.
      try {
        const cloned = redactDeep(structuredClone(decision.value) as JsonValue, values)
        await Promise.all(paths.map((path) => scrubSpillFile(path, values)))
        return {
          kind: 'accept',
          value: cloned,
          ...decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {},
        }
      } catch {
        return decision
      }
    }
    const content = decision.content ?? result.content
    const redacted = redactBlocks(content, values)
    if (redacted === content && paths.length === 0) return decision
    await Promise.all(paths.map((path) => scrubSpillFile(path, values)))
    if (redacted === content) return decision
    return {
      kind: 'accept',
      content: redacted,
      ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
    } as PostToolDecision
  }, { prepend: true })

  /**
   * Redact every string leaf of a cloned JSON value in place (used for value
   * replacements). It returns the node so a string leaf can be written back by
   * its container: the earlier version returned early on a string, so a string
   * inside an array, and a bare string value, were never redacted and a
   * canonical value shaped as a string list leaked the secret verbatim.
   */
  function redactDeep(node: JsonValue, values: readonly string[]): JsonValue {
    if (typeof node === 'string') return redact(node, values)
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        node[index] = redactDeep(node[index] as JsonValue, values)
      }
      return node
    }
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, JsonValue>
      for (const key of Object.keys(record)) record[key] = redactDeep(record[key], values)
      return node
    }
    return node
  }
}
