# Mobile Viewer Layout Review

Date: July 11, 2026
Status: User-tested and accepted
Current production commit before this note: `500d6c539c9c5bec5593aaa68b4e9194864b989b`

## Scope reviewed

- Mobile header height and spacing
- Queue/search area height
- Sticky record controls
- Record title truncation
- Next and Save Online controls
- Save-status display
- Decision selector
- Notes field
- Previous, Next Pending, and Preview Evidence controls
- Evidence preview spacing and mobile scrolling
- Dropbox sign-in, queue loading, and evidence access after the layout rollback and final tightening
- Desktop isolation through the mobile media query

## Final behavior

- The top application header is reduced on mobile.
- The queue/search section is shorter, leaving more room for evidence.
- The record controls remain pinned at the top of the review pane.
- Notes remain visible and usable at all times.
- The title, buttons, status text, decision selector, notes area, and surrounding spacing are compacted.
- The evidence viewer remains scrollable.
- Dropbox sign-in and evidence loading were confirmed by the user after the working layout was restored.
- The final compact layout was then confirmed by the user as looking good.

## Files changed for this work

- `index.html`
- `assets/mobile-review-layout.css`

No application logic, Dropbox API logic, save logic, or evidence-rendering JavaScript was changed during the final layout tightening.

## Review findings

- HTML structure for the sticky review-control wrapper is balanced and preserves the existing element IDs used by JavaScript.
- The mobile override is limited to `max-width: 820px`, with an additional narrow-phone adjustment at `max-width: 430px`.
- The final CSS keeps Notes permanently available and does not use a collapsible control.
- The cache-busting version in `index.html` points to the final mobile stylesheet revision.
- No GitHub Actions or automated browser test workflow is configured in this repository, so final validation was manual on the user's mobile browser.

## Stable baseline

Treat the current main branch as the stable mobile baseline. Future visual changes should be made one small step at a time and should not modify Dropbox, save, navigation, or evidence-preview JavaScript unless separately tested.
