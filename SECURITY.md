# Security policy

This plugin exists so that a credential can reach a command without reaching the
model. The limits below are part of that design, not caveats discovered later.

## Reporting

Use GitHub's private "Report a vulnerability" form on this repository, or email
theo@tabw.dev. Please do not open a public issue for a vulnerability.

## What is protected

- The value never enters the conversation, the trajectory, the tool results or
  the session log.
- The tool result carries a handle and an environment-variable name; the value
  is injected into the shell command that asks for it.
- Values live in host process memory, are scoped to the session that requested
  them, and are forgotten after an idle window that each use restarts.
- While a value is live, it is redacted from every model-visible tool result and
  from spill files the shell executor wrote for truncated output.

## What is not protected

- **A session that holds a value can exfiltrate it** through a command it is
  allowed to run, for example by encoding it. Redaction matches exact text.
- **There is no OS boundary.** A process running as the same user can read the
  host process's memory, and the agent's shell runs as that user.
- Values shorter than `minRedactLength` are not redacted, so a pathological
  short value cannot destroy the readability of every tool result.

## In scope for a report

- A way to get a value into a model-visible result, the log, or the trajectory.
- Bypassing the handle scoping so another session sees a value.
- A redaction gap that lets an exact live value through.
- Any network, filesystem or process access the README does not describe.

## Supported versions

The latest published minor version receives fixes. This is a young project;
pin an exact version in your profile if you need a stable surface.
