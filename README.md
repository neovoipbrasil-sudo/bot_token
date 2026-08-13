# Bitrix24 MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that connects **Claude** to your **Bitrix24** portal via an incoming webhook.

Once configured, Claude can read and write CRM records, manage tasks, browse your disk, send notifications, query the product catalog, run business processes, and much more — all from natural conversation.

Built and maintained by **[Bit2Beat](https://bit2beat.com)** — Bitrix24 specialists.

---

## Features

| Area | What Claude can do |
|---|---|
| **CRM** | List, get, create, update, and delete deals, contacts, companies, leads, and Smart Process items. Add timeline comments. |
| **Tasks** | List, get, create, update, and complete tasks. |
| **Users & Departments** | List active users and the organizational structure. |
| **Disk** | Browse storages and folders, get file info and download links, upload files. |
| **Calendar** | List and create calendar events. |
| **Chat & Notifications** | Send private messages and personal notifications. |
| **Live Feed** | Post messages to the activity feed. |
| **Groups** | List workgroups and projects. |
| **Business Processes** | List active workflows and start new ones. |
| **Telephony** | Query the call history log. |
| **Product Catalog** | List, get, create, and update products and sections. |
| **Configuration** | Export the full portal config (pipelines, stages, custom fields, automations) to JSON, compare two configs, and apply one config to another portal. |
| **Raw API** | Call any Bitrix24 REST method directly, including batch requests. |

---

## Requirements

- [Node.js](https://nodejs.org) **20.16 or higher**
- [Claude Desktop](https://claude.ai/download) or [Claude Code](https://claude.ai/code)
- A Bitrix24 incoming webhook URL

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/bit2beat/bitrix24-mcp.git
cd bitrix24-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your Bitrix24 webhook

> **Administrator required.** Only a Bitrix24 portal administrator can create incoming webhooks. This is a platform security restriction — webhooks act as system-level credentials and can carry broader permissions than a regular user session.

#### Step-by-step

1. Log in to your Bitrix24 portal as an **administrator**
2. Go to **Applications** (left sidebar) → **Webhooks**
3. Click **Incoming webhooks** → **Add webhook**
4. Give it a descriptive name (e.g. `Claude MCP`)
5. Under **Permissions**, enable the scopes you need (see [Access Profiles](#access-profiles) below)
6. Click **Save**
7. Copy the generated URL — it looks like:
   ```
   https://your-portal.bitrix24.com/rest/1/abc123xyz/
   ```
   This URL is your `B24_DEFAULT_WEBHOOK`. **Keep it private** — it grants API access to your portal.

#### Where to find it later

If you need to edit the webhook or add more scopes after the initial setup:

**Applications → Webhooks → Incoming webhooks → (click your webhook name)**

### 4. Configure Claude Desktop

Open your Claude Desktop configuration file:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

Add the following entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "node",
      "args": ["C:/full/path/to/bitrix24-mcp/index.js"],
      "env": {
        "B24_DEFAULT_WEBHOOK": "https://your-portal.bitrix24.com/rest/1/your-token/"
      }
    }
  }
}
```

> **Windows note:** use forward slashes (`/`) or escaped backslashes (`\\`) in the path.

### 5. Restart Claude Desktop

After saving the config file, restart Claude Desktop. You should see the Bitrix24 tools available in the tools panel.

---

## Access Profiles

Bitrix24 webhooks use **scopes** to control which modules are accessible. Each scope unlocks a set of API methods — but within a scope, all operations (read and write) are permitted. There is no built-in "read-only" flag at the scope level.

The practical way to limit what Claude can do is to combine the right set of scopes. Below are three ready-made profiles that cover the most common use cases.

---

### Profile 1 — Structure Inspector (no business data)

Use this when you want Claude to understand the portal's configuration — pipelines, stages, custom fields, automations — **without access to any actual records** (no deals, no contacts, no tasks).

> Ideal for: consultants auditing a portal setup, or developers mapping the CRM before building an integration.

**Scopes to enable:**

| Scope | What it unlocks |
|---|---|
| `user` | Read user list (needed to resolve assignee names) |
| `department` | Read department structure |
| `bizproc` | Read automation rules and business processes |
| `catalog` | Read product catalog structure |

**What Claude can do:** `b24_read_full_config`, `b24_read_pipelines`, `b24_read_custom_fields`, `b24_read_entity_types`, `b24_read_automations`, `b24_read_product_catalog`, `b24_compare_configs`, `b24_users_list`, `b24_departments_list`

**What Claude cannot do:** read or write deals, contacts, tasks, disk files, chat, or calendar.

> **Note:** Pipeline and custom field data is accessed through the `crm` module internally. If you also want to inspect CRM structure (stages, field names), add `crm` to this profile — but be aware that this also enables read access to CRM records.

---

### Profile 2 — Read-Only Operations

Use this when you want Claude to read business data but not create or modify anything.

> Ideal for: reporting, analysis, answering questions about pipeline status or task progress.

**Important caveat:** Bitrix24 scopes do not distinguish between read and write at the API level. The `crm` scope enables both `crm.deal.list` (read) and `crm.deal.add` (write). **Scopes alone cannot enforce read-only access.**

To achieve a true read-only profile you have two options:

- **Trust-based:** Enable only the scopes below and instruct Claude not to modify data. Claude will follow the instruction, but there is no technical enforcement.
- **Enforcement-based:** Run a separate instance of this MCP server that only registers read tools. This requires a small code change and is planned as a future feature (`B24_PROFILE=readonly`).

**Recommended scopes for a read-leaning profile:**

| Scope | What it unlocks |
|---|---|
| `crm` | Read (and write) CRM records |
| `task` | Read (and write) tasks |
| `user` | Read users |
| `department` | Read departments |
| `catalog` | Read product catalog |
| `bizproc` | Read automations |
| `telephony` | Read call history |

---

### Profile 3 — Full Access

Use this when you want Claude to operate as a full Bitrix24 assistant — reading, writing, sending messages, managing files, and everything in between.

**All scopes:**

| Scope | Enables |
|---|---|
| `crm` | CRM records (deals, contacts, companies, leads, SPAs) |
| `task` | Tasks |
| `user` | Users |
| `department` | Departments |
| `disk` | Disk / file storage |
| `calendar` | Calendar events |
| `im` | Chat messages and notifications |
| `bizproc` | Business processes and automations |
| `catalog` | Product catalog |
| `telephony` | Call history |

> Claude will gracefully report when a requested action requires a scope that is not enabled on the webhook, so you can always start with fewer scopes and add more later.

---

## Available Tools

<details>
<summary>Click to expand full tool list (40 tools)</summary>

### Connection
- `b24_test_connection` — Verify the webhook and confirm portal info and user permissions.

### CRM
- `b24_crm_list` — List CRM records with filters and automatic pagination.
- `b24_crm_get` — Get a single CRM record by ID.
- `b24_crm_create` — Create a new CRM record.
- `b24_crm_update` — Update an existing CRM record.
- `b24_crm_delete` — Delete a CRM record.
- `b24_crm_fields` — List all available fields for an entity (standard + custom).
- `b24_crm_timeline_add` — Add a comment or activity to a CRM record's timeline.

### Tasks
- `b24_tasks_list` — List tasks with filters.
- `b24_tasks_get` — Get full task detail.
- `b24_tasks_create` — Create a new task.
- `b24_tasks_update` — Update an existing task.
- `b24_tasks_complete` — Mark a task as complete.

### Users & Departments
- `b24_users_list` — List active users.
- `b24_departments_list` — List departments with hierarchy.

### Disk
- `b24_disk_storages` — List available storages.
- `b24_disk_folder_list` — Browse a folder's contents.
- `b24_disk_file_get` — Get file info and download URL.
- `b24_disk_file_upload` — Upload a file to a folder.

### Calendar
- `b24_calendar_list` — List calendar events.
- `b24_calendar_create` — Create a calendar event.

### Communication
- `b24_chat_send` — Send a private or group chat message.
- `b24_notify_send` — Send a personal notification.
- `b24_feed_post` — Post to the Live Feed.
- `b24_groups_list` — List workgroups and projects.

### Business Processes
- `b24_bizproc_list` — List active workflow instances.
- `b24_bizproc_start` — Start a business process on a record.

### Telephony
- `b24_telephony_calls` — Query the call history log.

### Product Catalog
- `b24_products_list` — List catalog products.
- `b24_products_get` — Get product detail.
- `b24_products_create` — Create a product.
- `b24_products_update` — Update a product.
- `b24_products_sections` — List catalog sections.

### Configuration Management
- `b24_read_full_config` — Export the complete portal configuration to JSON.
- `b24_read_entity_types` — Read CRM and SPA entity types.
- `b24_read_pipelines` — Read pipelines and their stages.
- `b24_read_custom_fields` — Read custom fields across all CRM entities.
- `b24_read_automations` — Read automation rules by stage.
- `b24_read_product_catalog` — Read the product catalog structure.
- `b24_compare_configs` — Compare two portal config JSON files.
- `b24_apply_config` — Apply an exported config to a target portal.
- `b24_save_user_mapping` — Generate a user ID mapping between two portals.

### Raw API
- `b24_call` — Call any Bitrix24 REST API method directly.
- `b24_batch` — Execute multiple API calls in a single HTTP request.

</details>

---

## Usage Examples

Once configured, you can ask Claude things like:

> *"Show me all open deals assigned to María"*

> *"Create a task for Tadeo to review the contract, due Friday"*

> *"What calls came in from company X this week?"*

> *"Export the full CRM configuration of this portal to JSON"*

> *"Compare this portal's pipeline config with the one in config_backup.json"*

---

## Architecture

```
Claude (Claude Desktop / Claude Code)
        │  MCP protocol (stdio)
        ▼
   index.js  (MCP server — 40 tools)
        │
   src/tools/      ← one file per functional area
   src/bitrix24/   ← HTTP client with rate limiting & retry
   src/utils/      ← pagination, rate limiter, user mapping
        │
        ▼
  Bitrix24 REST API  (via incoming webhook)
        │
        ▼
   Your Bitrix24 Portal
```

The HTTP client enforces a **500 ms minimum delay** between requests to respect Bitrix24's rate limits, and retries automatically on `429 Too Many Requests` and timeout errors (up to 3 retries with exponential backoff).

---

## Configuration Migration

This server includes tools designed for Bitrix24 consultants and partners who need to replicate portal configurations across multiple instances:

1. **Export** the source portal config with `b24_read_full_config`
2. **Compare** it against the target with `b24_compare_configs`
3. **Apply** it to the target with `b24_apply_config`

This workflow covers pipelines, stages, custom fields, currencies, SPA types, automations, and the product catalog.

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Open a pull request

---

## License

[MIT](LICENSE)

---

## About Bit2Beat

[Bit2Beat](https://bit2beat.com) is a Bitrix24 specialist firm. We build integrations, automations, and AI-powered tools on top of the Bitrix24 platform.

If you need help implementing this MCP server or building custom Bitrix24 integrations, feel free to reach out at [info@bit2beat.com](mailto:info@bit2beat.com).
