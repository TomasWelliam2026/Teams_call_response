---
name: teams-call-test
description: Run a live 1:1 Teams call test for this project - Eric Lee calls Jason (the Sisu browser with the extension), Jason answers or the operator app takes it, then check audio both ways. Use when asked to test calling, answering, the extension's call handling, or whether one side can hear the other.
---

# Live 1:1 call test (Eric -> Sisu)

Do `teams-test-setup` first (browsers identified, server running, extension linked, operator app
signed in). All steps run through Claude in Chrome; `select_browser` before every switch.

## Place the call

1. **Sisu first:** make sure Sisu's Teams tab at https://teams.live.com/v2/ is fully loaded (chat list
   visible). If Jason isn't online, the call ends as "Unavailable" on Eric's side.
2. **Eric:** open the chat "Jason ChanMing" and click the **audio call** icon (top right of the chat
   header, next to the video icon; tooltip "Audio call").
3. **Sisu:** wait about 5 s, then screenshot. A toast "Eric Lee is calling you" appears at the bottom
   right with video / audio / decline buttons.

## Answer

Pick one of these, depending on what's being tested:
- **The person answers in Teams:** click the audio-accept button in the toast.
- **The operator answers:** the ring appears in the operator app under "Ringing". Click its answer
  button there.

Confirm on both sides: the call screen with a running timer, and the other party's tile.

## Check audio

To measure instead of guess, use the snippets in `teams-media-measure`:
- **Caller hears the Teams computer?** Install the WebRTC hook on Eric *before* placing the call, then
  read the inbound-rtp audio stats (`hook-pc.js`, `inbound-audio-stats.js`). About 70 bytes/s with
  energy 0 means comfort silence (nothing is being sent).
- **Audio level in the call:** `measure-remote-audio.js` on the receiving side.

## Mute and camera controls

- Eric's own mic and camera are the buttons right of "More" in the call toolbar. Zoom on the toolbar to
  read their state (a slashed icon means off).
- On Sisu, the extension mirrors the operator app's mute onto Teams' own mic button, so the app shows
  "Muted" when Teams is muted. Unmute from the app's Mute button.

## Report

State which side did what, the measured numbers, and anything that ended the call unexpectedly
(who hung up and after how many seconds). Leave the call with "Leave", not by closing tabs.
