# Flay

In-app overlay for React Native / Expo apps — snapshot card, bug list, bug reporter. Triggered by shake / screenshot / pinch gesture (handled by the FlayBridge native module).

## Install

```json
{
  "dependencies": {
    "flay": "github:Pera-Labs/flay#v0.4.0"
  }
}
```

```bash
npm install
npx expo prebuild --clean
```

The Expo config plugin (`./app.plugin.js`) injects the iOS native sources (`FlayDeck.{h,m}`, `FlayBridge.{h,m}`) into the generated `ios/` project on every prebuild — never copy them manually.

## Wire up

Wrap your root component with `FlayProvider`:

```jsx
import { FlayProvider } from "flay";

function AppInner() { /* ... */ }

export default function App() {
  return (
    <FlayProvider
      config={{
        appName: "ToneAdapt",
        appId: "toneadapt",
        version: "1.0.5",
        endpoint: "http://100.107.27.3:8091/api/bug-reports",
      }}
    >
      <AppInner />
    </FlayProvider>
  );
}
```

`endpoint` must be the canonical Friday cockpit-unified server route. Do not hardcode a default in app code — pass it via config.

## Required Info.plist key

If the endpoint is `http://` (Tailscale-private), add to `app.config.ts`:

```ts
ios: {
  infoPlist: {
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }
  }
}
```

Otherwise ATS blocks the request and the user sees "Hata. Tekrar dene." with no diagnostic.

## Compatibility matrix

| Flay      | Expo SDK | React Native | React |
|-----------|----------|--------------|-------|
| v0.4.0    | 53+      | 0.74+        | 18+   |
| v0.3.0    | 52+      | 0.73+        | 18+   |

`peerDependencies` of v0.4.0+ enforce the floor — `npm install` fails loudly on older runtimes rather than producing a runtime crash.

## v0.4.0 — retry + toast (HARD RULE fix)

Bug submit no longer fails silently when the endpoint is unreachable:

1. Failed POSTs are queued in-memory (capped at 10 entries).
2. Queue is replayed on every app foreground (`AppState` → `active`).
3. Each submit attempt shows a brief toast: `Gönderildi`, `Bağlanılamadı — tekrar denenecek`, or `Tekrar denendi: <N> gönderildi`.

Queue is in-memory only (lost on app kill) — for durable retry, future work will persist to AsyncStorage.

## v0.3.x → v0.4.0 migration

No API change. Just bump the tag, run `npm install`, `npx expo prebuild --clean`, rebuild.

## Trigger gestures

- **Shake**: open Flay overlay
- **Screenshot**: open Flay overlay (iOS user-triggered screenshot detection)
- **Pinch (3-finger)**: developer fallback when the device gesture is unreliable

All handled in `FlayBridge.m` — no JS-side gesture handlers required.

## Bug submit endpoint contract

POST `{appId, version, note, screenshot, source, ts}` to `<endpoint>`. Response shape:

```json
{ "ok": true, "id": "<bug-id>" }
```

Anything else (HTTP non-2xx, network error, JSON parse fail) triggers the retry queue.

## License

MIT — see `LICENSE`.
