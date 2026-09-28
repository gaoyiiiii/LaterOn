#!/usr/bin/env python3
"""Build a minimal, reproducible LaterOn extension ZIP from an explicit allowlist."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Only files required by the installed extension belong in a release package.
# Keep this list explicit: adding a test, screenshot, design draft or document to
# the repository must never make it into a user's extension by accident.
RUNTIME_FILES = (
    "manifest.json",
    "article-cover-placeholder.png",
    "background.js",
    "boot.js",
    "content-folder-picker.js",
    "content-metadata.js",
    "content-translation.js",
    "dialog.css",
    "dialog.js",
    "i18n.js",
    "icon16.png",
    "icon32.png",
    "icon48.png",
    "icon128.png",
    "library.css",
    "library.html",
    "library.js",
    "onboarding.css",
    "onboarding.js",
    "picker-ui.js",
    "reading-position-background.js",
    "content-reading-position.js",
    "settings.css",
    "settings.html",
    "settings.js",
    "sidepanel.css",
    "sidepanel.html",
    "sidepanel.js",
    "tab-navigation.js",
    "theme-vars.css",
    "theme.js",
    "translation.css",
    "url-utils.js",
)
RUNTIME_DIRS = ("_locales",)

FORBIDDEN_PREFIXES = ("tests/", "design/", "scripts/", "dist/", ".git/")
FORBIDDEN_NAMES = {
    ".DS_Store",
    ".gitignore",
    "README.md",
    "CHANGELOG.md",
    "icon.svg",
    "popup.css",
    "popup.html",
    "popup.js",
}


def relative_name(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def release_files() -> list[Path]:
    files = [ROOT / name for name in RUNTIME_FILES]
    for directory in RUNTIME_DIRS:
        files.extend(path for path in (ROOT / directory).rglob("*") if path.is_file())

    missing = [relative_name(path) for path in files if not path.is_file()]
    if missing:
        raise RuntimeError("Missing required release files: " + ", ".join(missing))

    duplicates = [name for name in {relative_name(path) for path in files} if sum(relative_name(item) == name for item in files) > 1]
    if duplicates:
        raise RuntimeError("Duplicate release entries: " + ", ".join(sorted(duplicates)))

    return sorted(files, key=relative_name)


def validate_manifest(files: list[Path]) -> str:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = str(manifest.get("version", "")).strip()
    if not version:
        raise RuntimeError("manifest.json has no version")

    names = {relative_name(path) for path in files}
    referenced = {
        manifest.get("background", {}).get("service_worker"),
        manifest.get("side_panel", {}).get("default_path"),
        manifest.get("options_page"),
    }
    referenced.update(manifest.get("icons", {}).values())
    referenced.update(manifest.get("action", {}).get("default_icon", {}).values())
    for group in manifest.get("web_accessible_resources", []):
        referenced.update(group.get("resources", []))

    missing = sorted(path for path in referenced if path and path not in names)
    if missing:
        raise RuntimeError("Manifest references files outside the release allowlist: " + ", ".join(missing))
    return version


def validate_archive(archive: Path, expected: set[str]) -> None:
    with zipfile.ZipFile(archive) as package:
        names = package.namelist()
        if len(names) != len(set(names)):
            raise RuntimeError("Release ZIP contains duplicate entries")
        if set(names) != expected:
            missing = sorted(expected - set(names))
            extra = sorted(set(names) - expected)
            raise RuntimeError(f"Release ZIP contents differ from allowlist; missing={missing}, extra={extra}")
        for name in names:
            if name in FORBIDDEN_NAMES or name.endswith(".md") or name.startswith(FORBIDDEN_PREFIXES):
                raise RuntimeError(f"Development-only file leaked into release ZIP: {name}")
        json.loads(package.read("manifest.json").decode("utf-8"))


def build() -> Path:
    files = release_files()
    version = validate_manifest(files)
    DIST.mkdir(exist_ok=True)
    archive = DIST / f"LaterOn-{version}.zip"
    temporary = archive.with_suffix(".zip.tmp")

    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for path in files:
                name = relative_name(path)
                # A fixed timestamp makes identical source trees produce identical archives.
                entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = 0o644 << 16
                package.writestr(entry, path.read_bytes(), compresslevel=9)
        validate_archive(temporary, {relative_name(path) for path in files})
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)

    return archive


def main() -> int:
    try:
        archive = build()
    except Exception as error:
        print(f"Release build failed: {error}", file=sys.stderr)
        return 1

    with zipfile.ZipFile(archive) as package:
        count = len(package.namelist())
    size_kb = archive.stat().st_size / 1024
    print(f"Built {archive.relative_to(ROOT)} ({count} files, {size_kb:.1f} KB)")
    print("Verified: no tests, design drafts, previews, documentation, .DS_Store or icon.svg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
