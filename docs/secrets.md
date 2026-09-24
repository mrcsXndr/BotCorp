# Secrets

## Bundle: moving a bot's secrets between machines

A secrets bundle carries a bot's vault entries and any chosen credential
files (e.g. `token.json`) between machines, encrypted with a passphrase. It
never touches `.vault/` directly and is never committed - it is a one-time
transfer artifact you generate on the source machine and consume on the
target.

### Format (locked)

A bundle is two files, produced together: `secrets.manifest.json` and
`secrets.bundle.enc`. Any producer, in any language, can build a compatible
bundle by following this exactly.

**`secrets.manifest.json`:**

```json
{
  "schema": 1,
  "bot": "<name>",
  "created_at": "<ISO 8601 UTC>",
  "cipher": "aes-256-gcm",
  "kdf": { "name": "pbkdf2-sha256", "iterations": 600000, "salt": "<base64, 16 bytes>" },
  "nonce": "<base64, 12 bytes>",
  "bundle": "secrets.bundle.enc",
  "sha256": "<hex sha256 of the .enc file's bytes>",
  "vault_keys": ["oauth_token", "..."],
  "files": [
    { "path": "token.json", "scope": "bot", "sha256": "<hex sha256 of the plaintext bytes>", "mode": "0600" },
    { "path": "AppData/Roaming/thing/creds.json", "scope": "home", "sha256": "<hex sha256 of the plaintext bytes>", "mode": "0600" }
  ]
}
```

**`secrets.bundle.enc`:** AES-256-GCM ciphertext, followed immediately by the
16-byte authentication tag.

- **Key:** `PBKDF2-SHA256(passphrase, salt, iterations, 32 bytes)`.
- **AAD:** UTF-8 bytes of `"botcorp-bundle:" + bot` (binds the ciphertext to
  the bot name recorded in the manifest).
- **Plaintext:** UTF-8 JSON, `{ "vault": { "<key>": "<value>" }, "files": { "<relpath>" | "~/<relpath>": "<base64>" } }`.

**Scope.** Each `files[]` entry carries `scope: bot | home` (a missing scope
means `bot`, for a manifest written before this existed):

- `scope: bot` - the path is relative to the bot's own folder; in the
  plaintext payload its key is the plain relpath (`token.json`).
- `scope: home` - the path is relative to the operator's `USERPROFILE`; in
  the plaintext payload its key is `~/`-prefixed (`~/AppData/Roaming/thing/
  creds.json`). Home-scoped relpaths follow the same rules as bot-scoped ones
  (relative, forward-slashed, no `..` segment, never absolute), plus they may
  never reach into a Claude config home (`.claude`, `.claude-*`), the BotCorp
  runtime home (`.botcorp/`), or any `.vault` (`Test-BundleHomeRelPath` in
  `daemon/bundle.ps1`).

**Launch tokens (OAuth, Telegram) belong in `vault_keys`, never as a file** -
a bundle exists to move DPAPI-protected vault entries and small credential
files a tool insists on owning (e.g. a Google `token.json`), not to carry
plaintext secrets around as bytes.

### CLI

```
botcorp secrets export-bundle <bot> --out <dir> [--files a,~/b]
botcorp secrets import-bundle <bot> <bundle.enc> [--manifest <json>] [--dry-run] [--allow-home] [--force]
```

The passphrase is always read from stdin - never argv, never the manifest,
never echoed back. Pipe it in:

```
echo <passphrase> | botcorp secrets export-bundle demo --out .\out --files token.json,~/AppData/Roaming/thing/creds.json
echo <passphrase> | botcorp secrets import-bundle demo .\out\secrets.bundle.enc --allow-home
```

`export-bundle` bundles every key currently in the bot's vault plus whatever
`--files` names (default: none); a `~/`-prefixed entry is scope `home`,
anything else is scope `bot`. `import-bundle` defaults `--manifest` to
`secrets.manifest.json` next to the bundle file; `--dry-run` prints what
would be restored (file and key names only - never values) and writes
nothing.

### Import guarantees

`import-bundle` decrypts, then resolves and prints EVERY target - `target
[bot|home|vault] <full path or bot/key>` - before writing a single byte, and
refuses the whole import, with a distinct error, when any of these hold:

- manifest `schema` must be `1`;
- manifest `bot` must equal the target bot name (else "bundle is for bot
  X");
- the manifest's `sha256` must match the actual `.enc` file's bytes;
- the passphrase must decrypt the bundle and pass the GCM tag check, or the
  import fails with "wrong passphrase or tampered bundle" (a single bit
  flipped anywhere in the ciphertext fails the same way);
- every `vault_keys` entry must be present in the decrypted `vault` object,
  and vice versa;
- every vault key name must match `^[a-z][a-z0-9_]{0,63}$`;
- every file path must pass the relpath rules for its scope (see above), and
  the decrypted `files` object's keys must exactly match the manifest's file
  list (`~/`-prefixed for scope `home`);
- each file's sha256 must match the manifest;
- any resolved target that lands outside `USERPROFILE` (for scope `home`) or
  outside the bot's own folder (for scope `bot`), OR inside any `bots/<x>/`
  folder, OR inside the BotCorp runtime home, is refused before anything is
  written;
- **any home-scoped file needs `-AllowHome`** (`botcorp: --allow-home`) or the
  whole import is refused - restoring into the operator's own profile is
  opt-in;
- **an existing file is never overwritten without `-Force`** (`botcorp:
  --force`) - the import lists every file that already exists and refuses
  unless you ask for it explicitly.

Only after every check passes are files written (parent directories created,
permissions reset to the current user only) and vault keys written through
the normal `Set-VaultSecret` path. Every file write and vault `set` is
appended to the audit log with reason `import` - a file's key is
`file:<scope>:<path>`, e.g. `file:home:AppData/Roaming/thing/creds.json`.

---

## Vault, scoping, attestation, lock mode

### Threat model - read this first

Every bot runs as the SAME Windows user, and the vault is DPAPI
`CurrentUser` - so an NTFS ACL cannot keep one bot's process out of another
bot's vault. Two bots on this box can always decrypt each other's blobs if
their code tries to; `Protect-VaultDir`'s ACL is hygiene against a copied or
world-readable folder, not an isolation boundary between bots.

What BotCorp enforces instead of an OS boundary it doesn't have:

- **declared-keys-only injection** - the launcher (`daemon/launch.ps1` step
  7) decrypts only the keys a bot's own `bot.yaml` `secrets:` list names, into
  that bot's own session env, under its own env var name;
- **the vault-guard tool hook** (`harness/hooks/vault-guard.sh`) - the
  boundary a bot session actually meets: it blocks every `Read` / `Glob` /
  `Grep` / `Bash` / `Edit` / `Write` / `MultiEdit` / `NotebookEdit` call that
  touches a `.vault/` directory (any bot's, including its own), the
  `secrets.ps1` / `vault.ps1` / `accounts.ps1` scripts, the secrets CLI's
  mutating verbs, `ProtectedData`, or the audit log itself. `hooks_disable`
  cannot switch it off;
- **the audit log** - every decrypt, ever, with which process asked and why;
- **launch attestation** - only a trusted start path can hand a launch the
  secrets it needs (see "Launch attestation" below);
- **operator lock mode** - `vault.lock: operator` keeps the vault key out of
  reach until the operator unlocks it, so a stolen boot cannot cold-start a
  bot's session unattended (see "Lock mode" below).

The true OS boundary - one Windows account per bot - is future work, tracked
separately; nothing below substitutes for it.

### Per-bot scoping

`bot.yaml` declares the keys a bot is allowed to have injected:

```yaml
secrets: [oauth_token, telegram_token]
```

At launch, `daemon/launch.ps1` decrypts ONLY the keys in this list (default
`[oauth_token, telegram_token]`; `telegram_token` only when
`harness.modules.telegram` is on). Each key reaches the child process's env
under a fixed name for the two Claude Code / plugin secrets, else its
UPPERCASE form (`daemon/_common.ps1` `Get-SecretEnvName`):

| vault key | env var |
|---|---|
| `oauth_token` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `telegram_token` | `TELEGRAM_BOT_TOKEN` |
| anything else, e.g. `hub_token` | its UPPERCASE form, e.g. `HUB_TOKEN` |

A vault key that exists but is NOT in `secrets:` is never decrypted for the
launch; `bots/<name>/logs/<name>/launches.log` names it: `undeclared vault
key(s) NOT injected: <keys> (add to bot.yaml secrets: to inject)`.
`automations[].secrets` must be a subset of the bot's own `secrets:` list -
`daemon/botyaml.mjs`'s `--validate` rejects an automation that names a key
its bot never declared. `botcorp doctor`'s `<bot>: secrets scope` line
reports declared vs. actually-present keys (WARN on either a declared key
with no vault entry, or a vault entry that's present but undeclared).

### The vault-guard hook

`harness/hooks/vault-guard.sh` is a `PreToolUse` hook matched on
`Read|Glob|Grep|Bash|Edit|Write|MultiEdit|NotebookEdit`. It fails CLOSED for
what it names (exit 2, tool call blocked, the message fed back to the model)
and is silent (exit 0) for everything else. It blocks any tool input whose
path/pattern/command mentions: a `.vault` directory; `secrets.ps1` /
`vault.ps1` / `accounts.ps1`; `botcorp secrets get|unlock|lock|import-bundle|
export-bundle|migrate`; the DPAPI `ProtectedData` API; or
`secret-access.jsonl`. `daemon/botyaml.mjs`'s `harness.hooks_disable` list is
validated against the hooks that exist, and separately refuses `vault-guard`
by name no matter what a bot's own config asks for - a bot can disable
`play-sound`, not this.

### Audit log

Every decrypt (`Get-VaultSecret` in `daemon/vault.ps1`) appends one line to
`<BOTCORP_HOME>/state/secret-access.jsonl`, regardless of whether it
succeeds:

```json
{"ts":"2026-09-25T00:00:00.0000000Z","bot":"demo","key":"oauth_token","reason":"launch","pid":12345,"ppid":6789,"ok":true}
```

`reason` is one of `launch | automation | cli | list | export | doctor |
unlock | import`; a failed decrypt still gets a line (`ok:false`) and rethrows.
Never a value, never even a hash of one. Read it with:

```
botcorp secrets audit [bot] [--tail N] [--json]
```

and in the cockpit's "Secret access" panel (same log, same fields). `secrets
list` no longer decrypts anything - `Set-VaultSecret` now stores the value's
`last4` alongside the DPAPI blob, so listing masked entries is a plain read
of the store. `botcorp secrets doctor` (and `botcorp doctor`'s per-bot
checks) still want to know the blobs are actually readable by this Windows
account, so they do exactly ONE audited decrypt (`reason: doctor`, of the
first key found) rather than decrypting the whole vault.

### ACL

`Protect-VaultDir` resets `bots/<bot>/.vault`'s ACL - and every file already
inside it - to grant only the current user and SYSTEM, with inheritance off,
every time a secret is set. This is hygiene against a copied/restored folder
inheriting a wider ACL from its new parent, not isolation between bots (see
the threat model above). Re-apply it by hand after copying or restoring a
bot's `.vault` folder:

```
botcorp secrets acl <bot>
```

`botcorp doctor` reports the same state as two lines: `<bot>: vault acl`
(PASS when the ACL is exactly user+SYSTEM with inheritance off, WARN
otherwise, with the `secrets acl` command to fix it) and `<bot>: vault
isolation` (feeds the vault-guard hook a synthetic `Read` of a SIBLING bot's
`.vault/secrets.json` and expects it to block with exit 2 - PASS on a block,
FAIL if the hook lets it through or `harness/hooks/hooks.json` doesn't
register the hook at all).

### Launch attestation

A trusted start path - the daemon tick's cold-start (`Start-BotBg` /
`Start-PtyHost`), `restart.ps1`, `launch-visible.ps1`, or `botcorp start` -
mints a 32-byte random nonce before it launches a bot. Only the nonce's
sha256 is ever recorded, in `<BOTCORP_HOME>/state/<bot>.json` `launch`:

```json
"launch": { "nonce_sha256": "<hex>", "minted_by_pid": 12345, "at": "<ISO>", "at_unix": 1234567890, "consumed_at": null }
```

State files are readable by every process of this user, so only the hash
goes there; the raw nonce reaches `launch.ps1` in the environment
(`BOTCORP_LAUNCH_NONCE`, stripped from the environment before `claude`
starts) - or, for the one branch that spawns a Windows Terminal profile in
`launch-visible.ps1`, as `-LaunchNonce` on that process's own argv, never
anywhere it would be inherited more widely.

`Get-VaultSecret -Reason launch` refuses to decrypt anything unless it is
handed a nonce that matches the recorded hash, has not already been
consumed, and is under 120 seconds old (`Test-LaunchNonce`). The nonce is
consumed (`Confirm-LaunchNonce`) once the child is up (or the launch has
failed), so it can never authorise a second decrypt.

`secrets.ps1 -Action get` now requires `-Nonce <launch nonce>` - the old
`-IAmTheLauncher` flag is gone.

An unattested launch - `launch.ps1` run some other way - still runs, but
WITHOUT secrets and without the Telegram poller, and says so in
`bots/<bot>/logs/<bot>/launches.log`: `unattested launch: no secrets injected
(use botcorp start <bot>)`. `launch.ps1 -DryRun` prints `attested: yes` or
`attested: NO (no secrets would be injected)`.

**Be honest about what this proves.** It proves WHICH recorded start path
launched the bot session - it is not an OS boundary. The hash cannot be
turned back into the nonce, but the state file is WRITABLE by every process
running as this Windows user, so a process that is not confined by the
vault-guard hook could mint its own nonce there and run `launch.ps1` with
it. What attestation buys is that every launch that gets secrets is a
recorded, audited event (`minted_by_pid`, the audit line's `nonce` prefix)
and that a stray or accidental `launch.ps1` - a hand run, a stale task, a
bot's own tool call - gets none. The vault-guard hook and the audit log are
the layers that make forging it visible; a per-bot Windows account is what
would make it impossible.

### Lock mode

Every vault is v1 until migrated: each entry's DPAPI entropy is the bot's own
name, so a copied `.vault/secrets.json` never decrypts anywhere else, but
there is no single "the vault" key to lock. `botcorp secrets migrate <bot>`
moves a bot to v2: a random 32-byte per-bot key `K` becomes the entropy for
every entry, and `K` itself is wrapped once in `.vault/key.json`:

```json
{ "v": 2, "wraps": { "dpapi": "<b64 DPAPI(K)>" } }
```

or, once locked:

```json
{ "v": 2, "wraps": { "operator": { "kdf": "pbkdf2-sha256", "iter": 600000, "salt": "<b64>", "nonce": "<b64>", "ct": "<b64>" } } }
```

**Lock mode `none`** (the default) wraps `K` under DPAPI, exactly like a v1
entry: readable by this Windows account across an unattended reboot, so the
daemon can cold-start the bot on its own.

**`botcorp secrets lock <bot>`** (passphrase on stdin, minimum 8 characters;
migrates a v1 vault first if needed) wraps `K` under
`AES-256-GCM(PBKDF2-SHA256(passphrase))` ONLY - the DPAPI wrap is removed and
any until-reboot unlock cache is dropped - so the vault is LOCKED right now
and again after every reboot, until unlocked.

**`botcorp secrets unlock <bot>`** (passphrase on stdin) verifies the
passphrase against the AES-GCM tag, then caches `K` at
`<BOTCORP_HOME>/state/unlock/<bot>.key`, itself DPAPI-protected with entropy
bound to the current OS boot time (`boot:<ISO>`); a cache read back from an
earlier boot is deleted on first use and can never unlock again. The vault
stays unlocked until the next reboot. `unlock --permanent` instead restores
the DPAPI wrap and drops the operator wrap entirely - back to lock mode
`none`. Calling `lock` again on an already-operator-locked vault re-locks it
at once (drops the unlock cache) with no passphrase needed.

**While locked:** `Get-VaultSecret` / `Set-VaultSecret` throw `vault: <bot>
is locked` (audited `ok:false`); the daemon tick will not cold-start or
restart the bot (`state/<bot>.json status: locked`, `daemon.log` logs `vault
LOCKED ...`); `botcorp start` refuses outright; `botcorp status` shows
`vault: operator v2 LOCKED`; `botcorp doctor` WARNs `<bot>: vault lock`
(also WARNing when `bot.yaml`'s `vault.lock` disagrees with the vault's
actual mode). The cockpit's vault drawer shows the lock state
(`GET /api/bots/:name/secrets/lock`) and, only when locked, a passphrase
field that posts to `POST /api/bots/:name/unlock` - never from a chat
message, and behind Cloudflare Access whenever the cockpit is exposed.

Audit reasons are now `launch | automation | cli | list | export | doctor |
unlock | import`. Windows Hello (as an alternative to typing a passphrase)
is deferred. `bot.yaml`'s `vault.lock: null` currently means `none` - there
is no host-wide default implemented (a per-machine default was considered
and dropped; each bot states its own lock mode or accepts `none`).
