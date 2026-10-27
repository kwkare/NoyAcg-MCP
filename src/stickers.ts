/**
 * 表情包数据。
 *
 * 站点**没有**表情包 API：分组、代码、图片全在前端 bundle 里硬编码，
 * 服务端只存正文里的那串代码文本（如 `[noygirl:yeah]`），渲染时由前端替换成图片。
 * 所以这个表是「照抄前端」的静态数据，站点换表情包时需要同步更新。
 */
export interface Sticker {
  code: string;
  file: string;
}

export interface StickerGroup {
  name: string;
  label: string;
  stickers: Sticker[];
}

const NOYGIRL = [
  "happy",
  "wtf",
  "speechless",
  "call",
  "eat",
  "no",
  "watermelon",
  "yeah",
  "hum",
  "haha",
  "see",
  "what",
];

const SB = ["a", "eh", "what", "u", "ok", "haa", "good", "pu", "yes", "aa", "no"];

const numbered = (count: number) => Array.from({ length: count }, (_, i) => String(i + 1));

export const STICKER_GROUPS: StickerGroup[] = [
  {
    name: "noygirl",
    label: "Noy Girl",
    stickers: NOYGIRL.map((name, i) => ({ code: `[noygirl:${name}]`, file: `noy${i + 1}.webp` })),
  },
  {
    name: "sb",
    label: "SB",
    stickers: SB.map((name, i) => ({ code: `[sb:${name}]`, file: `sb${i + 1}.webp` })),
  },
  {
    name: "kmaru",
    label: "Kimeemaru",
    stickers: numbered(23).map((n) => ({ code: `[kmaru:${n}]`, file: `kmaru${n}.webp` })),
  },
  {
    name: "vik",
    label: "Vik",
    stickers: numbered(11).map((n) => ({ code: `[vik:${n}]`, file: `vik${n}.webp` })),
  },
];

export const ALL_STICKERS: Sticker[] = STICKER_GROUPS.flatMap((group) => group.stickers);

const EXACT = new Set(ALL_STICKERS.map((s) => s.code));

/** 渲染用的正则（前端同款，带 i 标记） */
const STICKER_PATTERN = /\[[a-z]+:[a-z0-9]+\]/gi;

export interface StickerAnalysis {
  /** 代码不存在于表里：会原样显示成文字 */
  unknown: string[];
  /** 只有大小写不同：会被前端匹配到但查不到表，整段**静默消失** */
  wrongCase: string[];
}

/**
 * 检查正文里的表情包代码。
 *
 * 注意两种失败方式不一样：拼错 → 显示成文字；大小写错 → 渲染成 null（什么都不显示）。
 */
export function analyzeStickers(text: string): StickerAnalysis {
  const unknown: string[] = [];
  const wrongCase: string[] = [];
  for (const raw of text.match(STICKER_PATTERN) ?? []) {
    if (EXACT.has(raw)) continue;
    const normalized = `[${raw.slice(1, -1).toLowerCase()}]`;
    if (EXACT.has(normalized)) wrongCase.push(raw);
    else unknown.push(raw);
  }
  return { unknown: [...new Set(unknown)], wrongCase: [...new Set(wrongCase)] };
}

/** 表情包图片的公开地址（无需鉴权，可直接给用户预览） */
export function stickerUrl(baseUrl: string, file: string): string {
  return `${baseUrl}/stickers/${file}`;
}
