import re
from pathlib import Path
from typing import Dict, List
from datetime import datetime
import frontmatter


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", name)


def _extract_info(md_file: Path, vault_path: Path) -> dict:
    rel_path = str(md_file.relative_to(vault_path)).replace("\\", "/")
    folder = str(md_file.parent.relative_to(vault_path)).replace("\\", "/")
    if folder == ".":
        folder = ""

    try:
        post = frontmatter.load(str(md_file))
        raw_tags = post.metadata.get("tags", [])
        if isinstance(raw_tags, str):
            raw_tags = [t.strip() for t in raw_tags.split(",")]
        tags = [str(t).strip().lstrip("#") for t in raw_tags if t]
        content = post.content
    except Exception:
        content = md_file.read_text(encoding="utf-8", errors="ignore")
        tags = []

    # Inline tags from content
    inline = re.findall(
        r"(?<!\w)#([A-Za-z぀-ヿ一-鿿][A-Za-z0-9぀-ヿ一-鿿_]*)",
        content,
    )
    tags = list(dict.fromkeys(tags + inline))

    wikilinks = re.findall(r"\[\[([^\|\]\n]+?)(?:\|[^\]\n]+?)?\]\]", content)
    preview = " ".join(content.split())[:200]

    return {
        "path": rel_path,
        "name": md_file.stem,
        "folder": folder,
        "tags": tags,
        "wikilinks": wikilinks,
        "preview": preview,
    }


def generate_wiki(vault_path: Path) -> int:
    """Generate wiki/ pages inside the vault. Returns count of pages written."""
    wiki_dir = vault_path / "wiki"
    wiki_dir.mkdir(exist_ok=True)
    (wiki_dir / "タグ").mkdir(exist_ok=True)
    (wiki_dir / "フォルダ").mkdir(exist_ok=True)

    notes: List[dict] = []
    tag_map: Dict[str, List[dict]] = {}
    folder_map: Dict[str, List[dict]] = {}

    for md_file in sorted(vault_path.rglob("*.md")):
        # Skip hidden paths
        if any(p.startswith(".") for p in md_file.parts):
            continue
        # Skip wiki folder itself (avoid infinite loop)
        try:
            rel = md_file.relative_to(vault_path)
        except ValueError:
            continue
        if rel.parts and rel.parts[0] == "wiki":
            continue

        try:
            info = _extract_info(md_file, vault_path)
        except Exception as e:
            print(f"  wiki skip {md_file.name}: {e}")
            continue

        notes.append(info)
        for tag in info["tags"]:
            tag_map.setdefault(tag, []).append(info)
        folder_map.setdefault(info["folder"] or "(root)", []).append(info)

    count = 0

    _write_index(wiki_dir / "インデックス.md", notes, tag_map, folder_map)
    count += 1

    for tag, tnotes in sorted(tag_map.items()):
        if len(tnotes) >= 2:
            _write_tag_page(wiki_dir / "タグ" / f"{_safe(tag)}.md", tag, tnotes)
            count += 1

    for folder, fnotes in sorted(folder_map.items()):
        _write_folder_page(
            wiki_dir / "フォルダ" / f"{_safe(folder)}.md", folder, fnotes
        )
        count += 1

    print(f"Wiki: {count} pages generated ({len(notes)} notes indexed)")
    return count


def _ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _write_index(
    path: Path, notes: List[dict], tag_map: dict, folder_map: dict
):
    ts = _ts()
    lines = [
        "---",
        "wiki: true",
        f"updated: \"{ts}\"",
        "---",
        "",
        "# 📚 Wiki インデックス",
        "",
        f"> 自動生成 — {ts}　|　総ノート数: **{len(notes)} 件**",
        "",
        "---",
        "",
        "## 📁 フォルダ一覧",
        "",
    ]
    for folder in sorted(folder_map.keys()):
        count = len(folder_map[folder])
        display = folder if folder != "(root)" else "（ルート）"
        lines.append(f"- [[フォルダ/{_safe(folder)}|{display}]] — {count} 件")

    lines += ["", "---", "", "## 🏷️ タグ一覧", ""]
    for tag, tnotes in sorted(tag_map.items(), key=lambda x: -len(x[1])):
        count = len(tnotes)
        if count >= 2:
            lines.append(f"- [[タグ/{_safe(tag)}|#{tag}]] — {count} 件")
        else:
            lines.append(f"- #{tag} — {count} 件")

    lines += ["", "---", "", "## 🕐 最近のノート", ""]
    for n in reversed(notes[-30:]):
        folder_badge = f"  `{n['folder']}`" if n["folder"] else ""
        lines.append(f"- [[{n['path']}|{n['name']}]]{folder_badge}")

    path.write_text("\n".join(lines), encoding="utf-8")


def _write_tag_page(path: Path, tag: str, notes: List[dict]):
    ts = _ts()
    lines = [
        "---",
        "wiki: true",
        f"updated: \"{ts}\"",
        "---",
        "",
        f"# 🏷️ #{tag}",
        "",
        f"> タグ「{tag}」を含む **{len(notes)} 件** のノート — {ts}",
        "",
        "---",
        "",
    ]
    by_folder: Dict[str, List[dict]] = {}
    for n in notes:
        by_folder.setdefault(n["folder"] or "(root)", []).append(n)

    for folder in sorted(by_folder.keys()):
        display = folder if folder != "(root)" else "ルート"
        lines.append(f"## 📁 {display}")
        lines.append("")
        for n in sorted(by_folder[folder], key=lambda x: x["name"]):
            lines.append(f"### [[{n['path']}|{n['name']}]]")
            lines.append("")
            if n["preview"]:
                lines.append(f"> {n['preview'][:150]}...")
                lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def _write_folder_page(path: Path, folder: str, notes: List[dict]):
    ts = _ts()
    display = folder if folder != "(root)" else "（ルート）"
    lines = [
        "---",
        "wiki: true",
        f"updated: \"{ts}\"",
        "---",
        "",
        f"# 📁 {display}",
        "",
        f"> このフォルダには **{len(notes)} 件** のノートがあります — {ts}",
        "",
        "---",
        "",
    ]
    for n in sorted(notes, key=lambda x: x["name"]):
        lines.append(f"## [[{n['path']}|{n['name']}]]")
        lines.append("")
        if n["tags"]:
            lines.append("タグ: " + "  ".join(f"#{t}" for t in n["tags"][:6]))
            lines.append("")
        if n["wikilinks"]:
            lines.append("リンク先: " + "  ".join(f"[[{l}]]" for l in n["wikilinks"][:5]))
            lines.append("")
        if n["preview"]:
            lines.append(f"> {n['preview'][:150]}...")
            lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
