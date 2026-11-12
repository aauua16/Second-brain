<div align="center">

# 🧠 Second Brain

**Obsidian の Vault を丸ごと読み込んだ AI と対話する、ローカルアプリ。**

[![HTML](https://img.shields.io/badge/HTML-single%20file-E34F26?logo=html5&logoColor=white)](static/index.html)
[![Gemini](https://img.shields.io/badge/Gemini-API-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

<p align="center"><img src="docs/screenshot.png" width="800" alt="Second Brain"></p>

画面の主役は **Vault と対話するチャット**です。質問するたびに **Vault 内のすべてのノート**から関連箇所を探し出し、根拠にしたノートを明示して回答します。ノートの閲覧は、必要なときだけ右側に開きます。

## ✨ Features

- 💬 **Vault 全体と対話** — 全ノートを文章チャンク(見出し・段落単位)に分割して索引化。質問ごとに全チャンクを検索し、関連の高い最大30区画(約4万字)を Gemini に渡して回答
- 🔎 **キーワード拡張** — 質問を言い換え・関連語・英語表記に展開して検索し、取りこぼしを減らす
- 🧵 **会話の文脈を保持** — 「それは?」のような追質問も、直前のやり取りを踏まえて検索・回答
- 📎 **根拠の明示** — 回答の下に参照ノートをチップ表示。クリックで右側にノートを開く
- 🔗 バックリンク / 日本語対応の全文検索 / Wiki 自動生成(🔄)
- 🔒 サーバー不要。ノートはこのPC内で処理され、質問時に該当の抜粋だけが Gemini API に送られる

> 「全ノートを精査」の意味: AI が毎回すべてのノートを読むのではなく、**全ノートを対象に検索して関連箇所を選び出し**、それを読ませる方式(RAG)です。2000 ノート規模でも数秒で索引化できます。

## 🚀 使い方

### A. アプリとして使う(Windows・おすすめ)

1. [`scripts/install-app.bat`](scripts/install-app.bat) をダブルクリック
2. デスクトップとスタートメニューに **Second Brain** ができます(専用ウィンドウで起動)
3. 初回のみ **📂 Vault フォルダを選択**(2回目以降は「再接続」)
4. **⚙️** に [Gemini API キー](https://aistudio.google.com/apikey)を入力(このアプリ専用のプロファイルにのみ保存)

Chrome または Edge が必要です。

### B. HTML を直接開く

[`static/index.html`](static/index.html)(と同じフォルダの `local-backend.js`)を Chrome / Edge で開いても動きます。

## 🗂️ Structure

```
second-brain/
├── static/
│   ├── index.html          # UI(チャット中心)
│   └── local-backend.js    # 索引・検索・Wiki 生成・Gemini 呼び出し
├── assets/                 # アイコン
├── scripts/                # アプリ化(ショートカット作成)
├── main.py / search.py ... # 旧サーバー版(FastAPI)。任意
└── LICENSE
```

## 🔐 Security notes

- API キーは各自のブラウザ(アプリ専用プロファイル)にのみ保存され、ファイルやリポジトリには含まれません。
- AI 質問時、検索で選ばれたノートの抜粋が Gemini API に送信されます。機密ノートを含む Vault では注意してください。
- 認証はありません。ローカル利用が前提です。

<details>
<summary>旧サーバー版(Python / FastAPI)</summary>

`pip install -r requirements.txt` → `.env.example` を `.env` にコピーして `VAULT_PATH` と `GEMINI_API_KEY` を設定 → `start.bat`(`http://localhost:8000`)。単体版にある全ノート横断の強化・会話履歴は、サーバー版には入っていません。
</details>

## 📄 License

[MIT](LICENSE)
