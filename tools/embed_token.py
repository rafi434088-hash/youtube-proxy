"""Embed the GitHub token into extension/config.js and rebuild the loadable zip.

The token is read from a prompt (it never appears in your shell history), checked
against the API to make sure it can actually reach the workflow, then written into
config.js as split, XOR-obfuscated chunks (see the comment embed_token writes into
the file) rather than as a plain string. config.js is git-ignored, so none of this
reaches the public repo either way — the obfuscation is only so the token doesn't
sit in the file as one readable string. The zip is rebuilt so it ships as default.

    python tools/embed_token.py
"""

import base64
import getpass
import json
import re
import secrets
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "extension" / "config.js"
ZIP = ROOT / "youtube-proxy-extension.zip"

FIELD_RE = re.compile(r'^\s*(owner|repo|workflow|ref):\s*"([^"]*)"', re.MULTILINE)


def read_field(name):
    text = CONFIG.read_text(encoding="utf-8")
    match = re.search(rf'^\s*{name}:\s*"([^"]*)"', text, re.MULTILINE)
    return match.group(1) if match else ""


def obfuscate_token(token, n=5):
    """Repeating-key XOR, base64, then interleaved into n chunks — see config.js."""
    key = secrets.token_hex(11)
    xored = bytes(b ^ ord(key[i % len(key)]) for i, b in enumerate(token.encode()))
    b64 = base64.b64encode(xored).decode()
    chunks = [b64[i::n] for i in range(n)]
    return chunks, key


def write_token(token):
    chunks, key = obfuscate_token(token)
    chunks_js = ", ".join(f'"{c}"' for c in chunks)
    text = CONFIG.read_text(encoding="utf-8")
    text, count = re.subn(
        r'const _TK_CHUNKS = \[[^\]]*\];\nconst _TK_KEY = "[^"]*";',
        f'const _TK_CHUNKS = [{chunks_js}];\nconst _TK_KEY = "{key}";',
        text,
        count=1,
    )
    if count != 1:
        sys.exit(
            f"could not find the _TK_CHUNKS/_TK_KEY block in {CONFIG} — "
            "the file may have been edited; regenerate it from config.example.js"
        )
    CONFIG.write_text(text, encoding="utf-8")


def check(token, owner, repo, workflow):
    """Confirm the token reaches the workflow before we bake it in."""
    url = f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            body = json.load(res)
        return True, f"{body.get('name', workflow)} ({body.get('state', '?')})"
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.load(err).get("message", "")
        except Exception:
            pass
        if err.code == 401:
            return False, "the token is not valid"
        if err.code == 404:
            return False, "not found - the token probably has no access to this repo"
        return False, f"HTTP {err.code} {detail}".strip()
    except urllib.error.URLError as err:
        return False, f"network error: {err.reason}"


def rebuild_zip():
    src = ROOT / "extension"
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(src.rglob("*")):
            if path.is_file() and path.name != "config.example.js":
                z.write(path, path.relative_to(src).as_posix())
    return ZIP


def main():
    owner = read_field("owner")
    repo = read_field("repo")
    workflow = read_field("workflow") or "download.yml"
    if not owner or not repo:
        sys.exit(f"owner/repo are empty in {CONFIG} - fill them in first")

    print(f"repo:     {owner}/{repo}")
    print(f"workflow: {workflow}")
    print()
    print("Create the token at https://github.com/settings/personal-access-tokens/new")
    print("  Repository access -> Only select repositories -> this repo only")
    print("  Permissions -> Actions: Read and write   (nothing else)")
    print()

    token = getpass.getpass("Paste the token (it stays hidden): ").strip()
    if not token:
        sys.exit("no token given, nothing changed")
    if not token.startswith(("github_pat_", "ghp_")):
        print("warning: that does not look like a GitHub token", file=sys.stderr)

    ok, detail = check(token, owner, repo, workflow)
    if not ok:
        sys.exit(f"the token was rejected: {detail}\nnothing was written")
    print(f"token works - reached workflow: {detail}")

    write_token(token)
    print(f"written into {CONFIG.relative_to(ROOT)} as obfuscated chunks (git-ignored, stays local)")
    print(f"rebuilt {rebuild_zip().relative_to(ROOT)}")
    print()
    print("Reload the extension at chrome://extensions to pick up the new default.")


if __name__ == "__main__":
    main()
