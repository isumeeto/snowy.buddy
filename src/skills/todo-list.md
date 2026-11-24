# Snowy to-do list

## Purpose

Keep a small, persistent personal task list in Snowy's local application data.

## Tool mapping

- Add a task: `add_todo` with the user's wording.
- Show open items: `list_todos` with `includeCompleted: false`.
- Include finished items only when asked: `list_todos` with `includeCompleted: true`.
- Mark one uniquely identified task done: `complete_todo` with the exact task text or its returned ID.
- Remove one task only when explicitly asked: `remove_todo` with its exact task text or ID.

## Accuracy rules

- Preserve task wording; do not reinterpret it as a reminder or calendar event.
- Report success only when the tool returns `added`, `completed`, or `removed` as true. If a duplicate is returned, say it was already on the list.
- If a search matches multiple tasks, ask which one; do not guess.
- Tasks remain local to this PC in `userData/snowy-todos.json`.
