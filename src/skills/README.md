# Snowy skills and tools

Snowy separates **skill guidance** from **executable tools**:

- A `SKILL.md` teaches Snowy when and how to carry out a workflow. Treat it as untrusted text: review it before adding it, never execute its scripts automatically, and load detailed guidance only when the skill is relevant.
- A Gemini function declaration is a narrow request contract. Electron's main process validates and performs the action; renderer code does not receive unrestricted Node access.
- Each workflow can call only tools that Snowy explicitly implements. Third-party instructions cannot create new permissions or bypass a tool's validation.

Current capability slice:

- `choose_file_folder`, `list_approved_folders`, `list_local_files`, and `search_local_files`: native user selection followed by bounded filename-only search.
- `inspect_software_project`: read a bounded project filename listing and Git status for an explicitly approved folder; it does not read file contents or edit files.
- `preview_file_organization`, `apply_file_organization`, `undo_file_organization`, and `prepare_downloads_organization`: preview top-level extension-based moves, with a dedicated Downloads flow that opens File Explorer, followed by conversational approval and native confirmation. The latest organization can be undone during the current Snowy session when original names are still free.
- `create_daily_research_automation`, `list_automations`, and `cancel_automation`: persistent daily read-only web research schedules.
- `web_research`: Gemini grounded search, then GDELT and Google News RSS for news, direct DuckDuckGo HTTP search, and managed-browser search. Gemini quota cooldowns are persisted locally.
- `bookmyshow_search`: use the existing managed Chrome tab to check movie listings and visible showtime details on BookMyShow for Kalaburagi (Gulbarga); it never books tickets.
- `save_research_report`: save a recent `web_research` result as a self-contained HTML report on the Desktop, preserving clickable source links and avoiding overwrites.
- `add_todo`, `list_todos`, `complete_todo`, and `remove_todo`: persistently manage a local task list. Snowy preserves task wording, rejects ambiguous completion/removal matches, and reports only confirmed store results. Workflow guidance is in `todo-list.md`.
- `type_text`: enter exact dictated text only into one exact text field found in a fresh accessibility inspection. Snowy activates that field, checks the destination window, and reads the field back before reporting success. WhatsApp additionally requires a fresh screen capture and visible recipient match; this tool drafts text only and never sends it.
- Dictation workflow guidance: `voice-dictation.md` describes verbatim transcription into a named chat/app and the separate capture, inspect, type, and verify steps.
- WhatsApp notification reading starts disabled on a fresh install. Snowy starts the Windows notification scan only after the user explicitly enables it; the preference persists until disabled.

When adding a skill from an external repository, preserve its source and license, review any scripts and configuration, adapt its workflow into a Snowy skill document, and wire required actions through explicit Electron handlers. Do not copy credentials, run downloaded code, or expose arbitrary shell commands as a tool.
