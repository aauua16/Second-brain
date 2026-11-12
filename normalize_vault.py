"""
Vault normalizer — adds standard frontmatter and related-note links.

Usage:
  python normalize_vault.py                            # dry-run, all personal notes
  python normalize_vault.py --apply                    # apply to all personal notes
  python normalize_vault.py --folder "Readwise in iphone"          # dry-run, target folder
  python normalize_vault.py --folder "Readwise in iphone" --apply  # apply, target folder
"""

import os
import re
import sys
import io
import argparse

# Force UTF-8 output on Windows
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional

import frontmatter as fm_lib
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent))
from search import tokenize

load_dotenv()
VAULT_PATH = Path(os.getenv("VAULT_PATH", ""))

# Always skip these (system / just-generated folders)
ALWAYS_SKIP = {"wiki", ".obsidian", "templates_AI", "textgenerator"}

# Default folders to skip when no --folder is given
DEFAULT_SKIP = ALWAYS_SKIP | {"Readwise in iphone"}

SECTION_MARKER = "## 関連ノート"


# ─── helpers ────────────────────────────────────────────────────────────────

def _top_folder(md_file: Path) -> str:
    try:
        return md_file.relative_to(VAULT_PATH).parts[0]
    except (ValueError, IndexError):
        return ""


def _should_index(md_file: Path) -> bool:
    """Include in BM25 index (all notes except system folders)."""
    if any(p.startswith(".") for p in md_file.parts):
        return False
    return _top_folder(md_file) not in ALWAYS_SKIP


def _clean_text(raw: str, max_len: int = 400) -> str:
    s = re.sub(r"^---[\s\S]*?---\n?", "", raw).strip()
    s = re.sub(r"\[\[([^\|\]]+)(?:\|[^\]]+)?\]\]", r"\1", s)
    s = re.sub(r"[#*>`\-]", " ", s)
    return " ".join(s.split())[:max_len]


# ─── index (built from ALL notes for cross-folder linking) ──────────────────

class NoteIndex:
    def __init__(self):
        self.notes: List[Dict] = []
        self._bm25 = None

    def build(self):
        from rank_bm25 import BM25Okapi
        corpus = []
        for md_file in sorted(VAULT_PATH.rglob("*.md")):
            if not _should_index(md_file):
                continue
            try:
                raw = md_file.read_text(encoding="utf-8", errors="ignore")
                rel = str(md_file.relative_to(VAULT_PATH)).replace("\\", "/")
                self.notes.append({
                    "path": rel,
                    "name": md_file.stem,
                    "file": md_file,
                    "raw": raw,
                    "top_folder": _top_folder(md_file),
                })
                corpus.append(tokenize(md_file.stem + " " + _clean_text(raw)))
            except Exception as e:
                print(f"  index skip {md_file.name}: {e}")
        if corpus:
            self._bm25 = BM25Okapi(corpus)
        print(f"Indexed {len(self.notes)} notes (all folders)")

    def related(self, idx: int, top_k: int = 5) -> List[str]:
        if not self._bm25:
            return []
        note = self.notes[idx]
        query = note["name"] + " " + _clean_text(note["raw"])
        scores = self._bm25.get_scores(tokenize(query))
        scores[idx] = 0.0
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        return [
            self.notes[i]["path"]
            for i in ranked[:top_k]
            if scores[i] > 0.1
        ]


# ─── normalize one note ─────────────────────────────────────────────────────

def normalize(note: Dict, related_paths: List[str], dry_run: bool) -> List[str]:
    raw: str = note["raw"]
    changes: List[str] = []
    new = raw

    # 1. Frontmatter
    if not raw.lstrip().startswith("---"):
        today = datetime.now().strftime("%Y-%m-%d")
        header = f"---\ntags: []\ncreated: {today}\n---\n\n"
        new = header + new
        changes.append("フロントマター追加")
    else:
        try:
            post = fm_lib.loads(raw)
            added_keys = []
            if "created" not in post.metadata:
                m = re.search(r"(\d{4}-\d{2}-\d{2})", note["name"])
                post.metadata["created"] = m.group(1) if m else datetime.now().strftime("%Y-%m-%d")
                added_keys.append("created")
            if "tags" not in post.metadata:
                post.metadata["tags"] = []
                added_keys.append("tags")
            if added_keys:
                new = fm_lib.dumps(post)
                changes.append(f"フロントマター補完 ({', '.join(added_keys)})")
        except Exception:
            pass

    # 2. Related notes section
    if SECTION_MARKER not in new and related_paths:
        lines = [f"\n\n---\n\n{SECTION_MARKER}\n"]
        for p in related_paths:
            name = Path(p).stem
            lines.append(f"- [[{p}|{name}]]")
        new = new.rstrip() + "\n".join(lines) + "\n"
        changes.append(f"関連ノート追加 ({len(related_paths)}件)")

    if changes and not dry_run:
        note["file"].write_text(new, encoding="utf-8")

    return changes


# ─── main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually write files")
    parser.add_argument("--folder", type=str, default=None,
                        help="Process only this top-level folder (e.g. 'Readwise in iphone')")
    args = parser.parse_args()

    dry_run = not args.apply
    target_folder: Optional[str] = args.folder

    print("=" * 60)
    if dry_run:
        print("DRY RUN -- files will NOT be changed")
    else:
        print("APPLY -- files will be written")
    if target_folder:
        print(f"Target folder: {target_folder}")
    print("=" * 60)

    index = NoteIndex()
    index.build()

    # Determine which notes to process
    def should_process(note: Dict) -> bool:
        if target_folder:
            return note["top_folder"] == target_folder
        # Default: skip Readwise (and always-skip)
        return note["top_folder"] not in DEFAULT_SKIP

    targets = [(i, note) for i, note in enumerate(index.notes) if should_process(note)]
    print(f"\nProcessing {len(targets)} notes...\n")

    changed = 0
    change_log: List[str] = []

    for i, note in targets:
        related = index.related(i, top_k=5)
        c = normalize(note, related, dry_run=dry_run)
        if c:
            changed += 1
            change_log.append(f"  [{', '.join(c)}] {note['path']}")

    print(f"Changes: {changed} / {len(targets)} files\n")
    if dry_run:
        for line in change_log[:60]:
            print(line)
        if len(change_log) > 60:
            print(f"  ... and {len(change_log) - 60} more")
        flag = f'--folder "{target_folder}" ' if target_folder else ""
        print(f"\nTo apply: python normalize_vault.py {flag}--apply")
    else:
        print(f"{changed} files updated.")


if __name__ == "__main__":
    main()
