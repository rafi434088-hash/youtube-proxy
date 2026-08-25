"""Rebuild every deliverable from the current source, so they can't drift apart.

Three things ship from this one checkout and they kept going out of sync — most
recently a zip was loaded that predated a feature entirely, and the button it was
supposed to add simply wasn't in it. This regenerates all of them in one pass:

  1. the active install (rafi434088-hash)  -> Desktop folder + Documents folder + Downloads zip
  2. the second account (yb0533176408)     -> Desktop folder + zip
  3. the shareable copy (no personal data) -> Desktop folder + zip, with instructions

Per-account builds take their settings from .configs/config.<owner>.js. The shareable
build has no config.js at all and is scanned for leaked identifiers before it is
written — the scan raises rather than shipping a zip with a token in it.

    python tools/build_all.py
"""

import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path.home()
DESKTOP = HOME / "Desktop"
DOCUMENTS = HOME / "Documents"
DOWNLOADS = HOME / "Downloads"

# Anything matching these must never appear in the shareable build.
SECRET_PATTERNS = [
    re.compile(r"rafi434088"),
    re.compile(r"yb0533176408"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"\b[0-9a-f]{64}\b"),  # a real cookieKey
]
SCAN_SUFFIXES = {".js", ".json", ".md", ".txt", ".yml", ".yaml", ".html", ".css", ".py", ".bat"}


def zip_folder(folder: Path, zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(folder).as_posix())


def fresh(folder: Path) -> Path:
    if folder.exists():
        shutil.rmtree(folder)
    folder.parent.mkdir(parents=True, exist_ok=True)
    return folder


def build_account(owner: str, folder: Path) -> Path:
    """Loadable extension for one account: extension/ + that account's config.js."""
    config = ROOT / ".configs" / f"config.{owner}.js"
    if not config.exists():
        sys.exit(f"missing {config} — run tools/clone_to_account.py or tools/embed_token.py first")
    fresh(folder)
    shutil.copytree(
        ROOT / "extension", folder, ignore=shutil.ignore_patterns("config.example.js", "config.js")
    )
    shutil.copy2(config, folder / "config.js")

    cfg = (folder / "config.js").read_text(encoding="utf-8")
    actual = re.search(r'owner:\s*"([^"]*)"', cfg)
    if not actual or actual.group(1) != owner:
        sys.exit(f"{folder.name}: config owner is {actual and actual.group(1)!r}, expected {owner!r}")
    if not (folder / "content.js").exists():
        sys.exit(f"{folder.name}: content.js missing")
    return folder


def scan_for_secrets(folder: Path) -> None:
    hits = []
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SCAN_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line_no, line in enumerate(text.splitlines(), 1):
            for pattern in SECRET_PATTERNS:
                if pattern.search(line):
                    hits.append(f"{path.relative_to(folder)}:{line_no}: {line.strip()[:90]}")
    if hits:
        sys.exit("shareable build contains personal data:\n  " + "\n  ".join(hits))


def build_share(folder: Path) -> Path:
    """The copy meant for other people: full project, no config.js, no identifiers."""
    fresh(folder)
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        ROOT / "extension",
        folder / "extension",
        ignore=shutil.ignore_patterns("config.js"),  # keep config.example.js as the template
    )
    shutil.copytree(ROOT / ".github", folder / ".github")
    # build_all.py is a local orchestrator that hardcodes this machine's account names —
    # it isn't part of the product, and the secret scan below rightly rejects it.
    shutil.copytree(
        ROOT / "tools",
        folder / "tools",
        ignore=shutil.ignore_patterns("__pycache__", "build_all.py"),
    )
    for name in ("README.md", ".gitignore", "set-token.bat"):
        if (ROOT / name).exists():
            shutil.copy2(ROOT / name, folder / name)

    # Sourced from the repo, not from the previous build: fresh() wipes the output
    # folder first, so reading the instructions back out of it silently produced a
    # zip with no instructions in it.
    instructions = ROOT / "docs" / "הוראות שימוש.txt"
    if not instructions.exists():
        sys.exit(f"missing {instructions}")
    shutil.copy2(instructions, folder / instructions.name)

    if (folder / "extension" / "config.js").exists():
        sys.exit("shareable build unexpectedly contains config.js")
    scan_for_secrets(folder)
    return folder


def main() -> None:
    # 1. active install
    mine = build_account("rafi434088-hash", DESKTOP / "הורדה מיוטיוב")
    zip_folder(mine, DOWNLOADS / "youtube-proxy-extension.zip")
    zip_folder(mine, ROOT / "youtube-proxy-extension.zip")
    docs_copy = fresh(DOCUMENTS / "הורדה מיוטיוב")
    shutil.copytree(mine, docs_copy)
    print(f"[1] rafi434088-hash -> {mine}")
    print(f"                    -> {docs_copy}")
    print(f"                    -> {DOWNLOADS / 'youtube-proxy-extension.zip'}")

    # 2. second account
    yd = build_account("yb0533176408", DESKTOP / "הורדה מיוטיוב - יהודה")
    zip_folder(yd, ROOT / "הורדה מיוטיוב יהודה בודהניימר.zip")
    zip_folder(yd, DESKTOP / "הורדה מיוטיוב - יהודה.zip")
    print(f"[2] yb0533176408    -> {yd}")
    print(f"                    -> {DESKTOP / 'הורדה מיוטיוב - יהודה.zip'}")

    # 3. shareable
    share = build_share(DESKTOP / "youtube-proxy-template")
    zip_folder(share, DESKTOP / "הורדה מיוטיוב דרך גיטהאב.zip")
    print(f"[3] shareable       -> {share}  (secret scan passed)")
    print(f"                    -> {DESKTOP / 'הורדה מיוטיוב דרך גיטהאב.zip'}")


if __name__ == "__main__":
    main()
