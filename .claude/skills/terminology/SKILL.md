---
name: terminology
description: Reserved short names the user uses for the two machines in this project's Call Bridge setup ("local" and "laptop"). Use whenever the user's message contains either word, to resolve which machine they mean without asking.
---

# Project terminology: "local" and "laptop"

This project bridges a Microsoft Teams call between two separate computers. The user refers to
them with two fixed, reserved words instead of full descriptions:

| Word | Means | Runs |
|---|---|---|
| **local** | The user's own computer | The `operator-shell` desktop app (the "Call Bridge" / "local app" Electron exe) |
| **laptop** | The other computer | The `teams-auto-answer` Chrome extension, actually joined to the Teams call/meeting |

## How to apply

- Treat these as fixed vocabulary for this project, not ambiguous words needing clarification.
  Example: "The sound is clear on local" = audio is fine on the operator-shell app's side.
  Example: "Is audio coming through clearly on laptop?" = is audio reaching the Teams extension's side.
- When reporting findings back (diagnostics, test results, logs), use the same two words rather
  than switching to "the operator app" / "the extension machine" / "the Teams computer", so the
  user doesn't have to re-map terms.
- Don't confuse "laptop" with "the Teams computer" terminology already used elsewhere in this
  repo's own code/docs (e.g. server health fields, README) — those are the same machine; just use
  the user's word when talking to them.
- If a third machine or role is introduced later (e.g. a test caller's computer), ask the user
  what short word they want for it rather than guessing — don't invent new reserved words yourself.
