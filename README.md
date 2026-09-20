# Jevfiller

Jevfiller is an Oh My Pi custom tool that fills a **visible, already-running Playwright browser**. It does not launch Chrome, create a browser context, create a tab, or submit an application.

The public surface is intentionally one tool:

```text
jevfiller({
  playwrightServerId,
  url,
  tab,
  answers,
})
```

## Browser ownership

The caller owns the browser. Jevfiller only attaches to the endpoint and detaches after the fill.

### Playwright protocol endpoint

A browser owner can expose an existing Playwright browser with `Browser.bind()`:

```js
const { endpoint } = await browser.bind("career-ops", {
  host: "127.0.0.1",
  port: 0,
});
```

Pass the returned `endpoint` as `playwrightServerId`. Jevfiller uses `chromium.connect(endpoint)`.

### Existing Chrome through CDP

If the owner starts Chrome with remote debugging enabled, pass its CDP HTTP endpoint instead:

```text
http://127.0.0.1:9222
```

Jevfiller uses `chromium.connectOverCDP()` and works with the existing default context and tabs.

`playwrightServerId` is the tool's public field name for either native endpoint. An opaque registry name is not a native Playwright endpoint and is rejected; the owner must resolve it before calling Jevfiller.

## Call shape

- `playwrightServerId` — a `ws://`/`wss://` Playwright endpoint or `http://`/`https://` CDP endpoint.
- `url` — the application URL. Jevfiller navigates the selected existing tab to it while preserving that browser context's state.
- `tab` — optional numeric tab index, exact URL, or exact title. Defaults to `0`.
- `answers` — values keyed by the live field id, native id/name, or exact field label. Values may be strings, numbers, booleans, or `{ value, needs_confirmation }` objects.

Example:

```json
{
  "playwrightServerId": "ws://127.0.0.1:43125/abc",
  "url": "https://jobs.example.com/apply/123",
  "tab": 0,
  "answers": {
    "First name": "Example Applicant",
    "Highest education": "Master's Degree",
    "Why do you want to work here?": "I want to build reliable hiring infrastructure."
  }
}
```

## Safety contract

- Never calls a final `Submit`, `Send`, `Apply`, `Finish`, `Complete`, or consent control.
- Only clicks explicitly safe intermediate controls such as `Next`, `Continue`, `Save and continue`, or `Proceed`.
- Legal, consent, sponsorship, work-authorization, salary, demographic, disability, veteran, immigration, relocation, privacy, terms, and similar fields stay for human confirmation.
- Ambiguous finite-option matches stay for review. If `TYPESAFE_API_KEY` is configured, unresolved options and post-fill values are checked in one batched Jev request per page.
- Re-reads the live DOM after filling and reports mismatches and required fields that remain empty.
- Returns `submitted: false` and `verificationRequired: true` only; the human reviews and performs the final action.
- Does not return screenshots or page HTML to the model.
- Does not close the owner's browser or page. The Playwright connection is detached after the call.

## Development

```bash
npm install
npx playwright install chromium
npm test
npm run check
npm run pack:check
```

The browser smoke test starts a local form, exposes an existing Playwright browser endpoint, invokes the single Jevfiller tool, and verifies the values in the owner-held page. It also verifies that the final submit control was untouched.

## Oh My Pi installation

From a GitHub checkout:

```text
/marketplace add todaymare/jevfiller
/marketplace install jevfiller
```

The package metadata declares `tools/jevfiller.mjs` as the OMP custom tool entrypoint.
