# Editable maintenance notice

The admin dashboard's Maintenance notice section includes a text editor, preview,
500-character limit and the existing visibility control.

- **Save message** stores text while the notice stays hidden.
- **Show notice** saves the editor text and enables the banner atomically.
- **Update visible message** changes the text without changing visibility.
- **Hide notice** keeps the saved text and any unsaved editor draft.
- **Use default text** and **Discard changes** change the editor only.

`PUT /api/site-settings/maintenance-notice` accepts an optional boolean `enabled`
and/or string `message`. At least one must be supplied. Messages are trimmed,
whitespace is collapsed, and blank/non-string/over-500-character messages are
rejected before writing either field. Visibility-only clients keep the current
message; message-only clients keep the current visibility. Each successful
update records the admin and time.

The message is stored in `SiteSettings.maintenanceNoticeMessage`. Older records
use the original default notice without a migration. The admin endpoint returns
the saved text even when hidden; the public endpoint exposes custom text only
while enabled and continues to omit admin metadata. Text is rendered as plain
text, including any markup characters.

The editor keeps drafts across polling and failed saves. Confirmed saves are
followed by a status refresh before allowing another action. Customer pages
continue refreshing the notice about every 30 seconds, and existing scrolling,
pause and reduced-motion behavior remains in place.

Verification (no production notice writes):

```sh
node --test tests/maintenanceNotice.test.mjs
NOTICE_TEST_ORIGIN=http://127.0.0.1:5173 node tests/maintenanceNotice.browser.mjs
```

The API test mocks storage and authentication reads; browser checks intercept all
API traffic. Coverage includes drafts, publication, updates, hide/show, validation,
failure recovery, safe text rendering, and desktop/mobile layouts.
