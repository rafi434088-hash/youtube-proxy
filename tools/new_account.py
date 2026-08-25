"""One-shot setup for a fresh account: paste a token, give it a name, get a ready zip.

What it does, start to finish:
  1. asks for a GitHub token (hidden input)
  2. asks what to call this build (used for the zip filename)
  3. creates a public <repo> on that account
  4. pushes the whole project (extension + workflow + tools)
  5. generates a fresh COOKIE_KEY and stores it as a repo secret
  6. builds a ready-to-load zip on the Desktop, with the token embedded (obfuscated)
     and the repo already wired in

    python tools/new_account.py

The token needs permission to CREATE a repo (classic PAT with repo+workflow, or a
fine-grained token with Administration: read/write + Actions + Secrets + Contents +
Workflows). It's read from a hidden prompt and only ever written into the built zip's
config.js — never printed, never committed.
"""

import base64
import getpass
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.github.com"

# The shared public repo that installed copies pull CODE updates from. Personal
# download backends differ per account; the update source is the same for everyone.
UPDATE_OWNER = "rafi434088-hash"
UPDATE_REPO = "youtube-proxy-downloader"


def api(token, method, path, payload=None, expect=(200, 201, 204)):
    url = path if path.startswith("http") else f"{API}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = res.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.load(err).get("message", "")
        except Exception:
            pass
        if err.code in expect:
            return {}
        raise SystemExit(f"{method} {path} failed: HTTP {err.code} {detail}")
    except urllib.error.URLError as err:
        raise SystemExit(f"network error on {method} {path}: {err.reason}")


def obfuscate_token(token, n=5):
    """Repeating-key XOR, base64, interleaved into n chunks — matches config.js."""
    key = secrets.token_hex(11)
    xored = bytes(b ^ ord(key[i % len(key)]) for i, b in enumerate(token.encode()))
    b64 = base64.b64encode(xored).decode()
    return [b64[i::n] for i in range(n)], key


def render_config(owner, repo, token, cookie_key):
    chunks, key = obfuscate_token(token)
    chunks_js = ", ".join(f'"{c}"' for c in chunks)
    out = (ROOT / "extension" / "config.example.js").read_text(encoding="utf-8")
    out = re.sub(
        r'const _TK_CHUNKS = \[[^\]]*\];\nconst _TK_KEY = "[^"]*";',
        f'const _TK_CHUNKS = [{chunks_js}];\nconst _TK_KEY = "{key}";',
        out,
        count=1,
    )
    subs = {
        "owner": owner,
        "repo": repo,
        "cookieKey": cookie_key,
        "updateOwner": UPDATE_OWNER,
        "updateRepo": UPDATE_REPO,
    }
    for field, value in subs.items():
        out = re.sub(rf'^(\s*{field}:\s*")[^"]*(")', rf'\g<1>{value}\g<2>', out, count=1, flags=re.MULTILINE)
    return out


def set_cookie_secret(token, owner, repo, cookie_key):
    try:
        from nacl import encoding, public
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "pynacl"], check=True)
        from nacl import encoding, public

    info = api(token, "GET", f"/repos/{owner}/{repo}/actions/secrets/public-key")
    pub = public.PublicKey(info["key"].encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(pub).encrypt(cookie_key.encode())
    api(
        token, "PUT", f"/repos/{owner}/{repo}/actions/secrets/COOKIE_KEY",
        {"encrypted_value": base64.b64encode(sealed).decode(), "key_id": info["key_id"]},
        expect=(201, 204),
    )


def push_code(token, owner, repo):
    """Push a clean copy from a temp clone so this local checkout's git is untouched."""
    tmp = Path(tempfile.mkdtemp(prefix="ytproxy-new-"))
    try:
        for item in ("extension", "tools", ".github", "docs"):
            if (ROOT / item).exists():
                shutil.copytree(ROOT / item, tmp / item, ignore=shutil.ignore_patterns("config.js", "__pycache__"))
        for item in ("README.md", ".gitignore", "set-token.bat"):
            if (ROOT / item).exists():
                shutil.copy2(ROOT / item, tmp / item)
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        run = lambda *a: subprocess.run(a, cwd=tmp, check=True, env=env, capture_output=True)
        run("git", "init", "-q", "-b", "main")
        run("git", "add", "-A")
        run("git", "-c", "user.email=noreply@github.com", "-c", "user.name=youtube-proxy setup",
            "commit", "-q", "-m", "YouTube Proxy: download through GitHub Actions")
        run("git", "remote", "add", "origin", f"https://x-access-token:{token}@github.com/{owner}/{repo}.git")
        run("git", "push", "-q", "-u", "origin", "main")
    except subprocess.CalledProcessError as err:
        raise SystemExit(f"git push failed: {(err.stderr or b'').decode(errors='replace')[:500]}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_zip(config_js, owner, repo, display_name):
    """A single .zip on the Desktop, with a top folder named after display_name so it
    extracts cleanly, config.js (token embedded) inside, plus a short info file."""
    desktop = Path.home() / "Desktop"
    zip_path = desktop / f"{display_name}.zip"
    if zip_path.exists():
        zip_path.unlink()

    info = (
        f"YouTube Proxy - {display_name}\r\n"
        f"==============================\r\n\r\n"
        f"GitHub repo (the download backend): https://github.com/{owner}/{repo}\r\n"
        f"Account: {owner}\r\n\r\n"
        f"Install:\r\n"
        f"  1. Extract this zip (you already did if you see this file).\r\n"
        f"  2. chrome://extensions -> Developer mode -> Load unpacked -> pick the\r\n"
        f"     '{display_name}' folder (the FOLDER, not the zip).\r\n"
        f"  3. Once, run install-updater.bat from inside the folder so the in-extension\r\n"
        f"     'update' button works.\r\n\r\n"
        f"The token is already embedded (obfuscated) in config.js - nothing else to set up.\r\n"
    )

    src = ROOT / "extension"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(src.rglob("*")):
            if path.is_file() and path.name in ("config.js", "config.example.js"):
                continue
            if path.is_file():
                z.write(path, f"{display_name}/{path.relative_to(src).as_posix()}")
        z.writestr(f"{display_name}/config.js", config_js)
        z.writestr(f"{display_name}/פרטים.txt", info)
    return zip_path


def main():
    print("Set up a new account: creates the repo and a ready-to-load zip.\n")

    token = getpass.getpass("1) Paste the GitHub token (hidden): ").strip()
    if not token:
        raise SystemExit("no token given, nothing changed")

    me = api(token, "GET", "/user")
    owner = me.get("login")
    if not owner:
        raise SystemExit("could not authenticate with that token")
    print(f"   authenticated as: {owner}")

    display_name = input("2) What to call this build (zip name): ").strip()
    if not display_name:
        raise SystemExit("a name is required")
    # keep the filename safe while allowing Hebrew/spaces
    display_name = re.sub(r'[\\/:*?"<>|]+', " ", display_name).strip() or owner

    repo = input("3) Repo name to create [youtube-proxy]: ").strip() or "youtube-proxy"

    # Refuse to reuse an existing repo: its COOKIE_KEY secret is write-only, so a rebuild
    # couldn't match it, and downloads would fail to decrypt cookies.
    try:
        existing = api(token, "GET", f"/repos/{owner}/{repo}", expect=(200,))
        if existing.get("full_name"):
            raise SystemExit(f"{owner}/{repo} already exists - delete it or choose another name")
    except SystemExit:
        raise
    except Exception:
        pass

    print(f"\n   creating {owner}/{repo} (public)...")
    api(token, "POST", "/user/repos",
        {"name": repo, "description": "Download videos through GitHub Actions", "private": False},
        expect=(201,))

    print("   pushing code...")
    push_code(token, owner, repo)

    cookie_key = secrets.token_hex(32)
    print("   setting COOKIE_KEY secret...")
    set_cookie_secret(token, owner, repo, cookie_key)

    print("   building the zip...")
    config_js = render_config(owner, repo, token, cookie_key)
    zip_path = build_zip(config_js, owner, repo, display_name)

    print("\nDone.")
    print(f"  repo : https://github.com/{owner}/{repo}")
    print(f"  zip  : {zip_path}")
    print("  Send that zip. They extract it and Load unpacked the folder inside.")


if __name__ == "__main__":
    main()
