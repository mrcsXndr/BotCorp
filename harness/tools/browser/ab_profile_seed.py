"""Seed ab.sh's persistent agent-browser profile so Chrome never calls LogonUser.

Chrome on Windows decides whether the OS account has a blank password by calling
LogonUser(<user>, ".", "", LOGON32_LOGON_INTERACTIVE): a real logon attempt with
an EMPTY password (password_manager_util_win.cc CheckBlankPasswordWithPrefs).
It skips that call only when Local State's `os_password_last_changed` is >= the
account's actual password-change time. agent-browser's default is a fresh temp
profile per launch, so every launch re-ran the check: one failed logon (event
4625) per launch, and about ten launches in two minutes locked the operator's
Windows account out.

Pinning the cached value to INT64_MAX makes the check skip forever, even across
Windows password changes. ab.sh re-asserts it before every call because Chrome
overwrites it with the real timestamp while running. It also turns the password
manager and autofill off in the profile, so no OS re-auth prompt can be reached.

Usage: ab_profile_seed.py <user-data-dir>   (exit 1 on I/O failure)
"""
import json
import os
import sys

NEVER_RECHECK = "9223372036854775807"  # int64 prefs are stored as strings


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}  # missing or corrupt: Chrome regenerates whatever we omit


def save_if_changed(path, data, before):
    if data == before:
        return
    tmp = path + ".ab-seed.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def main(profile):
    os.makedirs(os.path.join(profile, "Default"), exist_ok=True)

    ls_path = os.path.join(profile, "Local State")
    ls = load(ls_path)
    before = json.loads(json.dumps(ls))
    pm = ls.setdefault("password_manager", {})
    pm["os_password_blank"] = False
    pm["os_password_last_changed"] = NEVER_RECHECK
    save_if_changed(ls_path, ls, before)

    pr_path = os.path.join(profile, "Default", "Preferences")
    pr = load(pr_path)
    before = json.loads(json.dumps(pr))
    pr["credentials_enable_service"] = False
    pr.setdefault("profile", {})["password_manager_enabled"] = False
    af = pr.setdefault("autofill", {})
    af["profile_enabled"] = False
    af["credit_card_enabled"] = False
    save_if_changed(pr_path, pr, before)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: ab_profile_seed.py <user-data-dir>")
    try:
        main(sys.argv[1])
    except OSError as e:
        sys.exit(f"ab_profile_seed: {e}")
