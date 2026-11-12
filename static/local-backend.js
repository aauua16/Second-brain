/* Second Brain — ブラウザ単体バックエンド
 * index.html を file:// で直接開いたときに使われる。サーバー不要。
 * - Vault は File System Access API（Chrome / Edge）でフォルダ選択
 * - Vault 全体を文章チャンクに分割して BM25 インデックス化（日本語はバイグラム）
 * - 質問ごとに「全ノートの全チャンク」から関連箇所を検索し、Gemini に渡して回答させる（RAG）
 * - Gemini は REST API をブラウザから直接呼ぶ（キーは localStorage に保存）
 */
const LocalBackend = (() => {
  const DB_NAME = 'second_brain_idb', DB_STORE = 'handles';
  const LS_KEY = 'second_brain_gemini_key', LS_MODEL = 'second_brain_gemini_model';
  const DEFAULT_MODEL = 'gemini-2.0-flash-lite';
  const CTX_CHARS = 40000;      // 1回の質問で Gemini に渡す抜粋の最大文字数
  const CTX_CHUNKS = 30;        // 同上・最大チャンク数
  const PER_NOTE_CHUNKS = 3;    // 1ノートから採用する最大チャンク数

  let root = null;
  let list = [];                // [{path, name, folder, handle}]  ← 表示用（wiki含む）
  let docs = [];                // 検索対象ノート [{path, name, folder, clean, fmTags, links}]
  let chunks = [];              // 検索単位 [{d, head, text}]
  let postings = new Map();     // token -> [[chunkIdx, tf], ...]
  let chunkLen = [], avgdl = 1, idfCache = new Map();
  let linksTo = new Map();      // 小文字ノート名 -> [path]
  let progress = () => {};

  // ── 意味検索（Gemini 埋め込み）の状態 ──
  const EMB_DB = 'second_brain_emb', EMB_STORE = 'vec';
  const LS_EMB_MODEL = 'second_brain_embed_model', LS_SEM = 'second_brain_semantic';
  const EMB_DEFAULT_MODEL = 'gemini-embedding-001', EMB_DIM = 768, EMB_BATCH = 100, EMB_CHARS = 1200;
  let chunkHash = [];           // 区画ごとのキャッシュキー（内容 + モデル + 次元）
  let chunkVec = [];            // 区画ごとの正規化済みベクトル（未作成は null）
  let embBuilding = false, embCancel = false;
  const embModel = () => localStorage.getItem(LS_EMB_MODEL) || EMB_DEFAULT_MODEL;
  const semanticOn = () => localStorage.getItem(LS_SEM) !== '0';
  const embCovered = () => { let n = 0; for (const v of chunkVec) if (v) n++; return n; };
  const embedText = (name, head, text) => (name + (head ? ' / ' + head : '') + '\n' + text).slice(0, EMB_CHARS);
  function hash53(str, seed = 0) {            // cyrb53
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const embKey = text => `${embModel()}|${EMB_DIM}|${hash53(text)}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── IndexedDB（フォルダハンドルの保存） ──
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const idbGetRaw = async key => {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
      q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
    });
  };
  const idbGet = async key => { try { return await withTimeout(idbGetRaw(key), 2000); } catch { return null; } };
  const idbPut = async (key, val) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  };

  // ── テキスト処理 ──
  function tokenize(text) {
    const cs = Array.from(text.toLowerCase());
    const out = [];
    let i = 0;
    while (i < cs.length) {
      const c = cs[i];
      if (c.charCodeAt(0) < 128) {
        if (/[a-z0-9]/.test(c)) {
          let j = i;
          while (j < cs.length && cs[j].charCodeAt(0) < 128 && /[a-z0-9]/.test(cs[j])) j++;
          out.push(cs.slice(i, j).join(''));
          i = j;
        } else i++;
      } else {
        out.push(c);
        if (i + 1 < cs.length && cs[i + 1].charCodeAt(0) >= 128) out.push(c + cs[i + 1]);
        i++;
      }
    }
    return out;
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
      const v = m[1].trim();
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

  // 見出し・段落を尊重しつつ 600〜1500 文字程度のチャンクに分割
  function chunkText(clean) {
    const out = [];
    let head = '', buf = '';
    const flush = () => { const t = buf.trim(); if (t) out.push({ head, text: t }); buf = ''; };
    for (const line of clean.split('\n')) {
      const hm = line.match(/^#{1,6}\s+(.*)$/);
      if (hm) { if (buf.length >= 300) flush(); head = hm[1].trim(); buf += line + '\n'; continue; }
      if (buf.length + line.length > 1400 && buf.length >= 600) flush();
      buf += line + '\n';
      while (buf.length > 2400) { out.push({ head, text: buf.slice(0, 1600) }); buf = buf.slice(1600); }
    }
    flush();
    if (!out.length) out.push({ head: '', text: '' });
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
    docs = []; chunks = []; postings = new Map(); chunkLen = []; linksTo = new Map(); idfCache = new Map();
    chunkHash = []; chunkVec = [];
    const targets = list.filter(n => !n.path.startsWith('wiki/'));
    let done = 0;
    const slots = new Array(targets.length);

    async function readOne(idx) {
      const n = targets[idx];
      try {
        const raw = await (await n.handle.getFile()).text();
        const { fm, body } = splitFm(raw);
        const clean = body.trim();
        const cks = chunkText(clean.slice(0, 200000)).map(c => ({ ...c, tokens: tokenize(n.name + ' ' + c.head + ' ' + c.text) }));
        slots[idx] = { path: n.path, name: n.name, folder: n.folder, clean: clean.slice(0, 60000),
          fmTags: parseFmTags(fm), links: extractLinkTargets(clean), cks };
      } catch (e) { console.warn('skip', n.path, e); }
      if (++done % 25 === 0) progress(`インデックス作成中 ${done}/${targets.length}`);
    }
    let next = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (next < targets.length) await readOne(next++);
    }));

    for (const s of slots) {
      if (!s) continue;
      const d = docs.length;
      docs.push(s);
      for (const c of s.cks) {
        const ci = chunks.length;
        chunks.push({ d, head: c.head, text: c.text });
        chunkHash.push(embKey(embedText(s.name, c.head, c.text)));
        chunkLen.push(c.tokens.length);
        const tf = new Map();
        for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
        for (const [t, f] of tf) {
          let p = postings.get(t);
          if (!p) postings.set(t, p = []);
          p.push([ci, f]);
        }
      }
      for (const l of new Set(s.links)) {
        let a = linksTo.get(l);
        if (!a) linksTo.set(l, a = []);
        a.push(s.path);
      }
      s.cks = null;                             // メモリ節約
    }
    const N = chunks.length;
    avgdl = N ? chunkLen.reduce((a, b) => a + b, 0) / N : 1;
    // Okapi BM25 の idf（rank_bm25 と同じ定義）
    let sum = 0; const neg = [];
    for (const [t, p] of postings) {
      const idf = Math.log(N - p.length + 0.5) - Math.log(p.length + 0.5);
      idfCache.set(t, idf); sum += idf; if (idf < 0) neg.push(t);
    }
    const avgIdf = postings.size ? sum / postings.size : 0;
    for (const t of neg) idfCache.set(t, 0.25 * avgIdf);
    try { await loadVectors(); } catch (e) { console.warn('vector cache:', e); }
    progress(null);
  }

  // 全チャンクの BM25 スコア
  function scoreChunks(query) {
    const scores = new Float64Array(chunks.length);
    const k1 = 1.5, b = 0.75;
    for (const t of tokenize(query)) {
      const p = postings.get(t);
      if (!p) continue;
      const idf = idfCache.get(t);
      for (const [c, f] of p)
        scores[c] += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * chunkLen[c] / avgdl));
    }
    return scores;
  }

  // サイドバー検索：ノート単位（最良チャンクのスコア）
  function searchNotes(q, topK = 12) {
    if (!chunks.length) return [];
    const sc = scoreChunks(q);
    const best = new Map();
    for (let i = 0; i < sc.length; i++)
      if (sc[i] > 0 && (!best.has(chunks[i].d) || sc[i] > sc[best.get(chunks[i].d)])) best.set(chunks[i].d, i);
    return [...best.entries()].sort((a, b) => sc[b[1]] - sc[a[1]]).slice(0, topK).map(([d, ci]) => ({
      path: docs[d].path, name: docs[d].name, score: sc[ci],
      snippet: chunks[ci].text.split(/\s+/).join(' ').slice(0, 250),
    }));
  }

  const entry = path => list.find(n => n.path === path);
  async function readNote(path) {
    const e = entry(path);
    if (!e) return null;
    const raw = await (await e.handle.getFile()).text();
    return { e, body: splitFm(raw).body.trim() };
  }

  // ── Gemini ──
  async function gemini(prompt, extra = {}) {
    const { key, model } = LB.getSettings();
    if (!key) throw new Error('Gemini API キーが未設定です（サイドバーの ⚙️ から設定してください）');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('APIエラー: ' + (data.error?.message || res.status));
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) throw new Error('回答が空でした（安全フィルタ等の可能性）');
    return text;
  }

  // 質問から検索キーワードを補う（言い換え・関連語・英語表記）。失敗しても無視。
  async function expandQuery(message) {
    try {
      return await gemini(
        '次の質問に答えるため、個人ノートの全文検索に使うキーワードを日本語と英語で最大12個、' +
        'カンマ区切りの1行だけで出力してください（説明・記号・改行は不要）。\n質問: ' + message,
        { generationConfig: { maxOutputTokens: 120, temperature: 0.2 } });
    } catch { return ''; }
  }

  // 質問に関連するチャンクを Vault 全体から選ぶ
  async function retrieve(message, history, skipPath) {
    const queries = [[message, 1.0]];
    const lastUser = [...history].reverse().find(h => h.role === 'user');
    if (lastUser && message.length < 20) queries.push([lastUser.text, 0.6]);   // 「それは?」等の短い追質問
    const exp = await expandQuery(lastUser && message.length < 20 ? lastUser.text + ' ' + message : message);
    if (exp) queries.push([exp, 0.7]);

    const total = new Float64Array(chunks.length);
    for (const [q, w] of queries) {
      const sc = scoreChunks(q);
      let mx = 0;
      for (let i = 0; i < sc.length; i++) if (sc[i] > mx) mx = sc[i];
      if (mx > 0) for (let i = 0; i < sc.length; i++) total[i] += w * sc[i] / mx;
    }
    let order = Array.from(total.keys()).filter(i => total[i] > 0).sort((a, b) => total[b] - total[a]);
    let usedSemantic = false;
    if (semanticOn() && embCovered() > 0) {
      try {
        const qv = await embedQuery(lastUser && message.length < 20 ? lastUser.text + ' ' + message : message);
        const sims = [];
        for (let i = 0; i < chunks.length; i++) {
          const v = chunkVec[i];
          if (!v) continue;
          let sc = 0;
          for (let k = 0; k < v.length; k++) sc += v[k] * qv[k];
          sims.push([i, sc]);
        }
        sims.sort((a, b) => b[1] - a[1]);
        const fused = new Map();
        order.slice(0, 200).forEach((i, r) => fused.set(i, (fused.get(i) || 0) + 1 / (60 + r)));
        sims.slice(0, 100).forEach(([i], r) => fused.set(i, (fused.get(i) || 0) + 1 / (60 + r)));
        order = [...fused.keys()].sort((a, b) => fused.get(b) - fused.get(a));
        usedSemantic = true;
      } catch (e) { console.warn('semantic search failed (BM25 only):', e); }
    }
    const perNote = new Map(), picked = [];
    let chars = 0;
    for (const i of order) {
      const c = chunks[i], path = docs[c.d].path;
      if (path === skipPath) continue;
      if ((perNote.get(c.d) || 0) >= PER_NOTE_CHUNKS) continue;
      if (picked.length >= CTX_CHUNKS || chars + c.text.length > CTX_CHARS) continue;
      perNote.set(c.d, (perNote.get(c.d) || 0) + 1);
      picked.push(i); chars += c.text.length;
    }
    return { picked, expansion: exp, usedSemantic };
  }

  // ── 意味検索：埋め込みの作成・保存・読み込み ──
  const embDb = () => new Promise((res, rej) => {
    const r = indexedDB.open(EMB_DB, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(EMB_STORE);
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });

  async function loadVectors() {
    const db = await withTimeout(embDb(), 3000);
    const { keys, vals } = await new Promise((res, rej) => {
      const st = db.transaction(EMB_STORE).objectStore(EMB_STORE);
      const k = st.getAllKeys(), v = st.getAll();
      v.onsuccess = () => res({ keys: k.result, vals: v.result });
      v.onerror = () => rej(v.error);
    });
    const m = new Map();
    keys.forEach((k, i) => m.set(k, vals[i]));
    chunkVec = chunkHash.map(k => m.get(k) || null);
  }

  async function saveVectors(entries) {            // [[key, Float32Array], ...]
    const db = await embDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(EMB_STORE, 'readwrite');
      const st = tx.objectStore(EMB_STORE);
      for (const [k, v] of entries) st.put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }

  function normalize(values) {
    const v = Float32Array.from(values);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  async function embedCall(method, body, onWait) {
    const { key } = LB.getSettings();
    if (!key) throw new Error('Gemini API キーが未設定です（⚙️ から設定してください）');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(embModel())}:${method}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
      if (res.ok) return res.json();
      const data = await res.json().catch(() => ({}));
      if ((res.status === 429 || res.status >= 500) && attempt < 10) {       // 利用制限・一時エラーは待って再試行
        const wait = Math.min(60, 4 * 2 ** attempt);
        for (let s = wait; s > 0; s--) {
          if (embCancel) throw new Error('中断しました');
          if (onWait) onWait(s, res.status);
          await sleep(1000);
        }
        continue;
      }
      throw new Error('埋め込みAPIエラー: ' + (data.error?.message || res.status));
    }
  }

  async function embedQuery(text) {
    const model = 'models/' + embModel();
    const d = await embedCall('embedContent', { model, content: { parts: [{ text: text.slice(0, EMB_CHARS) }] },
      taskType: 'RETRIEVAL_QUERY', outputDimensionality: EMB_DIM });
    return normalize(d.embedding.values);
  }

  async function buildEmbeddings(onProgress) {
    if (embBuilding) throw new Error('すでに作成中です');
    embBuilding = true; embCancel = false;
    try {
      const model = 'models/' + embModel();
      const missing = [];
      chunkVec.forEach((v, i) => { if (!v) missing.push(i); });
      let done = 0;
      for (let b = 0; b < missing.length; b += EMB_BATCH) {
        if (embCancel) break;
        const idxs = missing.slice(b, b + EMB_BATCH);
        const requests = idxs.map(i => ({ model, content: { parts: [{ text: embedText(docs[chunks[i].d].name, chunks[i].head, chunks[i].text) }] },
          taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: EMB_DIM }));
        const d = await embedCall('batchEmbedContents', { requests },
          (s, code) => onProgress && onProgress({ done, total: missing.length, waiting: s, code }));
        const entries = idxs.map((i, k) => { const v = normalize(d.embeddings[k].values); chunkVec[i] = v; return [chunkHash[i], v]; });
        await saveVectors(entries);                      // 1バッチごとに保存＝中断しても続きから再開できる
        done += idxs.length;
        if (onProgress) onProgress({ done, total: missing.length });
      }
      return { done, total: missing.length, cancelled: embCancel };
    } finally { embBuilding = false; }
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

    const L = head('# 📚 Wiki インデックス', `> 自動生成 — ${T}　|　総ノート数: **${notes.length} 件**`);
    L.push('## 📁 フォルダ一覧', '');
    for (const f of sortKeys(folMap)) L.push(`- [[フォルダ/${safe(f)}|${f !== '(root)' ? f : '（ルート）'}]] — ${folMap.get(f).length} 件`);
    L.push('', '---', '', '## 🏷️ タグ一覧', '');
    for (const [t, ns] of [...tagMap].sort((a, b) => b[1].length - a[1].length))
      L.push(ns.length >= 2 ? `- [[タグ/${safe(t)}|#${t}]] — ${ns.length} 件` : `- #${t} — ${ns.length} 件`);
    L.push('', '---', '', '## 🕐 最近のノート', '');
    for (const n of notes.slice(-30).reverse()) L.push(`- [[${n.path}|${n.name}]]${n.folder ? `  \`${n.folder}\`` : ''}`);
    await writeFile(wikiDir, 'インデックス.md', L.join('\n')); count++;

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
  const LB = {
    mode: 'local',
    onProgress(fn) { progress = fn || (() => {}); },
    vaultName: () => (root ? root.name : ''),
    stats: () => ({ notes: docs.length, chunks: chunks.length, embedded: embCovered(), semantic: semanticOn() }),
    embStatus() {
      let missing = 0, chars = 0;
      chunkVec.forEach((v, i) => { if (!v) { missing++; chars += embedText(docs[chunks[i].d].name, chunks[i].head, chunks[i].text).length; } });
      return { total: chunks.length, covered: chunks.length - missing, missing, chars, on: semanticOn(), building: embBuilding, model: embModel() };
    },
    setSemantic(on) { localStorage.setItem(LS_SEM, on ? '1' : '0'); },
    buildEmbeddings,
    cancelEmbeddings() { embCancel = true; },
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

    async search(q) { return searchNotes(q, 12); },

    // history: [{role:'user'|'ai', text}]、opts.preferOpen: 開いているノートを全文で優先して渡すか
    async chat(message, notePath, history = [], opts = {}) {
      const parts = [], sources = [];
      let openPath = null;
      if (notePath && opts.preferOpen !== false) {
        try {
          const r = await readNote(notePath);
          if (r) { parts.push(`【現在開いているノート: ${notePath}】\n${r.body.slice(0, 6000)}`); sources.push(notePath); openPath = notePath; }
        } catch {}
      }
      const { picked, usedSemantic } = await retrieve(message, history, openPath);
      const byNote = new Map();
      for (const ci of picked) {
        const c = chunks[ci];
        (byNote.get(c.d) || byNote.set(c.d, []).get(c.d)).push(c);
      }
      for (const [d, cs] of byNote) {
        parts.push(`【ノート: ${docs[d].path}】\n` + cs.map(c => (c.head ? `(${c.head}) ` : '') + c.text).join('\n…\n'));
        sources.push(docs[d].path);
      }
      const hist = history.slice(-6).map(h => `${h.role === 'user' ? 'ユーザー' : 'AI'}: ${h.text.slice(0, 600)}`).join('\n');
      const prompt =
        'あなたは、ユーザーの Obsidian Vault（個人ノート集）を読み込んで対話するAIアシスタントです。\n' +
        '以下は、質問に関連するとして Vault 全体の検索で抽出したノートの抜粋です。\n' +
        '- 抜粋を根拠に、日本語でわかりやすく回答してください。\n' +
        '- 根拠にしたノートを【ノート名】の形で明示してください。\n' +
        '- 複数のノートにまたがる関連・対立・変遷があれば、統合して整理してください。\n' +
        '- 抜粋に根拠がない場合は、その旨を述べたうえで一般知識で補足し、ノート由来の内容と区別してください。\n' +
        '- 見出しや箇条書きで構造化してください。\n\n' +
        (hist ? `これまでの会話:\n${hist}\n\n` : '') +
        `質問: ${message}\n\n参考ノート（抜粋）:\n${parts.join('\n\n') || '（該当するノートは見つかりませんでした）'}`;
      const answer = await gemini(prompt);
      return { answer, sources, stats: { total: docs.length, used: sources.length, semantic: usedSemantic } };
    },

    async rebuildWiki() {
      await buildIndex();                 // 最新のノートを反映してから生成
      const pages = await generateWiki();
      await scanList();                   // 新しい wiki ページを一覧に反映（本文の再読込はしない）
      return { pages };
    },

    async reload() { await buildIndex(); },
  };
  return LB;
})();
