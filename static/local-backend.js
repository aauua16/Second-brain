/* Second Brain — ブラウザ単体バックエンド
 * index.html を file:// で直接開いたときに使われる。サーバー不要。
 * - Vault は File System Access API（Chrome / Edge）でフォルダ選択
 * - 検索は main/search.py と同じ BM25 + 日本語バイグラム
 * - チャットは Gemini REST API をブラウザから直接呼ぶ（キーは localStorage に保存）
 */
const LocalBackend = (() => {
  const DB_NAME = 'second_brain_idb', DB_STORE = 'handles';
  const LS_KEY = 'second_brain_gemini_key', LS_MODEL = 'second_brain_gemini_model';
  const DEFAULT_MODEL = 'gemini-2.0-flash-lite';

  let root = null;
  let list = [];                // [{path, name, folder, handle}]  ← 表示用（wiki含む）
  let docs = [];                // 検索対象 [{path, name, folder, clean, snippet, fmTags, links}]
  let postings = new Map();     // token -> [[docIdx, tf], ...]
  let docLen = [], avgdl = 1, idfCache = new Map(), avgIdf = 0;
  let linksTo = new Map();      // 小文字ノート名 -> [path]
  let progress = () => {};

  // ── IndexedDB（フォルダハンドルの保存） ──
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const idbGet = async key => { try {
    return await withTimeout(idbGetRaw(key), 2000);
  } catch { return null; } };
  const idbGetRaw = async key => { {
    const db = await idb();
    return await new Promise((res, rej) => {
      const q = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
      q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
    });
  } };
  const idbPut = async (key, val) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  };

  // ── テキスト処理（search.py の移植） ──
  function tokenize(text) {
    const chars = Array.from(text.toLowerCase());
    const out = [];
    let i = 0;
    while (i < chars.length) {
      const c = chars[i];
      if (c.charCodeAt(0) < 128) {
        if (/[a-z0-9]/.test(c)) {
          let j = i;
          while (j < chars.length && /[a-z0-9]/.test(chars[j]) && chars[j].charCodeAt(0) < 128) j++;
          out.push(chars.slice(i, j).join(''));
          i = j;
        } else i++;
      } else {
        out.push(c);
        if (i + 1 < chars.length && chars[i + 1].charCodeAt(0) >= 128) out.push(c + chars[i + 1]);
        i++;
      }
    }
    return out.length ? out : [''];
  }

  const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  function splitFm(raw) {
    const m = raw.match(FM_RE);
    return m ? { fm: m[1], body: raw.slice(m[0].length) } : { fm: '', body: raw };
  }

  function parseFmTags(fm) {
    if (!fm) return [];
    const lines = fm.split(/\r?\n/);
    const clean = t => String(t).trim().replace(/^["']|["']$/g, '').replace(/^#/, '').trim();
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^tags:\s*(.*)$/);
      if (!m) continue;
      let v = m[1].trim();
      if (v) return v.replace(/^\[|\]$/g, '').split(',').map(clean).filter(Boolean);
      const tags = [];
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j].match(/^\s*-\s*(.+)$/);
        if (!b) break;
        tags.push(clean(b[1]));
      }
      return tags.filter(Boolean);
    }
    return [];
  }

  const WL_RE = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;
  function extractLinkTargets(text) {
    const out = [];
    for (const m of text.matchAll(WL_RE)) {
      const t = m[1].trim().split('/').pop().replace(/\.md$/i, '').toLowerCase();
      if (t) out.push(t);
    }
    return out;
  }

  // ── Vault の走査・インデックス ──
  async function walk(dir, prefix, out) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') await walk(h, prefix + name + '/', out);
      else if (name.toLowerCase().endsWith('.md'))
        out.push({ path: prefix + name, name: name.replace(/\.md$/i, ''), folder: prefix.replace(/\/$/, ''), handle: h });
    }
  }

  async function scanList() {
    const out = [];
    await walk(root, '', out);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    list = out;
  }

  async function buildIndex() {
    progress('ノートを走査中…');
    await scanList();
    docs = []; postings = new Map(); docLen = []; linksTo = new Map(); idfCache = new Map();
    const targets = list.filter(n => !n.path.startsWith('wiki/'));
    let done = 0;
    const slots = new Array(targets.length);

    async function readOne(idx) {
      const n = targets[idx];
      try {
        const raw = await (await n.handle.getFile()).text();
        const { fm, body } = splitFm(raw);
        const clean = body.trim();
        slots[idx] = { path: n.path, name: n.name, folder: n.folder, clean: clean.slice(0, 60000),
          snippet: clean.split(/\s+/).join(' ').slice(0, 250), fmTags: parseFmTags(fm),
          tokens: tokenize(n.name + ' ' + clean), links: extractLinkTargets(clean) };
      } catch (e) { console.warn('skip', n.path, e); }
      if (++done % 25 === 0) progress(`インデックス作成中 ${done}/${targets.length}`);
    }
    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < targets.length) await readOne(next++);
    }));

    for (const s of slots) {
      if (!s) continue;
      const idx = docs.length;
      docs.push(s);
      docLen.push(s.tokens.length);
      const tf = new Map();
      for (const t of s.tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, f] of tf) {
        let p = postings.get(t);
        if (!p) postings.set(t, p = []);
        p.push([idx, f]);
      }
      for (const l of new Set(s.links)) {
        let a = linksTo.get(l);
        if (!a) linksTo.set(l, a = []);
        a.push(s.path);
      }
      s.tokens = null;                          // メモリ節約
    }
    const N = docs.length;
    avgdl = N ? docLen.reduce((a, b) => a + b, 0) / N : 1;
    // rank_bm25 (Okapi) と同じ idf 定義
    let sum = 0; const neg = [];
    for (const [t, p] of postings) {
      const idf = Math.log(N - p.length + 0.5) - Math.log(p.length + 0.5);
      idfCache.set(t, idf); sum += idf; if (idf < 0) neg.push(t);
    }
    avgIdf = postings.size ? sum / postings.size : 0;
    for (const t of neg) idfCache.set(t, 0.25 * avgIdf);
    progress(null);
  }

  function search(q, topK = 12) {
    const N = docs.length;
    if (!N) return [];
    const scores = new Float64Array(N);
    const k1 = 1.5, b = 0.75;
    for (const t of tokenize(q)) {
      const p = postings.get(t);
      if (!p) continue;
      const idf = idfCache.get(t);
      for (const [d, f] of p)
        scores[d] += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * docLen[d] / avgdl));
    }
    return Array.from(scores.keys()).sort((a, b2) => scores[b2] - scores[a]).slice(0, topK)
      .filter(i => scores[i] > 0).map(i => ({ ...docs[i], score: scores[i] }));
  }

  const entry = path => list.find(n => n.path === path);
  async function readNote(path) {
    const e = entry(path);
    if (!e) return null;
    const raw = await (await e.handle.getFile()).text();
    return { e, body: splitFm(raw).body.trim() };
  }

  // ── Wiki 生成（wiki_gen.py の移植） ──
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '_');
  const ts = () => { const d = new Date(), z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  const INLINE_TAG = /(?<![\w])#([A-Za-z぀-ヿ一-鿿][A-Za-z0-9぀-ヿ一-鿿_]*)/g;

  async function writeFile(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text); await w.close();
  }

  async function generateWiki() {
    const wikiDir = await root.getDirectoryHandle('wiki', { create: true });
    const tagDir = await wikiDir.getDirectoryHandle('タグ', { create: true });
    const folDir = await wikiDir.getDirectoryHandle('フォルダ', { create: true });
    const notes = [], tagMap = new Map(), folMap = new Map();
    for (const d of docs) {
      const inline = Array.from(d.clean.matchAll(INLINE_TAG), m => m[1]);
      const tags = [...new Set([...d.fmTags, ...inline])];
      const wikilinks = Array.from(d.clean.matchAll(/\[\[([^|\]\n]+?)(?:\|[^\]\n]+?)?\]\]/g), m => m[1]);
      const info = { path: d.path, name: d.name, folder: d.folder, tags, wikilinks,
        preview: d.clean.split(/\s+/).join(' ').slice(0, 200) };
      notes.push(info);
      for (const t of tags) (tagMap.get(t) || tagMap.set(t, []).get(t)).push(info);
      const fk = info.folder || '(root)';
      (folMap.get(fk) || folMap.set(fk, []).get(fk)).push(info);
    }
    const T = ts();
    const head = (title, quote) => ['---', 'wiki: true', `updated: "${T}"`, '---', '', title, '', quote, '', '---', ''];
    const sortKeys = m => [...m.keys()].sort();
    let count = 0;

    // index
    const L = head('# 📚 Wiki インデックス', `> 自動生成 — ${T}　|　総ノート数: **${notes.length} 件**`);
    L.push('## 📁 フォルダ一覧', '');
    for (const f of sortKeys(folMap)) L.push(`- [[フォルダ/${safe(f)}|${f !== '(root)' ? f : '（ルート）'}]] — ${folMap.get(f).length} 件`);
    L.push('', '---', '', '## 🏷️ タグ一覧', '');
    for (const [t, ns] of [...tagMap].sort((a, b) => b[1].length - a[1].length))
      L.push(ns.length >= 2 ? `- [[タグ/${safe(t)}|#${t}]] — ${ns.length} 件` : `- #${t} — ${ns.length} 件`);
    L.push('', '---', '', '## 🕐 最近のノート', '');
    for (const n of notes.slice(-30).reverse()) L.push(`- [[${n.path}|${n.name}]]${n.folder ? `  \`${n.folder}\`` : ''}`);
    await writeFile(wikiDir, 'インデックス.md', L.join('\n')); count++;

    // tags
    for (const t of sortKeys(tagMap)) {
      const ns = tagMap.get(t);
      if (ns.length < 2) continue;
      const P = head(`# 🏷️ #${t}`, `> タグ「${t}」を含む **${ns.length} 件** のノート — ${T}`);
      const byF = new Map();
      for (const n of ns) (byF.get(n.folder || '(root)') || byF.set(n.folder || '(root)', []).get(n.folder || '(root)')).push(n);
      for (const f of sortKeys(byF)) {
        P.push(`## 📁 ${f !== '(root)' ? f : 'ルート'}`, '');
        for (const n of byF.get(f).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          P.push(`### [[${n.path}|${n.name}]]`, '');
          if (n.preview) P.push(`> ${n.preview.slice(0, 150)}...`, '');
        }
      }
      await writeFile(tagDir, `${safe(t)}.md`, P.join('\n')); count++;
    }

    // folders
    for (const f of sortKeys(folMap)) {
      const ns = folMap.get(f);
      const P = head(`# 📁 ${f !== '(root)' ? f : '（ルート）'}`, `> このフォルダには **${ns.length} 件** のノートがあります — ${T}`);
      for (const n of [...ns].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        P.push(`## [[${n.path}|${n.name}]]`, '');
        if (n.tags.length) P.push('タグ: ' + n.tags.slice(0, 6).map(t => `#${t}`).join('  '), '');
        if (n.wikilinks.length) P.push('リンク先: ' + n.wikilinks.slice(0, 5).map(l => `[[${l}]]`).join('  '), '');
        if (n.preview) P.push(`> ${n.preview.slice(0, 150)}...`, '');
      }
      await writeFile(folDir, `${safe(f)}.md`, P.join('\n')); count++;
    }
    return count;
  }

  // ── 公開 API（サーバー版と同じ形） ──
  return {
    mode: 'local',
    onProgress(fn) { progress = fn || (() => {}); },
    vaultName: () => (root ? root.name : ''),
    hasKey: () => !!localStorage.getItem(LS_KEY),
    getSettings: () => ({ key: localStorage.getItem(LS_KEY) || '', model: localStorage.getItem(LS_MODEL) || DEFAULT_MODEL }),
    saveSettings(key, model) {
      localStorage.setItem(LS_KEY, key.trim());
      localStorage.setItem(LS_MODEL, (model || '').trim() || DEFAULT_MODEL);
    },

    async init() {
      if (!window.showDirectoryPicker) throw new Error('Chrome または Edge で開いてください');
      const h = await idbGet('vault');
      if (!h) return { needsVault: true };
      root = h;
      let perm = 'prompt';
      try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch {}
      if (perm !== 'granted') return { needsVault: true, saved: h.name };
      await buildIndex();
      return {};
    },

    // ユーザー操作（クリック）から呼ぶこと
    async connect(reuseSaved) {
      let h = reuseSaved ? await idbGet('vault') : null;
      if (!h) h = await window.showDirectoryPicker({ mode: 'readwrite' });
      if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('フォルダへのアクセスが許可されませんでした');
      root = h;
      await idbPut('vault', h);
      await buildIndex();
    },

    async notes() { return list.map(({ path, name, folder }) => ({ path, name, folder })); },

    async note(path) {
      const r = await readNote(path);
      if (!r) return null;
      const backlinks = (linksTo.get(r.e.name.toLowerCase()) || []).filter(p => p !== path && !p.startsWith('wiki/'));
      return { path, name: r.e.name, content: r.body, metadata: {}, backlinks };
    },

    async search(q) {
      return search(q, 12).map(r => ({ path: r.path, name: r.name, snippet: r.snippet, score: r.score }));
    },

    async chat(message, notePath) {
      const { key, model } = this.getSettings();
      if (!key) throw new Error('Gemini API キーが未設定です（サイドバーの ⚙️ から設定してください）');
      const parts = [], sources = [];
      if (notePath) {
        try {
          const r = await readNote(notePath);
          if (r) { parts.push(`【現在開いているノート: ${notePath}】\n${r.body.slice(0, 3000)}`); sources.push(notePath); }
        } catch {}
      }
      for (const r of search(message, 5))
        if (!sources.includes(r.path)) { parts.push(`【関連ノート: ${r.path}】\n${r.clean.slice(0, 2000)}`); sources.push(r.path); }
      const prompt =
        'あなたはObsidianノートを使った学習をサポートするAIアシスタントです。\n' +
        '提供されたノートの内容を参考に、わかりやすく日本語で回答してください。\n' +
        'どのノートから得た情報かを明示し、ノートにない内容は一般知識で補足してください。\n' +
        '回答は構造化して、見出しや箇条書きを活用してください。\n\n' +
        `質問: ${message}\n\n参考ノート:\n${parts.slice(0, 5).join('\n\n')}`;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('APIエラー: ' + (data.error?.message || res.status));
      const answer = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      if (!answer) throw new Error('回答が空でした（安全フィルタ等の可能性）');
      return { answer, sources };
    },

    async rebuildWiki() {
      await buildIndex();                 // 最新のノートを反映してから生成
      const pages = await generateWiki();
      await scanList();                   // 新しい wiki ページを一覧に反映（本文の再読込はしない）
      return { pages };
    },

    async reload() { await buildIndex(); },
  };
})();
