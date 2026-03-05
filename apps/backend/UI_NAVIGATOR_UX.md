# UI Navigator UX States

## Surfaces

- Extension icon badge + tooltip
- Extension popup
- Extension options page
- App Navigator tab (`/navigator`)

## States and Copy

- Attached:
  - Badge: `ON` (green)
  - Tooltip: `Oi: Tab attached (click to detach)`
  - Popup: `This tab is attached.`
- Not attached:
  - Badge: empty
  - Tooltip: `Oi: Click to attach current tab for automation`
  - Popup: `This tab is not attached.`
- Connecting:
  - Badge: `...` (neutral)
  - Tooltip: `Oi: Connecting to relay...`
  - Popup status: `Connecting…`
- Relay error:
  - Badge: `!` (red)
  - Tooltip: `Oi: Relay not reachable. Open popup/options to fix.`
  - Popup hint: `Open setup to fix relay URL or start backend.`

## Actionable Errors

- No tab attached:
  - `No tab is attached. Open the tab you want to control and click the Oi extension icon to attach it.`
- Relay unreachable:
  - `Can't connect to the relay. Make sure Oi backend is running and relay URL is correct in setup.`
- Tab detached during run:
  - `The attached tab was closed or detached. Attach a tab and try Run now again.`
