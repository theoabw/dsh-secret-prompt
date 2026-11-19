# @theoabw/dsh-secret-prompt

[![npm](https://img.shields.io/npm/v/@theoabw/dsh-secret-prompt?label=npm)](https://www.npmjs.com/package/@theoabw/dsh-secret-prompt)

English | [中文](https://github.com/theoabw/dsh-secret-prompt/blob/main/README.zh.md)

A dsh web plugin that adds a `prompt_secret` tool: the agent asks the user for a
secret (password, API token, private key, ...) and the user types it into a
**masked field in the GUI**. The value never reaches the agent:

- The tool result the model sees is only `{ handle, env: "DSH_SECRET_<handle>", prompt }`.
- The value lives only in host process memory (no disk, no logs, no session
  events, no trajectory), scoped to the requesting session, and expires after
  an IDLE window (default 60 minutes): a command that receives the variable
  restarts the window, so a run longer than the window keeps its credential
  instead of losing it in the middle of the work.
- The agent references `$DSH_SECRET_<handle>` inside bash commands; the
  harness injects the real value into the command's environment through the
  managed `DSH_*` env registry, the same channel as `DSH_SESSION_ID`.
- A `tools/post-execute` listener redacts any occurrence of a live secret
  value from every tool result the model can see and scrubs bash spill files
  written for truncated output.
- `revoke_secret <handle>` forgets a secret early (idempotent).

## The idle window, and why it is not a lifetime

The timer used to be armed once when a secret was collected and never moved, so a run longer than
`ttlMinutes` lost its credential part way through and the owner had to supply it again. The window
now restarts every time the value is handed to a command of the owning session, which makes
`ttlMinutes` the time a secret survives WITHOUT BEING USED.

The signal is coarser than "the command read the variable": the shell-env
contributor is invoked for each command of that session, so a command that does
not mention the variable also refreshes it. That is deliberate. Matching the
command text for the variable name would expire a credential during a long
stretch of work that happened not to name it, which is the failure this removes.

`ttlRefreshOnUse: false` restores a fixed lifetime from collection, for a
deployment that prefers a hard cap. The memory bound is then "no secret older
than `ttlMinutes`"; with the refresh on it is "no secret that has been idle for
`ttlMinutes`", which is the bound that matches when a secret is actually needed.
A restart of the service still forgets everything immediately, because nothing
touches disk.

## Security model

What is protected:

- The value never appears in the agent's context, the conversation, the
  session JSONL, or any logger.
- The GUI input is masked (`<input type="password">`) with a show/hide toggle
  so the user can verify what they typed.
- Tool output is redacted (`[redacted]`) as a safety net for accidental
  leakage, including spill files.

Deliberate limits (why they exist): a model that is allowed to *use* a secret
in arbitrary commands can always exfiltrate it (for example
`echo $DSH_SECRET_x | base64`); the value must pass through the command's
process space to be usable. Redaction catches direct and accidental leakage;
deliberate exfiltration shows up in the trajectory as redacted output and is a
user-visible policy violation. Values shorter than `minRedactLength`
(default 4) are deliberately NOT redacted, so a pathological short secret (a
single dash, say) cannot destroy the readability of every tool result; real
tokens, passwords, and PINs are at least 4 characters and stay fully
redacted. Values at or above the floor are always redacted, so a 4-character
secret like "card" blanks every "card" in output, which is the safe failure
direction.

The secret never touches disk, so a restart of dsh forgets everything
immediately.

## How it works

Host half (`src/index.ts`):

- `prompt_secret` calls `ctx.userQuestions.ask()` with one question per secret
  field, each with `header` set to the marker `dsh-secret`. The web provider
  forwards questions as JSON, so the marker rides the schema'd `header` field:
  the browser's wire schema strips unknown fields (zod strict object), so a
  custom `input` field would silently disappear. This is why the marker
  convention exists. A multi-field call sends one question per field and puts
  the dialog title after a colon in the first question's header
  (`dsh-secret: <title>`); the whole batch must be answered, so several
  credentials are collected in one dialog.
- The answers arrive as `{ id, selected: [], custom: "<value>" }` per field and
  are stored in the in-memory `SecretStore` under random 80-bit handles, with
  a `ctx.shellEnv.register(...)` contributor per handle that exposes it as
  `DSH_SECRET_<handle>` only to the owning session's shell executions. All
  answers are validated before any is stored, so a half-filled batch cannot
  leave partial secrets behind.
- `revoke_secret` removes a store entry, disposes its env contributor, and
  cancels its TTL timer.
- The `tools/post-execute` listener (registered with `prepend: true`, following
  the pattern of `dsh-spill-policy`) replaces secret occurrences in result
  content, block feedback, and value-replacement payloads, and scrubs spill
  files named in the result or its "full output: <path>" notices.
- A `tool:secret-prompt` system-prompt section steers every agent toward the
  tool ("collect credentials with prompt_secret, never ask the user to type a
  secret into chat") so future sessions discover it without documentation.

Browser half (`src/client`):

- Registers a `conversation.composer` chain entry with `priority: -20`, so it is
  tried before the generic question composer (default priority 0). The chain
  hands every entry the Session's `pendingInteraction` and keeps the first
  entry whose `select` returns non-null, so `selectSecretQuestion` claims the
  question card only when **every** question in it carries the `dsh-secret`
  header. Everything else returns `null` and the generic composer keeps it.
- Renders a card with one input per question, masked (`type="password"`) unless
  the owner reveals it. The reveal control is a labelled button (`Show` / `Hide`,
  eye glyph, `aria-pressed`), not an unlabelled icon: the value is concealed by
  default and showing it is a deliberate one-click action. Shared credentials
  are masked field by field, and the card never renders a value as text unless
  it was revealed.
- Answers through the card's own channel (`card.answer({ answers })`,
  `card.dismiss()`), so the host's `ask()` settles exactly as if the generic
  composer had answered. The card is duck-typed (`kind`, `questions`, `answer`,
  `dismiss`) because a plugin bundle must not require a dynamic client package
  (the module table seeds only the platform rows), and a read-only review card
  is never claimed: it replays a settled call's answers, which must not be
  resubmitted.

## Layout

- `src/index.ts`: host plugin: tools, secret store, env injection, redaction.
- `src/client/`: browser plugin: composer entry, masked prompt card, locales.
- `scripts/smoke-test.mjs`: host-half test: loads the built `lib/index.js`
  against a mock context and drives the whole secret lifecycle (storage,
  per-session env injection, redaction of content/feedback/value payloads and
  spill files, capacity, the idle window).
- `scripts/client-test.mjs`: browser-half test: loads the built
  `lib/client.js` through a stub module loader and asserts the routing
  selector's decisions and the card's markup (masked by default, labelled
  reveal control, escaped copy).
- `scripts/deploy.sh`: build, install into the web profile, patch the loader
  entry, restart `dsh.service` (falls back to the user systemd D-Bus API when
  `systemctl --user` is unreachable from the dsh bash sandbox).

## Install

```sh
dsh plugin --profile web add @theoabw/dsh-secret-prompt
```

Then add the loader row to your profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- insert:
    - id: secret-prompt
      name: '@theoabw/dsh-secret-prompt'
```

The plugin has a host half and a browser bundle, so the restart that mounts the
row is what makes both appear. Restarting ends live sessions, so do it when that
is acceptable.

### From a checkout

```sh
git clone https://github.com/theoabw/dsh-secret-prompt
cd dsh-secret-prompt
pnpm install
bash scripts/link-deps.sh   # symlink the running dsh install's @deepseek-ai packages
bash scripts/deploy.sh      # build, install as a file: dependency, add the row, restart
```

`scripts/deploy.sh` targets the `web` profile by default; set `DSH_PROFILE`, and
`DSH_HOME` if the harness home is not `~/.dsh`, for another profile. `lib/` is
build output and is not committed: `pnpm run build` produces it, and `pnpm test`
expects it.

## Configuration

All options live in the `secret-prompt` loader entry in
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: secret-prompt
      name: '@theoabw/dsh-secret-prompt'
      config:
        ttlMinutes: 60            # IDLE minutes before a secret is forgotten (default 60)
        ttlRefreshOnUse: true     # using a secret restarts that window (default true)
        maxSecretsPerSession: 20  # per-session simultaneous secret cap (default 20)
        minRedactLength: 4        # shortest value redacted from output (default 4)
```

## Upgrading dsh

Three contracts can drift on a dsh upgrade, and the first one already did:

- The `conversation.composer` chain currency. Up to dsh 0.2.1 an entry's
  `select` received `{ interactions }` and the matched value was an ad-hoc
  carrier with `payload.questions` and a `respond(decision)` wrapper. Since
  0.2.2 the owner props are `{ sessionId, session, pendingInteraction }`, the
  currency is the question card itself (`questions`, `answer()`, `dismiss()`,
  `review`), and a crashed selector is swallowed as a decline, so a stale
  plugin silently falls back to the unmasked generic question card instead of
  failing loudly. `src/client/index.ts` types the selector against the
  installed `ComposerChainProps`, and `scripts/client-test.mjs` pins the
  decisions.
- The question wire schema in the browser (`askUserQuestionItemSchema`): if it
  ever grows a field that replaces the `header` marker convention, prefer it.
- The `tools/post-execute` decision shape and the `@deepseek-ai/dsh-tools`
  exports (`JsonValue` moved to `@deepseek-ai/dsh-util-values` in 0.2.2).
  `pnpm run typecheck` catches both.

`@deepseek-ai/dsh-client-ui-primitives` is compiled into the web shell and has
no npm copy, so its surface is declared ambiently in
`src/client/css-modules.d.ts`; the icon names churn between releases (0.2.2
dropped the `Icon*16` set), which is why this card draws its own glyphs.

## Test

```sh
pnpm run typecheck
pnpm run test          # client-test + smoke-test, both against lib/
```

## See also

[dsh-secrets](https://github.com/theoabw/dsh-secrets) is the broker half from the
same author: instead of collecting one credential mid-task, it grants a session
scoped, time-bounded access to a provider (a vault CLI, or an in-process
Bitwarden login) and puts values into command environments without them ever
reaching the model.
