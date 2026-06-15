# Phase 4 — Python Tally Sync Agent (`agent/`)

Runs on the customer's Windows PC next to Tally Prime. It activates against the
cloud with the secret license key (machine-bound), heartbeats, then syncs data
between the cloud API and local Tally Prime (XML over `http://localhost:9000`).

## Cloud endpoints it uses (already built + live)
- `POST {api_url}/agent/activate` body `{license_key, machine_id, agent_version}`
  → envelope `{status, show, msg, data:{ agent_token, license:{id,holder_name,plan,valid_until,max_companies}, companies:[{id,name,slug,status}] }}`.
  Errors (HTTP 200, body.status 404/403): invalid key / bound to another machine / suspended / expired — `body.msg` is user-facing.
- `POST {api_url}/agent/heartbeat` header `Authorization: Bearer <agent_token>`, body `{agent_version}`
  → `{status, data:{ status:'active'|'suspended', license_id, server_time }}`. If `data.status != 'active'` the agent must stop syncing.

Envelope convention: HTTP is 200; the real code is in `body.status` (200 = success). `data` holds the payload.

## Files (under `tallysaas/agent/`)
- `config.py` — `Config` (reads/writes `config.ini`): `api_url`, `license_key`, `sync_interval` (sec), `log_level`, `agent_version`; persists `agent_token` + `machine_id` under a `[state]` section. Module fn `machine_fingerprint()` → stable sha256 hex from MAC (`uuid.getnode()`) + hostname (+ platform). Same PC ⇒ same id.
- `logger.py` — `get_logger(name)` → rotating file handler (`logs/agent.log`, 1MB×5) + console; level from config.
- `api_client.py` — `ApiClient(api_url, logger)`: `.activate(license_key, machine_id, agent_version)` → data dict, raises `ActivationError(msg)` on body.status≠200 or transport error; `.heartbeat(token, agent_version)` → data dict, raises `AgentError`. Uses `requests` (timeout=15, small retry/backoff). Parses the envelope.
- `tally_connector.py` — `TallyConnector(url, logger)`: `.is_available()` → bool (quick probe), `.send(xml)` → response text or raises `TallyUnavailable`, `.company_info()` → dict, plus XML builders/parsers for the common ops (create ledger, create stock item, create sales/purchase/receipt/payment voucher, fetch ledger list / stock summary / outstanding). Use `xml.etree.ElementTree` for parse; keep request XML as templates (Tally ENVELOPE/TALLYREQUEST format).
- `sync_agent.py` — entry point. Flow: load config → compute machine_id → if no saved `agent_token`, prompt for the license key (or read from config) and **activate** (save token) → main loop every `sync_interval`: **heartbeat** (stop if suspended), check Tally (`is_available`; if down, log + skip this cycle, retry next), run a **sync pass** (pull pending → push to Tally → report; structured stub for now since the cloud sync-queue endpoints land later), **retry failed**, sleep. Clean Ctrl+C shutdown. CLI: `--activate <key>`, `--once`, `--status`.
- `requirements.txt` — `requests`. (configparser/uuid/hashlib/xml are stdlib.) Optional `pyinstaller`, `pywin32` (commented for the service).
- `config.example.ini` — sample with `api_url=http://localhost:4500/api/v1`, `sync_interval=60`, `log_level=INFO`.
- `build_exe.py` — PyInstaller one-file build (`pyinstaller --onefile --name TallyCloudSyncAgent sync_agent.py`), plus notes for auto-start (Windows Task Scheduler / Startup shortcut). 
- `README.md` — install (`pip install -r requirements.txt`), first-run activation, run, build exe, auto-start, troubleshooting (Tally not reachable → enable XML port 9000 in TallyPrime F1→Settings→Connectivity).

## Conventions
- Python 3.10+ (target 3.x on the customer PC). 4-space indent, module docstrings, type hints where useful, no hard crashes — every external call (cloud, Tally) is wrapped; failures are logged + retried, never fatal to the loop.
- Secrets: the license key + agent_token live in `config.ini` on the customer PC (local trust); the cloud still enforces all entitlement, so a stolen token is limited (machine-bound + suspendable).
