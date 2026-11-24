# Snowy desktop companion

A small Windows desktop companion for quick conversations, reminders, research, and everyday tasks.

## Features

- **1-Bit Pixel Display**: A full-screen 160×90 canvas scaled with nearest-neighbor rendering, featuring only expressive eyes and a mouth.
- **Movable Floating Window**: A 150×116 frameless companion with a drag handle; Snowy stays above other apps and stays within the active display when changing modes.
- **Google Gemini Live (WebSockets)**: Ultra-low-latency real-time bidirectional audio streaming using `gemini-3.8-live` and Web Audio API PCM16 downsampling/playback.
- **Push-to-Talk & Interruption**: Press and hold to talk with instant audio cut-off and server-side interruption when speaking.
- **Keyboard Push-to-Talk**: Hold Space to speak; release it to send.
- **Hands-Free Wake Phrase**: Say “Hey Snowy, wake up” to get Snowy’s attention and a spoken reply. Snowy uses Chromium speech recognition while the app is open; microphone access and the speech service must be available. Ordinary background speech is ignored.
- **Typed Chat**: Send a message from the text field under Snowy's display.
- **Desktop Actions**: Open apps and websites in Snowy's Chrome window, play music on the requested service, and use Windows UI Automation to inspect named controls before acting on them.
- **Grounded Web Research**: Use Gemini with Google Search for current questions; Snowy returns source links in a small in-app panel. When Gemini Search is quota-limited or unavailable, Snowy uses GDELT and Google News RSS for news, then direct DuckDuckGo HTTP search and managed-browser results. Gemini Search cooldowns persist so Snowy avoids repeated requests against an exhausted quota.
- **Persistent Memory**: Save, recall, and remove user-requested preferences, facts, and workflows. Snowy stores these locally in its Windows app data JSON database and refuses to store credentials.
- **Reusable Skills**: Save named plain-language workflows on request, then retrieve them when useful. Skills are instructions only; Snowy does not execute skill files as code.
- **WhatsApp Replies**: Use visible Windows controls to inspect the chat, verify the recipient, and type the exact dictated reply. Snowy sends only when explicitly asked and the target control is unambiguous.
- **Exact Voice Dictation**: Dictate exact wording into a freshly inspected, named app field. Snowy reads the field back before claiming it was typed; WhatsApp drafts require a fresh screen check of the selected recipient and are never sent automatically.
- **WhatsApp Notifications**: Visible new WhatsApp banners can be read aloud without opening the chat; enable or disable this in conversation.
- **Screen Actions**: Ask Snowy to inspect the screen, click a visible control, or type dictated text. Stale clicks trigger a fresh screen capture, and Windows accessibility labels are preferred when available.
- **Idle Cat Mode**: After 10 seconds without activity, the panel folds away before revealing a transparent 92×112 cat. It stays in place, blinks, and gently swishes its tail; click it to reopen Snowy.
- **Reminders**: Create, list, or cancel local reminders by voice. Pending reminders persist across app restarts and trigger a Windows notification and voice announcement.
- **To-Do List**: Add, list, complete, and explicitly remove tasks in a persistent local list. Snowy preserves wording and asks when a task match is ambiguous.
- **Daily Research Automations**: Schedule, list, or cancel daily read-only web research at a local time. Jobs persist across restarts and deliver a Windows notification and spoken summary while Snowy is running.
- **Scoped File Search**: Choose folders through a native folder picker, then list or search filenames inside those approved folders. Snowy does not read or modify file contents in this first version.
- **File Organization Preview**: Say “organize my Downloads” to open Windows Explorer and preview type-based folders for its top-level files. Snowy skips hidden and credential-like files, blocks recognized code project roots, and asks for approval before moving anything.
- **Clipboard Reading**: Ask Snowy to read copied text; clipboard contents are only read on request.
- **Live Transcript Preview**: Shows interim speech transcripts and reveals replies faster.
- **Startup Greeting**: Snowy greets Sumit by name once, then addresses him as “boss” in later replies. When asked to introduce herself, she says she was made by Sumit sir and briefly explains what she can do. If Gemini cannot connect, Snowy uses the installed female Windows voice for a brief greeting.
- **Windows Startup**: Snowy registers itself to launch at Windows sign-in when the app is started.
- **Voice Expressions**: Ask Snowy to show an expression. It changes the face only; Snowy does not have feelings.
- **Pixel Themes**: Chestnut, cocoa, and walnut browns on cream. Press 1, 2, or 3 to switch; press H for the hidden state preview.
- **Local Gemini Key**: Snowy reads the configured key from the project's local `gemini-api-key.txt` file.
- **Hindi Voice Grammar**: Snowy is instructed to use feminine self-reference when speaking Hindi.

## Run locally

```sh
npm install
npm run dev
```

Snowy reads your **Google Gemini API key** from `gemini-api-key.txt` beside `package.json`. Create that file locally and put only your key in it; Git ignores the file. Never commit or share your API key. If a key was ever committed or shared, revoke it in Google AI Studio and create a replacement. The app needs microphone access for voice input and hands-free wake-up. If voice wake-up is unavailable, hold **Space** to talk. Daily automations use your Windows local time and run while Snowy is open.

For local state previews, press **H** to open the debug bar. A browser `snowy:pixel-update` event may provide `{ state, dialogueText, moodLevel, theme }`; set `SNOWY_PIXEL_SOCKET=ws://127.0.0.1:8765` before launching to connect a local WebSocket backend.
