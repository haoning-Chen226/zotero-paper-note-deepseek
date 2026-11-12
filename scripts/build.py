"""Build the Zotero XPI using only the Python standard library."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "plugin"
OUTPUT = ROOT / "dist" / "zotero-paper-note-deepseek.xpi"


def main():
    files = [SOURCE / name for name in ("bootstrap.js", "manifest.json", "prefs.js")]
    files.extend(
        path for path in sorted((SOURCE / "content").iterdir())
        if path.is_file() and path.suffix in {".css", ".js", ".xhtml"}
    )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w") as archive:
        for path in files:
            entry = ZipInfo(path.relative_to(SOURCE).as_posix())
            archive.writestr(entry, path.read_bytes(), compress_type=ZIP_DEFLATED)
    print(OUTPUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
