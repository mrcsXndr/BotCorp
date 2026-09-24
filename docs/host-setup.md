# Host setup for a headless bot box

The checklist that turns a Windows 11 PC into a box that comes back from a
power cut with the bots running and reachable over the mesh, with nobody
logged in. Every item was applied on the reference host (verified across a
reboot on 2026-09-24: bot up one minute after boot, no login). `botcorp
doctor` checks the items marked **[doctor]**; the exact check is listed so the
doc and the tool agree.

## 1. Firmware and power

- **BIOS: power on after AC loss** ("Restore on AC Power Loss: Power On" or
  the vendor's equivalent). Without it a power cut leaves the box off until
  someone presses the button.
- **Never sleep on AC** (Settings > Power, or `powercfg /change standby-timeout-ac 0`).
  **[doctor]** `powercfg /q` reports the AC standby timeout (`STANDBYIDLE`,
  `AC Power Setting Index`) as `0`.
- **Fast startup and hibernate off**: `powercfg /h off` (this removes both;
  fast startup is a partial hibernate and skips the task triggers you rely
  on). **[doctor]** `powercfg /a` lists hibernation as unavailable / `powercfg /h`
  state off.
- Display off is fine; sleep is not.

## 2. Windows Update

- Set **active hours** to the window you never want a restart in, and
  **no automatic restart while a user is logged on** (Group Policy
  `Computer Configuration > Administrative Templates > Windows Components >
  Windows Update > Legacy Policies > No auto-restart with logged on users for
  scheduled automatic updates installations` = Enabled, or the equivalent
  registry value `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU`
  `NoAutoRebootWithLoggedOnUsers = 1`).
- A restart outside active hours is acceptable: the daemon task is At Startup,
  the bot resumes the same conversation.
- With nobody logged in, Windows Update may still restart the box on its own
  schedule; the daemon's At Startup trigger is what makes that harmless. Treat
  an unexplained reboot as expected once a month, and check `botcorp doctor`
  afterwards.

## 3. WARP (the mesh; RDP before login depends on it)

- Enrol the device in the Zero Trust organisation (`warp-cli registration new`
  or the GUI), with a device profile that has **auto connect** and the mesh
  (WARP-to-WARP) enabled.
- The **WARP service must be Automatic** so it connects at boot, before any
  login; the device registration persists across reboots (it did on the
  reference host, where WARP connected before anyone logged in).
  **[doctor]** `Get-Service CloudflareWARP` StartType `Automatic`.
  **[doctor]** `warp-cli status` output contains `Connected`.
  **[doctor]** `warp-cli settings` (or the registry / profile) shows
  `auto_connect` set (non-zero).
- Cloudflare's own log for boot-time problems:
  `C:\ProgramData\Cloudflare\cfwarp_service_log.txt`.

## 4. RDP over the mesh only

- Enable Remote Desktop with **NLA** on. **[doctor]** registry
  `HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections = 0`
  and `...\WinStations\RDP-Tcp\SecurityLayer = 2` with
  `UserAuthentication = 1`.
- Firewall: allow TCP 3389 **only from the mesh range `100.96.0.0/12`**
  (`New-NetFirewallRule -DisplayName "RDP mesh only" -Direction Inbound
  -Protocol TCP -LocalPort 3389 -RemoteAddress 100.96.0.0/12 -Action Allow`),
  and leave the built-in "Remote Desktop" rules disabled or scoped the same
  way. **[doctor]** a firewall rule exists for local port 3389 whose remote
  address is `100.96.0.0/12` (or a subset of it), and no enabled 3389 rule
  allows `Any`.
- The services that must be running at boot: `TermService`, `CloudflareWARP`
  (and `Cloudflared` if a tunnel is used).

## 5. No auto-login, account hygiene

- **No auto-login.** The console stays on the sign-in screen; the daemon does
  not need a desktop. **[doctor]** `HKLM\SOFTWARE\Microsoft\Windows
  NT\CurrentVersion\Winlogon\AutoAdminLogon = 0` (or absent) AND no
  `DefaultPassword` value AND the LSA secret `DefaultPassword` is absent (the
  reference host had it removed explicitly: a value of `0` with a stored
  secret still leaks the password).
- **Account lockout** (the reference host: 20 attempts / 15 minutes):
  `net accounts /lockoutthreshold:20 /lockoutduration:15 /lockoutwindow:15`.
- Default console host `conhost` (Windows Terminal as the default steals
  hidden task windows onto the desktop), "restart apps after sign-in" off,
  startup bloat disabled.
- BitLocker is the operator's call; the reference host runs without it and
  documents that the disk is readable with physical access.

## 6. The daemon

- `pwsh -File daemon/install.ps1` (prompts for the account password; LogonType
  Password, At Startup + every 3 min, RunLevel Limited). See
  `docs/host-service.md` for why, and `docs/daemon.md` for what the tick does.
- The account password is stored by the Task Scheduler: **re-run install.ps1
  after a password change**, or the task silently stops firing.
- Auth for the bots: each bot's OAuth token in its DPAPI vault (`botcorp
  secrets set <bot> oauth`), entered once per bot per machine.

## 7. The three logs

| Log | What it answers |
|---|---|
| `~/.botcorp/daemon.log` (and `logs/<bot>/daemon.log`) | did the tick run, what did it decide (`state:` / `ACTION=` / `DEFERRED` / `SKIP not ours`) |
| `~/.botcorp/logs/<bot>/launches.log` | what `launch.ps1` did for a bot: mode, `bg: id=... session=... claude_pid=...`, vault notes (masked) |
| `C:\ProgramData\Cloudflare\cfwarp_service_log.txt` | did WARP connect at boot, before the login |

Plus Claude Code's own supervisor log under the bot's config home
(`bots/<name>/.claude-<name>/daemon.log`) when a bg session misbehaves.

## 8. Reboot test (do this once per host, and after any change above)

1. From the box: `pwsh -File daemon/tick.ps1 -ProbeOnly` shows every bot
   `alive=True`; `botcorp doctor` is green.
2. Log out (do not just lock). Pull the power, or `shutdown /r /t 0` from a
   remote session.
3. **From another mesh device, RDP to the host's mesh address while the box
   sits at the login screen.** The connection must reach the sign-in prompt
   (this proves WARP + RDP before login). Do not log in yet.
4. Wait two tick intervals (6 min), then check from the bot's own channel
   (send it a message) or from the RDP session after logging in:
   `~/.botcorp/daemon.log` shows a tick within a minute of boot and
   `ACTION=START ... kind=cold-start` (or `alive=True` because the supervisor
   came back first), and `claude agents --json` (with the daemon's elevation)
   lists the bot with `status` `busy`/`waiting`/`idle`.
5. Log in, then log out again: the bot must not notice (same `bg_id`, no
   `ACTION=START`).
