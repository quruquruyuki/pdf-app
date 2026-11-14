// 文字編集・テキスト注釈で使うフォント
export const FONTS = {
  'sans':       { label: 'ゴシック',     file: 'NotoSansJP-Regular.ttf',  css: '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif', weight: 400 },
  'sans-bold':  { label: 'ゴシック 太字', file: 'NotoSansJP-Bold.ttf',     css: '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",sans-serif', weight: 700 },
  'serif':      { label: '明朝',         file: 'NotoSerifJP-Regular.ttf', css: '"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif', weight: 400 },
  'serif-bold': { label: '明朝 太字',    file: 'NotoSerifJP-Bold.ttf',    css: '"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif', weight: 700 },
};
export const fontOf = (key) => FONTS[key] || FONTS.sans;

// PDFのフォント名などから、近いフォントを選ぶ
export function guessFont({ name = '', family = '', bold = false, black = false }) {
  const n = name.replace(/^[A-Z]{6}\+/, '');
  let serif = null;
  if (/mincho|ming|serif|song|times|century|明朝|georgia|garamond|ryumin|kozmin|ipam|hgs?m/i.test(n)) serif = true;
  else if (/gothic|goth|sans|arial|helvetica|meiryo|ゴシック|kozgo|midashi|shingo|ipag|hgs?g|verdana|calibri|segoe|noto ?sans|hiragino ?(kaku|sans)/i.test(n)) serif = false;
  if (serif === null) serif = family === 'serif';
  const isBold = bold || black || /bold|black|heavy|demi|semibold|w[6-9]\b|-w[6-9]|太/i.test(n);
  return (serif ? 'serif' : 'sans') + (isBold ? '-bold' : '');
}
