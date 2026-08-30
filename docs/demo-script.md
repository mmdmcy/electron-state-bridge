# 60–90 second demo script

**0–10 seconds — frame the contract**

“This is a reusable Electron state manager, not just two windows sending JSON.
Main is the only writer. Each renderer has a stable immutable snapshot that
React reads through `useSyncExternalStore`.”

Point to the bridge revision and client status in both windows.

**10–25 seconds — create shared state**

Start a synthetic session in the overlay, then emit two transcript segments.
Show that the dashboard updates without a refresh and that revisions increase.

**25–40 seconds — prove intent-based concurrency**

Click **Dispatch competing append pair** in the dashboard. Explain: “These are
two append actions, not two replacements of a stale transcript array. Main
reduces them in order, so both survive.” Show both lines and the increased
transcript revision.

**40–55 seconds — main-only effect and acknowledgement**

Request an insight. The renderer may create only the pending request; main
publishes the synthetic result. Mention that renderer attempts to publish are
rejected in tests.

**55–70 seconds — reload and recovery**

Click **Reload renderer** in the dashboard. The new renderer store subscribes,
hydrates the latest full snapshot, and immediately shows the existing session.
Then click **Full resync** and point to the unchanged revision.

**70–85 seconds — bounded synchronous experiment**

In the overlay, click **Toggle overlay flag with bounded dispatchSync**. Point
to the measured blocking duration. Explain: “The returned commit snapshot is
installed before this call returns, but other windows still repaint through
normal events. Only three pure UI actions are allowed; transcript and session
actions are denied, and the full snapshot must stay under the configured byte
budget.”

Close with: “The important result is the protocol: typed intent, one writer,
ordered revisions, acknowledgements, stable React snapshots, and gap recovery.”
