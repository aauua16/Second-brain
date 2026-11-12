import re
from pathlib import Path
from typing import List, Dict
from rank_bm25 import BM25Okapi


def tokenize(text: str) -> List[str]:
    """Tokenize Japanese + English text using bigrams for CJK and words for ASCII."""
    text = text.lower()
    tokens = []
    i = 0
    while i < len(text):
        c = text[i]
        if c.isascii():
            if c.isalnum():
                j = i
                while j < len(text) and text[j].isascii() and text[j].isalnum():
                    j += 1
                tokens.append(text[i:j])
                i = j
            else:
                i += 1
        else:
            # CJK character: add unigram and bigram
            tokens.append(c)
            if i + 1 < len(text) and not text[i + 1].isascii():
                tokens.append(text[i:i + 2])
            i += 1
    return tokens if tokens else [""]


class NoteSearcher:
    def __init__(self, vault_path: Path):
        self.vault_path = vault_path
        self.notes: List[Dict] = []
        self.bm25: BM25Okapi = None
        self._build_index()

    def _build_index(self):
        print(f"Indexing vault: {self.vault_path}")
        corpus = []

        for md_file in sorted(self.vault_path.rglob("*.md")):
            if any(part.startswith(".") for part in md_file.parts):
                continue
            try:
                raw = md_file.read_text(encoding="utf-8", errors="ignore")
                # Strip YAML frontmatter
                clean = re.sub(r"^---[\s\S]*?---\n?", "", raw).strip()
                rel_path = str(md_file.relative_to(self.vault_path)).replace("\\", "/")
                snippet = " ".join(clean.split())[:250]

                self.notes.append({
                    "path": rel_path,
                    "name": md_file.stem,
                    "content": clean[:6000],
                    "snippet": snippet,
                })
                corpus.append(tokenize(md_file.stem + " " + clean))
            except Exception as e:
                print(f"  Skip {md_file.name}: {e}")

        if corpus:
            self.bm25 = BM25Okapi(corpus)
        print(f"Indexed {len(self.notes)} notes")

    def search(self, query: str, top_k: int = 10) -> List[Dict]:
        if not self.bm25 or not self.notes:
            return []

        scores = self.bm25.get_scores(tokenize(query))
        top_idx = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]

        return [
            {**self.notes[i], "score": float(scores[i])}
            for i in top_idx
            if scores[i] > 0
        ]
