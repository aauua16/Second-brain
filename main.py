import os
import re
import threading
from pathlib import Path
from typing import List, Optional
from contextlib import asynccontextmanager

import frontmatter
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel
from google import genai
from dotenv import load_dotenv

from search import NoteSearcher
from wiki_gen import generate_wiki

load_dotenv()

VAULT_PATH = Path(os.getenv("VAULT_PATH", ""))
WIKI_DIR   = str(VAULT_PATH / "wiki")
_client    = genai.Client(api_key=os.getenv("GEMINI_API_KEY", ""))
_searcher: NoteSearcher   = None
_rebuild_timer: threading.Timer = None
_rebuild_lock  = threading.Lock()


def _do_rebuild():
    global _searcher
    try:
        print("Wiki: rebuilding (vault change detected)...")
        generate_wiki(VAULT_PATH)
        _searcher = NoteSearcher(VAULT_PATH)
        print("Wiki: rebuild complete")
    except Exception as e:
        print(f"Wiki rebuild error: {e}")


def _add_related_notes(md_file_path: str):
    md_file = Path(md_file_path)
    if not md_file.exists():
        return
    try:
        content = md_file.read_text(encoding="utf-8", errors="ignore")
        if "## 関連ノート" in content:
            return

        try:
            rel = md_file.relative_to(VAULT_PATH)
        except ValueError:
            return
        if rel.parts and rel.parts[0] == "wiki":
            return

        if not _searcher:
            return

        clean = re.sub(r"^---[\s\S]*?---\n?", "", content).strip()
        if not clean:
            return

        query = md_file.stem + " " + clean[:500]
        rel_path = str(rel).replace("\\", "/")
        results = [r for r in _searcher.search(query, top_k=6) if r["path"] != rel_path][:5]

        if not results:
            return

        links = "\n".join(f"- [[{r['path']}|{r['name']}]]" for r in results)
        addition = f"\n\n---\n\n## 関連ノート\n\n{links}\n"

        with open(md_file, "a", encoding="utf-8") as f:
            f.write(addition)

        print(f"Related notes added: {md_file.name}")
    except Exception as e:
        print(f"Related notes error for {md_file_path}: {e}")


def _schedule_rebuild():
    global _rebuild_timer
    with _rebuild_lock:
        if _rebuild_timer is not None:
            _rebuild_timer.cancel()
        _rebuild_timer = threading.Timer(3.0, _do_rebuild)
        _rebuild_timer.start()


def _start_watcher():
    try:
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler

        class VaultHandler(FileSystemEventHandler):
            def _should_handle(self, src_path: str) -> bool:
                if not src_path.endswith(".md"):
                    return False
                return not src_path.startswith(WIKI_DIR)

            def on_created(self, event):
                if not event.is_directory and self._should_handle(event.src_path):
                    _schedule_rebuild()
                    t = threading.Timer(4.0, _add_related_notes, args=[event.src_path])
                    t.daemon = True
                    t.start()

            def on_modified(self, event):
                if not event.is_directory and self._should_handle(event.src_path):
                    _schedule_rebuild()

        observer = Observer()
        observer.schedule(VaultHandler(), str(VAULT_PATH), recursive=True)
        observer.daemon = True
        observer.start()
        print("File watcher started — wiki auto-rebuilds on vault changes")
    except ImportError:
        print("watchdog not installed — run: pip install watchdog")
    except Exception as e:
        print(f"File watcher error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _searcher
    _searcher = NoteSearcher(VAULT_PATH)
    try:
        generate_wiki(VAULT_PATH)
    except Exception as e:
        print(f"Wiki generation error: {e}")
    _start_watcher()
    yield


app = FastAPI(title="Second Brain", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")


class ChatRequest(BaseModel):
    message: str
    note_path: Optional[str] = None


@app.get("/local-backend.js")
async def local_backend_js():
    return FileResponse("static/local-backend.js", media_type="text/javascript")


@app.get("/", response_class=HTMLResponse)
async def root():
    with open("static/index.html", encoding="utf-8") as f:
        return f.read()


@app.get("/api/notes")
async def list_notes():
    notes = []
    for md_file in VAULT_PATH.rglob("*.md"):
        if any(part.startswith(".") for part in md_file.parts):
            continue
        rel = md_file.relative_to(VAULT_PATH)
        folder = str(rel.parent).replace("\\", "/")
        notes.append({
            "path": str(rel).replace("\\", "/"),
            "name": md_file.stem,
            "folder": "" if folder == "." else folder,
        })
    return sorted(notes, key=lambda x: x["path"])


def _resolve_note(rel: str) -> Optional[Path]:
    """Vault 内の .md だけを返す（../ による外部アクセスを拒否）。"""
    try:
        p = (VAULT_PATH / rel).resolve()
        p.relative_to(VAULT_PATH.resolve())
    except (ValueError, OSError):
        return None
    return p if p.suffix == ".md" and p.is_file() else None


@app.get("/api/note")
async def get_note(path: str = Query(...)):
    note_file = _resolve_note(path)
    if note_file is None:
        raise HTTPException(404, "Note not found")

    try:
        post = frontmatter.load(str(note_file))
        content = post.content
        metadata = dict(post.metadata)
    except Exception:
        content = note_file.read_text(encoding="utf-8", errors="ignore")
        metadata = {}

    return {
        "path": path,
        "name": note_file.stem,
        "content": content,
        "metadata": metadata,
        "backlinks": _find_backlinks(path),
    }


def _find_backlinks(target_path: str) -> List[str]:
    target_name = Path(target_path).stem
    pattern = re.compile(
        r"\[\[" + re.escape(target_name) + r"(\|[^\]]+)?\]\]", re.IGNORECASE
    )
    backlinks = []
    for md_file in VAULT_PATH.rglob("*.md"):
        try:
            text = md_file.read_text(encoding="utf-8", errors="ignore")
            rel = str(md_file.relative_to(VAULT_PATH)).replace("\\", "/")
            if rel != target_path and pattern.search(text):
                backlinks.append(rel)
        except Exception:
            pass
    return backlinks


@app.get("/api/search")
async def search_notes(q: str = Query(..., min_length=1)):
    results = _searcher.search(q, top_k=12)
    return [
        {"path": r["path"], "name": r["name"], "snippet": r["snippet"], "score": r["score"]}
        for r in results
    ]


@app.post("/api/wiki/rebuild")
async def rebuild_wiki():
    try:
        count = generate_wiki(VAULT_PATH)
        global _searcher
        _searcher = NoteSearcher(VAULT_PATH)
        return {"status": "ok", "pages": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat")
async def chat(req: ChatRequest):
    relevant = _searcher.search(req.message, top_k=12)

    context_parts: List[str] = []
    sources: List[str] = []

    if req.note_path:
        try:
            note_file = _resolve_note(req.note_path)
            if note_file is None:
                raise ValueError("invalid note path")
            raw = note_file.read_text(encoding="utf-8", errors="ignore")
            clean = re.sub(r"^---[\s\S]*?---\n?", "", raw).strip()
            context_parts.append(f"【現在開いているノート: {req.note_path}】\n{clean[:3000]}")
            sources.append(req.note_path)
        except Exception:
            pass

    for r in relevant:
        if r["path"] not in sources:
            context_parts.append(f"【関連ノート: {r['path']}】\n{r['content'][:2000]}")
            sources.append(r["path"])

    context = "\n\n".join(context_parts[:13])

    prompt = (
        "あなたはObsidianノートを使った学習をサポートするAIアシスタントです。\n"
        "提供されたノートの内容を参考に、わかりやすく日本語で回答してください。\n"
        "どのノートから得た情報かを明示し、ノートにない内容は一般知識で補足してください。\n"
        "回答は構造化して、見出しや箇条書きを活用してください。\n\n"
        f"質問: {req.message}\n\n参考ノート:\n{context}"
    )

    try:
        response = _client.models.generate_content(
            model="gemini-2.0-flash-lite",
            contents=prompt,
        )
        return {"answer": response.text, "sources": sources}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
