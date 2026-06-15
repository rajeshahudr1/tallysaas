# Tally Cloud Sync Agent

A small Python agent that runs on the customer's Windows PC next to **Tally
Prime**. It activates against the cloud with a machine-bound license key,
heartbeats on an interval, and (in a later phase) syncs data between the cloud
API and the local Tally Prime company over XML (`http://localhost:9000`).

- **Python:** 3.10+
- **Talks to:** the cloud API (`/agent/activate`, `/agent/heartbeat`) and the
  local Tally Prime XML port (`9000`).
- **Resilient:** every external call is wrapped — the sync loop logs failures
  and retries on the next cycle, it never crashes.

---

## 1. Install

```bash
# from tallysaas/agent/
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # macOS/Linux for dev
pip install -r requirements.txt
```

Only `requests` is required; `configparser`, `uuid`, `hashlib`, `socket`,
`platform` and `xml` are part of the standard library.

## 2. Configure

Copy the example config and fill it in:

```bash
copy config.example.ini config.ini     # Windows
# cp config.example.ini config.ini     # macOS/Linux
```

Edit `config.ini`:

```ini
[agent]
api_url=http://localhost:4500/api/v1   ; your cloud API base URL
license_key=TCS-XXXX-XXXX-XXXX         ; the key issued to this customer
sync_interval=60                       ; seconds between sync passes
log_level=INFO                         ; DEBUG | INFO | WARNING | ERROR
agent_version=1.0.0
```

> The `[state]` section (agent token + machine id) is written automatically
> after activation — **do not edit it by hand**.

## 3. First run — activate

Activation binds this license to **this machine** (a stable fingerprint from
MAC + hostname + platform). Run once with the key:

```bash
python sync_agent.py --activate TCS-XXXX-XXXX-XXXX
```

If `license_key` is already set in `config.ini` you can omit the key:

```bash
python sync_agent.py --activate
```

On success the agent saves an `agent_token`, logs the license holder and the
companies you can access, then continues into the sync loop. On failure
(invalid key / bound to another machine / suspended / expired) it prints the
cloud's message and exits non-zero — fix the issue and re-run.

## 4. Run

After activation, just start it (no flags needed — the saved token is reused):

```bash
python sync_agent.py
```

It heartbeats and runs a sync pass every `sync_interval` seconds. Stop it with
**Ctrl+C** (clean shutdown: `Agent stopped.`).

### CLI reference

| Command | What it does |
| --- | --- |
| `python sync_agent.py` | Run the continuous sync loop (default). |
| `python sync_agent.py --activate KEY` | (Re)activate with a license key, then run. |
| `python sync_agent.py --activate` | Activate using `license_key` from `config.ini`. |
| `python sync_agent.py --once` | Run a single heartbeat+sync cycle and exit. |
| `python sync_agent.py --status` | Print config, token presence and Tally availability, then exit. |
| `python sync_agent.py --help` | Show usage. |

Logs are written to `logs/agent.log` (1 MB × 5 rotating files) and the console.

---

## 5. Build a standalone .exe

So the customer needs no Python install:

```bash
pip install pyinstaller
python build_exe.py
# (equivalent to: pyinstaller --onefile --name TallyCloudSyncAgent sync_agent.py)
```

The binary lands in `dist/TallyCloudSyncAgent.exe`. Ship it together with
`config.example.ini`; the customer copies it to `config.ini`, sets `api_url`
and `license_key`, runs the exe once to activate, then leaves it running.

## 6. Auto-start at logon

**Option A — Startup folder (simplest):**

1. Press `Win+R`, type `shell:startup`, press Enter.
2. Drop a shortcut to `TallyCloudSyncAgent.exe` into that folder.

**Option B — Task Scheduler (robust, restarts on failure):**

```bat
schtasks /Create /TN "TallyCloudSyncAgent" ^
    /TR "C:\TallyAgent\TallyCloudSyncAgent.exe" ^
    /SC ONLOGON /RL HIGHEST /F
```

Remove with `schtasks /Delete /TN "TallyCloudSyncAgent" /F`.

---

## 7. Troubleshooting

**`Tally not reachable — will retry` in the log**
The agent cannot reach Tally's XML interface. In **Tally Prime**:

1. Press `F1` → **Settings** → **Connectivity**.
2. Under **Client/Server configuration**, set **TallyPrime acts as** to
   **Both** (or **Server**).
3. Set the **Port** to **9000** and accept.
4. Make sure a company is open in Tally.

Verify from the same PC with `python sync_agent.py --status` — the `tally`
line should read `reachable`. If a firewall is involved, allow inbound on
port 9000 for Tally Prime locally.

**`Activation failed: …`**
The message is the cloud's reason:
- *invalid key* — check `license_key` for typos.
- *bound to another machine* — the license is already activated elsewhere;
  contact support to release it.
- *suspended / expired* — the subscription needs attention in the portal.

**`license suspended — pausing sync`**
The cloud has paused this agent. It keeps heartbeating and resumes syncing
automatically once the license is reactivated; no restart needed.

**`Cannot reach the cloud server.`**
Network/DNS issue or wrong `api_url`. Confirm the URL (including the
`/api/v1` prefix) and that the server is up. The agent retries every cycle.

**Re-activating on a new machine**
The machine fingerprint changes with hardware/hostname. If `--status` shows
`id_matches: no`, re-run `--activate` (you may need the license released from
the old machine first).
