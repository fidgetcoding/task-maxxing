# Notion database schema

The `task-maxxing` pipeline expects a single Notion database with the
property shape below. The exact **names** of the properties matter — the
sync-helpers library and all three workflows reference them literally. If
you rename a property in Notion, you must update `src/sync-helpers.js`
accordingly.

## Suggested database name

> **Tasks — Obsidian Sync**

(Any name works — only the database ID is used at runtime.)

## Properties

| Name            | Type         | Purpose                                                                |
|-----------------|--------------|------------------------------------------------------------------------|
| `Task`          | title        | The task body (cleaned text, priority/date emojis stripped).           |
| `Area`          | select       | Which area file the task lives in. See **Area options** below.         |
| `Priority`      | select       | Obsidian Tasks priority. See **Priority options** below.               |
| `Status`        | status       | One of `Not started`, `In progress`, `Done`. See **Status options**.   |
| `Due`           | date         | Obsidian `📅 YYYY-MM-DD` — bare date only.                             |
| `Scheduled`     | date         | Obsidian `⏳ YYYY-MM-DD` — bare date only.                             |
| `Parent Task`   | rich_text    | Optional: the hash of the parent task for subtasks. Free-text.         |
| `Source File`   | rich_text    | Relative path inside your 06-Tasks dir (e.g. `TASKS-URGENT.md`).       |
| `Hash`          | rich_text    | 24-char SHA-256 prefix computed by `computeTaskHash()`. Dedup anchor.  |
| `Last Synced`   | date         | ISO-8601 timestamp last touched by any workflow.                       |

Every property except `Task` is optional from Notion's perspective —
it's fine to leave a row with a missing `Due` or `Priority`. But each
property **must exist** on the database, because the sync code reads it
by name even when the value is empty.

## Area options

`task-maxxing` ships with 12 canonical area keys. The Notion select
options are the number-prefixed labels below — they're intentionally
sorted by the numeric prefix so Notion's select UI orders them naturally.
The `U+00B7` middle-dot (·) separates a parent area from a sub-area.

| Internal key                   | Notion select label                     |
|--------------------------------|-----------------------------------------|
| `URGENT`                       | `01 URGENT`                              |
| `GENERAL`                      | `02 GENERAL`                             |
| `LORECRAFT`                    | `03 LORECRAFT`                           |
| `BLOOM`                        | `04 BLOOM`                               |
| `CART-BLANCHE`                 | `05 CART-BLANCHE`                        |
| `FIDGETCODING-CONTENT`         | `06 FIDGETCODING · content`              |
| `FIDGETCODING-MISC-BUILDING`   | `07 FIDGETCODING · misc-building`        |
| `FUTURE-SCHEDULING`            | `08 FUTURE-SCHEDULING`                   |
| `LAVA-NETWORK`                 | `09 LAVA-NETWORK`                        |
| `MMA`                          | `10 MMA`                                 |
| `PARZVL`                       | `11 PARZVL`                              |
| `WAGMI`                        | `12 WAGMI`                               |

**Customizing areas:** these labels are a template — you are expected to
rename them to match your own projects. When you do, update **all** of:

1. `NOTION_AREAS` in `src/sync-helpers.js` (map internal key → Notion label).
2. `AREA_TO_FILE` in `src/sync-helpers.js` (internal key → relative path).
3. `SAFE_PATH_RE` in `src/sync-helpers.js` (regex allowlist of safe paths).
4. The `Area` select options in Notion (via the UI or API).
5. Any area-specific tag names in your Morgen account, if you've already
   created them — or delete them and let the next backfill recreate them.

The internal keys never appear in Notion; they're just how the JavaScript
refers to each area. You can keep them the same or rename them too.

## Priority options

These are the five Obsidian Tasks priority levels, each with its emoji
prefix so the Notion UI shows the same glyph as the markdown source.

- `🔺 Highest`
- `⏫ High`
- `🔼 Medium`
- `🔽 Low`
- `⏬ Lowest`

Leave the select empty for tasks with no priority emoji. The mapping
(emoji ↔ integer ↔ Notion label) is centralized in
`src/sync-helpers.js` — search for `PRIORITY_INT_TO_NOTION`.

## Status options

Notion's `status` property type comes with three option groups by
default (`To-do`, `In progress`, `Complete`). The pipeline only reads
and writes three specific option **names**:

- `Not started`
- `In progress`
- `Done`

If your Notion workspace already has a `status` property with different
labels, rename them to match, or update the string literals in
`src/sync-helpers.js` and the three workflow Code nodes.

## Creating the database

### Option A — Notion UI

1. Create a new full-page database: `/Database > Full page`.
2. Name it **Tasks — Obsidian Sync** (or whatever you prefer).
3. Add each property from the table above. For each, pick the right
   **property type** and populate the options (for select/status).
4. Copy the database ID from the share link
   (`https://www.notion.so/<workspace>/<DBID>?v=…`). The ID is the
   32-char hex string before `?v=`; both dashed and undashed forms are
   accepted by the API.
5. Set `NOTION_DATABASE_ID=<that id>` in your `.env`.

### Option B — Notion API

Use the `/v1/databases` create endpoint with a payload like:

```json
{
  "parent": { "page_id": "<your-parent-page-id>" },
  "title": [{ "type": "text", "text": { "content": "Tasks — Obsidian Sync" } }],
  "properties": {
    "Task":        { "title": {} },
    "Area":        { "select": { "options": [
      { "name": "01 URGENT" },
      { "name": "02 GENERAL" },
      { "name": "03 LORECRAFT" },
      { "name": "04 BLOOM" },
      { "name": "05 CART-BLANCHE" },
      { "name": "06 FIDGETCODING · content" },
      { "name": "07 FIDGETCODING · misc-building" },
      { "name": "08 FUTURE-SCHEDULING" },
      { "name": "09 LAVA-NETWORK" },
      { "name": "10 MMA" },
      { "name": "11 PARZVL" },
      { "name": "12 WAGMI" }
    ]}},
    "Priority":    { "select": { "options": [
      { "name": "🔺 Highest" },
      { "name": "⏫ High" },
      { "name": "🔼 Medium" },
      { "name": "🔽 Low" },
      { "name": "⏬ Lowest" }
    ]}},
    "Status":      { "status": {} },
    "Due":         { "date": {} },
    "Scheduled":   { "date": {} },
    "Parent Task": { "rich_text": {} },
    "Source File": { "rich_text": {} },
    "Hash":        { "rich_text": {} },
    "Last Synced": { "date": {} }
  }
}
```

Note that Notion's API creates `status` properties with its default
option groups — you may need to rename them via the UI afterward to
match `Not started` / `In progress` / `Done`.

## Share it with the integration

Whichever path you took, make sure the database is **shared** with the
internal integration whose token is in `NOTION_TOKEN`. Open the database
in Notion -> `…` menu -> `Add connections` -> pick your integration.
Without this step, the Notion API will return 404 even with a valid ID.
