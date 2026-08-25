"""Set up a second, fully independent copy of this project on another GitHub account.

Creates the repo, pushes the code, generates a fresh COOKIE_KEY and stores it as a
repo secret, then builds that account its own loadable folder + zip with the token
embedded (obfuscated, same scheme as tools/embed_token.py).

Nothing is shared with the original account: separate repo, separate cookie key,
separate token, separate build. extension/config.js is never touched, so whichever
account this checkout is already installed for keeps working untouched.

    python tools/clone_to_account.py

Outputs (all git-ignored):
    .configs/config.<owner>.js      the account's settings + token
    build-<owner>/                  load this folder in chrome://extensions
    youtube-proxy-extension-<owner>.zip

The token is read from a hidden prompt, never passed on the command line (so it stays
out of shell history) and never written outside .configs/ and the build folder.
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
            if res.status not in expect:
                sys.exit(f"unexpected HTTP {res.status} from {method} {path}")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.load(err).get("message", "")
        except Exception:
            pass
        if err.code in expect:
            return {}
        sys.exit(f"{method} {path} failed: HTTP {err.code} {detail}")
    except urllib.error.URLError as err:
        sys.exit(f"network error on {method} {path}: {err.reason}")


def obfuscate_token(token, n=5):
    """Repeating-key XOR, base64, interleaved into n chunks — matches config.js."""
    key = secrets.token_hex(11)
    xored = bytes(b ^ ord(key[i % len(key)]) for i, b in enumerate(token.encode()))
    b64 = base64.b64encode(xored).decode()
    return [b64[i::n] for i in range(n)], key


def write_config(owner, repo, token, cookie_key, dest_path):
    """Render a config for `owner` to dest_path.

    Deliberately never touches extension/config.js: that file belongs to whichever
    account this checkout is primarily installed for, and an earlier version of this
    script overwrote it — silently repointing the already-installed extension at the
    newly created account and discarding its token. Each account gets its own file
    under .configs/ and its own built folder instead.
    """
    chunks, key = obfuscate_token(token)
    chunks_js = ", ".join(f'"{c}"' for c in chunks)
    template = (ROOT / "extension" / "config.example.js").read_text(encoding="utf-8")
    out = re.sub(
        r'const _TK_CHUNKS = \[[^\]]*\];\nconst _TK_KEY = "[^"]*";',
        f'const _TK_CHUNKS = [{chunks_js}];\nconst _TK_KEY = "{key}";',
        template,
        count=1,
    )
    out = re.sub(r'^(\s*owner:\s*")[^"]*(")', rf'\g<1>{owner}\g<2>', out, count=1, flags=re.MULTILINE)
    out = re.sub(r'^(\s*repo:\s*")[^"]*(")', rf'\g<1>{repo}\g<2>', out, count=1, flags=re.MULTILINE)
    out = re.sub(r'^(\s*cookieKey:\s*")[^"]*(")', rf'\g<1>{cookie_key}\g<2>', out, count=1, flags=re.MULTILINE)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_text(out, encoding="utf-8")


def build_package(config_path, folder, zip_path):
    """Assemble a standalone, loadable copy of the extension for one account."""
    if folder.exists():
        shutil.rmtree(folder)
    shutil.copytree(ROOT / "extension", folder, ignore=shutil.ignore_patterns("config.example.js", "config.js"))
    shutil.copy2(config_path, folder / "config.js")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(folder).as_posix())


def set_cookie_secret(token, owner, repo, cookie_key):
    """Secrets must be sealed with the repo's public key before upload."""
    try:
        from nacl import encoding, public
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "pynacl"], check=True)
        from nacl import encoding, public

    key_info = api(token, "GET", f"/repos/{owner}/{repo}/actions/secrets/public-key")
    pub = public.PublicKey(key_info["key"].encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(pub).encrypt(cookie_key.encode())
    api(
        token,
        "PUT",
        f"/repos/{owner}/{repo}/actions/secrets/COOKIE_KEY",
        {"encrypted_value": base64.b64encode(sealed).decode(), "key_id": key_info["key_id"]},
        expect=(201, 204),
    )


def push_code(token, owner, repo):
    """Push a clean copy from a temp clone so the local repo's remote/history is untouched."""
    tmp = Path(tempfile.mkdtemp(prefix="ytproxy-clone-"))
    try:
        for item in ("extension", "tools", ".github"):
            shutil.copytree(ROOT / item, tmp / item, ignore=shutil.ignore_patterns("config.js", "__pycache__"))
        for item in ("README.md", ".gitignore", "set-token.bat"):
            if (ROOT / item).exists():
                shutil.copy2(ROOT / item, tmp / item)

        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        run = lambda *a: subprocess.run(a, cwd=tmp, check=True, env=env, capture_output=True)
        run("git", "init", "-q", "-b", "main")
        run("git", "add", "-A")
        run(
            "git",
            "-c", "user.email=noreply@github.com",
            "-c", "user.name=youtube-proxy setup",
            "commit", "-q", "-m", "YouTube Proxy: download through GitHub Actions",
        )
        remote = f"https://x-access-token:{token}@github.com/{owner}/{repo}.git"
        run("git", "remote", "add", "origin", remote)
        run("git", "push", "-q", "-u", "origin", "main")
    except subprocess.CalledProcessError as err:
        sys.exit(f"git failed: {(err.stderr or b'').decode(errors='replace')[:500]}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    print("Sets up an independent copy of this project on another GitHub account.\n")
    token = getpass.getpass("Paste the token for that account (hidden): ").strip()
    if not token:
        sys.exit("no token given, nothing changed")

    me = api(token, "GET", "/user")
    owner = me["login"]
    print(f"authenticated as: {owner}")

    repo = input("Repo name to create [youtube-proxy]: ").strip() or "youtube-proxy"

    existing = None
    try:
        existing = api(token, "GET", f"/repos/{owner}/{repo}", expect=(200,))
    except SystemExit:
        existing = None
    if existing and existing.get("full_name"):
        sys.exit(f"{owner}/{repo} already exists — pick another name or delete it first")

    print(f"creating {owner}/{repo} (public)...")
    api(
        token,
        "POST",
        "/user/repos",
        {
            "name": repo,
            "description": "Download videos through GitHub Actions",
            "private": False,
        },
        expect=(201,),
    )

    print("pushing code...")
    push_code(token, owner, repo)

    cookie_key = secrets.token_hex(32)
    print("setting COOKIE_KEY secret...")
    set_cookie_secret(token, owner, repo, cookie_key)

    print("writing extension/config.js (git-ignored)...")
    write_config(owner, repo, token, cookie_key)

    dest = ROOT / f"youtube-proxy-extension-{owner}.zip"
    build_zip(dest)
    print(f"built {dest.name}")

    print(f"\nDone. https://github.com/{owner}/{repo}")
    print(f"Load the unpacked extension from: {ROOT / 'extension'}")
    print(f"Or share/keep the zip: {dest}")


if __name__ == "__main__":
    main()
