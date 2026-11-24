# Exact voice dictation into an app

## Workflow

1. Treat text after an explicit instruction such as “type this” or “write exactly” as dictation. Keep its words, order, names, and meaning verbatim; do not turn it into an assistant-written reply. Do not invent a message body if the user only said “type something.”
2. Ask which app or recipient when the destination is unclear.
3. Call `inspect_accessibility` for the named app and select one exact visible text field from its current controls.
4. For WhatsApp, first call `capture_screen`, then inspect WhatsApp controls. Read the open chat header in the screenshot and confirm it matches the requested recipient. If no exact active chat is open, do not type; ask the user to open or identify it.
5. Call `type_text` in a separate tool step with the exact dictated text, window hint, text field name/type, and WhatsApp recipient when relevant. This tool focuses the selected field and checks that the app is still active.
6. Report that a draft was typed only when the tool returns `verified: true`. If it cannot read the text back from the field, explain that it could not verify the draft. Never press Enter or send unless the user explicitly asks to send.
