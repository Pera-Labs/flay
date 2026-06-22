# Flay

In-app overlay for React Native / Expo apps: a snapshot card, a bug list, and a
bug reporter. Triggered by shake / screenshot / pinch, it lets testers file bugs
(with an optional screenshot) without leaving the app.

## Install

```bash
npm install github:Pera-Labs/flay#v0.3.0
```

Pin to a tag so builds are reproducible; bump the tag to pick up new features.

## Usage

Wrap your root component with `FlayProvider` and point it at your bug-reports endpoint:

```jsx
import { FlayProvider } from 'flay';

export default function App() {
  return (
    <FlayProvider
      config={{ appName: 'My App', appId: 'my-app', version: '1.0.0', endpoint: 'https://example.com/api/bug-reports' }}
    >
      <AppInner />
    </FlayProvider>
  );
}
```

`endpoint` receives `POST { appId, version, note, screenshot }` for new reports and `GET ?appId=<id>` for the bug list.

## Expo config plugin

Flay ships an Expo config plugin that injects its native iOS sources during `expo prebuild`. Add it:

```js
plugins: ['flay']
```

## Triggers

Shake the device, take a screenshot, or pinch to open the overlay.
