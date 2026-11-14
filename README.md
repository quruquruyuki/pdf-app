# PDFノート

iPhone・iPadで使えるPDFアプリ（PWA）。ブラウザだけで動き、PDFは端末の中（IndexedDB）だけに保存します。サーバーには何も送りません。

## できること

- **閲覧**：連続スクロール、ピンチで拡大、ページ一覧、文書内検索（OCRの文字も対象）
- **注釈**：マーカー、ペン（Apple Pencil対応・「Pencilのみ」設定あり）、テキスト、四角・丸・矢印、消しゴム、選択して移動・拡大縮小・色変更、元に戻す／やり直す
- **文字を選んで**：ハイライト・下線・取り消し線・コピー
- **ページ編集**：並べ替え（長押しドラッグ）、回転、削除、複製、別のPDFや写真・白紙の挿入、選んだページを別PDFとして抽出
- **署名**：手書きサインを作って保存、ページに配置
- **OCR**：日本語＋英語。読み取った文字は選択・コピー・検索でき、書き出したPDFにも「見えない文字」として入る
- **スキャン**：カメラで撮った書類や写真をPDFにする
- **共有・保存**：注釈を含めたPDFを「ファイル」アプリやAirDropへ。注釈を確定して元のPDFを置き換えることも可能

## iPhone / iPad で使う

1. Safariで公開URLを開く
2. 共有ボタン →「ホーム画面に追加」
3. ホーム画面のアイコンから起動（オフラインでも動きます）

> ホーム画面に追加して使うと、保存したPDFが消されにくくなります。

## 構成

ビルド不要の静的サイトです。GitHub Pages でそのまま公開できます。

| ファイル | 役割 |
|---|---|
| `index.html` / `css/app.css` | 画面 |
| `js/app.js` | 全体の制御（ホーム・ビューア・メニュー・検索・共有） |
| `js/viewer.js` | PDFの表示（pdf.js）、ピンチ拡大、テキストレイヤー |
| `js/annot.js` | 注釈の描画と操作 |
| `js/pdfedit.js` | 書き出し・ページ編集（pdf-lib） |
| `js/organizer.js` | ページ整理画面 |
| `js/ocr.js` | OCR（Tesseract.js） |
| `js/sign.js` | サイン |
| `js/fontsubset.js` | 日本語フォントのサブセット化（HarfBuzz） |
| `js/db.js` | 端末内の保存（IndexedDB） |
| `sw.js` | オフライン用キャッシュ |
| `vendor/` | ライブラリ一式（pdf.js, pdf-lib, fontkit, Tesseract.js, HarfBuzz, Noto Sans JP） |

## ライセンス（同梱ライブラリ）

pdf.js (Apache-2.0) / pdf-lib (MIT) / @pdf-lib/fontkit (MIT) / Tesseract.js (Apache-2.0) / tessdata (Apache-2.0) / harfbuzzjs (MIT) / Noto Sans JP (SIL OFL 1.1)
