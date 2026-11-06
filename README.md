# friction-replay

[中文说明](./README.zh-CN.md)

Session replay that **only uploads when a user gets stuck**.

The page is recorded with [rrweb](https://github.com/rrweb-io/rrweb) into an in-memory ring buffer (~5 minutes).
Nothing leaves the browser until friction is detected — then the last few minutes **before** the
moment and two minutes **after** it are uploaded as one replay. Same idea as Sentry's
"replay on error", but self-hosted, framework-free and small.

Friction signals:

| Signal | Meaning |
| --- | --- |
| `rage_click` | Same element clicked 3 times within 1 s |
| `dead_click` | A button/link was clicked and nothing happened for 1.5 s (no DOM change, no request finished, no navigation) |
| `error` | Uncaught error / unhandled rejection, same-origin `fetch` that returned 4xx/5xx or failed, or an element marked `data-replay-error` |
| `form_abandon` | Something was typed into a form/dialog that then disappeared or was navigated away from without submitting |
| `manual` | You called `recorder.capture()` (e.g. when the user files feedback) |

## Why

- **Privacy by default** – all inputs are masked, `[data-replay-block]` regions are never recorded, and nothing is uploaded for users who never hit a problem.
- **Cheap** – rrweb is lazy-loaded; recording pauses after 30 s without interaction and while the tab is hidden; if a snapshot ever takes > 250 ms the page stops recording instead of janking.
- **Replays that actually play** – the buffer is segmented by full snapshots, so the "before" part always starts with one. Cross-origin / sandboxed iframes can be merged into the same replay.
- **Safe error context** – failed requests record method, path (no query), status, request id and the `{ error: { code, message } }` envelope, with URLs, tokens, passwords and JWTs redacted.

## Install

```bash
npm i friction-replay @rrweb/record     # recorder
npm i friction-replay @rrweb/replay     # player
```

## Record

```ts
import { createReplayRecorder } from "friction-replay";

const recorder = createReplayRecorder({
  endpoint: "/api/replay",          // parts are POSTed to /api/replay/replays
  app: "my-app",
  onFriction: (event) => analytics.track("friction", event), // optional
});

// e.g. in your feedback dialog:
const replayId = recorder.capture();
```

Mark errors your UI already handles (they never reach `window.onerror`):

```html
<div role="alert" data-replay-error="Could not save the order" data-replay-source="user_action">…</div>
```

| Attribute | Effect |
| --- | --- |
| `data-replay-block` | Region is not recorded at all |
| `data-replay-ignore` | Clicks / inputs inside do not count as friction |
| `data-replay-error` | Visible error message → `error` friction (`data-replay-source`, `-operation`, `-code`, `-reason` optional) |

### Iframes

Inside a cross-origin or sandboxed iframe call `startFrameBridge()` from `friction-replay`.
It forwards activity and friction to the parent and lets the parent merge the iframe's DOM into the same replay.

## Store

A dependency-free Node handler with a file store (swap in your own `ReplayStore` for a database):

```ts
import { createServer } from "node:http";
import { createFileStore, createReplayHandler } from "friction-replay/server";

const handle = createReplayHandler({
  store: createFileStore("./replays"),
  prefix: "/api/replay",
  identify: (req) => getUserId(req),                     // binds a replay to its uploader
  authorizeRead: (req, replay) => isAdmin(req),          // replays contain real screens – required
});

createServer(async (req, res) => {
  if (await handle(req, res)) return;
  // …your other routes
}).listen(3000);
```

- `POST <prefix>/replays` – idempotent per `(replayId, part)`; rejects cross-site uploads, other users' replay ids, bodies > 6 MB and gzip bombs (> 48 MB inflated).
- `GET <prefix>/replays/:id` – both parts merged in time order plus `markerAt` (the friction moment).
- Retention: 30 days by default, pruned lazily on write.

## Play

```ts
import "@rrweb/replay/dist/style.css";
import { createReplayPlayer, replayCoverage } from "friction-replay/player";

const replay = await fetch(`/api/replay/replays/${id}`).then((r) => r.json());
const { playable, warnings } = replayCoverage(replay);   // e.g. "missing_after", "snapshot_only"
if (playable) {
  const player = await createReplayPlayer(document.getElementById("stage")!, replay, {
    onTick: (ms) => (slider.value = String(ms)),
  });
  player.seekToMarker();   // jump to 3 s before the friction
}
```

The player scales the recording to fit its container and strips `sandbox` from recorded iframes so their content renders. Build your own controls on top of `play / pause / seek / setSpeed`.

## Demo

```bash
npm install
npm run demo        # http://localhost:5173
```

Click the buttons to produce each kind of friction, then open the replay from the list.

## Tuning

Every threshold is configurable through `limits` (see `DEFAULT_LIMITS`): click windows, the 5 min / 2 min before-after window, snapshot interval, idle pause, cooldown, max replay size and the per-task work budget.

## Development

```bash
npm test          # node:test + jsdom, runs the TypeScript sources directly (Node ≥ 22.18)
npm run typecheck
npm run build
```

## License

MIT
