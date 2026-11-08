/**
 * 表情包数据。
 *
 * 站点**没有**表情包 API：分组、代码、图片全在前端 bundle 里硬编码，
 * 服务端只存正文里的那串代码文本（如 `[noygirl:yeah]`），渲染时由前端替换成图片。
 *
 * `meaning` 是人工看图整理的简短含义（2026-10-31 逐张过图核对），
 * 给模型当「选表情用的语义表」：按意思挑代码，不要凭空编。
 * 站点换表情包时需要同步更新本表。
 */
export interface Sticker {
  code: string;
  file: string;
  meaning: string;
}

export interface StickerGroup {
  name: string;
  label: string;
  /** 一句话说明这组表情的风格，帮模型快速判断用哪组 */
  style: string;
  stickers: Sticker[];
}

/** [代号, 含义] */
const NOYGIRL: [string, string][] = [
  ["happy", "开心吃糖，甜甜的笑"],
  ["wtf", "惊恐瞪眼，背后发凉/见鬼了"],
  ["speechless", "无语，头顶「…」黑脸"],
  ["call", "打电话，有事 call 我"],
  ["eat", "美滋滋吃东西"],
  ["no", "大哭拒绝，哇地哭了"],
  ["watermelon", "抱着西瓜，夏天吃瓜"],
  ["yeah", "Yeah~ 开心举手庆祝"],
  ["hum", "哼，傲娇不满"],
  ["haha", "哈哈，捂嘴笑"],
  ["see", "「盯——」扒墙角偷看/围观"],
  ["what", "!? 大震惊"],
];

const SB: [string, string][] = [
  ["a", "熊猫系猫猫：意味深长的微笑（懂得都懂）"],
  ["eh", "熊猫头：阴阳怪气的嘲讽脸"],
  ["what", "熊猫头：？？？问号打满"],
  ["u", "熊猫头：嚎啕大哭"],
  ["ok", "熊猫头：抱着西瓜认命无语"],
  ["haa", "火箭人起飞：离谱到升天"],
  ["good", "熊猫头：高举奖杯，第一名"],
  ["pu", "滑稽脸喷水：噗——吐了"],
  ["yes", "滑稽脸点赞：好的没问题"],
  ["aa", "双手揉揉：rua 头安慰"],
  ["no", "滑稽脸举封禁锤：不行，锤死"],
];

const KMARU: string[] = [
  "挠头困惑", // 1
  "歪头看你，面无表情", // 2
  "张开双臂冲过来（要抱抱）", // 3
  "歪头微笑", // 4
  "怼脸注视（大脸贴过来）", // 5
  "俯身趴下看", // 6
  "叉腰挺胸（得意）", // 7
  "奔跑冲向", // 8
  "呆呆抓头", // 9
  "倒立翻跟头", // 10
  "开心舞动", // 11
  "站着傻笑", // 12
  "裹成团子缩着", // 13
  "受伤包扎（伤痕累累）", // 14
  "!? 吃惊回头", // 15
  "挑眉坏笑", // 16
  "裹被子呼呼大睡", // 17
  "脸朝下趴倒（累瘫）", // 18
  "黑白忧郁（下雨的心情）", // 19
  "得意大笑（脸凑近）", // 20
  "平躺躺平", // 21
  "掀帘看窗外（白天来了）", // 22
  "深夜掀帘（还没睡）", // 23
];

const VIK: string[] = [
  "眨眼发射爱心", // 1
  "喷血（被撩到/炸裂）", // 2
  "拿着冰淇淋懵住：？？？", // 3
  "嚎啕大哭（!!#）", // 4
  "飞奔逃跑（帽子都飞了）", // 5
  "盖被睡觉 Zzz", // 6
  "蹲着钓鱼（潜水围观）", // 7
  "吃瓜看戏", // 8
  "炸毛抓狂（原地爆炸）", // 9
  "闪光敬礼：收到！", // 10
  "盯着屏幕无语（…）", // 11
];

const numbered = (count: number, meanings: string[], prefix: string) =>
  Array.from({ length: count }, (_, i) => [String(i + 1), meanings[i] ?? `${prefix} ${i + 1}`] as [string, string]);

export const STICKER_GROUPS: StickerGroup[] = [
  {
    name: "noygirl",
    label: "Noy Girl",
    style: "白发女主卡通表情：日常喜怒哀乐，最百搭",
    stickers: NOYGIRL.map(([name, meaning], i) => ({ code: `[noygirl:${name}]`, file: `noy${i + 1}.webp`, meaning })),
  },
  {
    name: "sb",
    label: "SB",
    style: "熊猫头/滑稽梗图：玩梗、吐槽、阴阳怪气",
    stickers: SB.map(([name, meaning], i) => ({ code: `[sb:${name}]`, file: `sb${i + 1}.webp`, meaning })),
  },
  {
    name: "kmaru",
    label: "Kimeemaru",
    style: "火柴人小角色：纯动作/状态，数字代号",
    stickers: numbered(23, KMARU, "kmaru").map(([n, meaning]) => ({ code: `[kmaru:${n}]`, file: `kmaru${n}.webp`, meaning })),
  },
  {
    name: "vik",
    label: "Vik",
    style: "粉发贝雷帽少女：可爱系情绪动作，数字代号",
    stickers: numbered(11, VIK, "vik").map(([n, meaning]) => ({ code: `[vik:${n}]`, file: `vik${n}.webp`, meaning })),
  },
];

export const ALL_STICKERS: Sticker[] = STICKER_GROUPS.flatMap((group) => group.stickers);

const EXACT = new Map(ALL_STICKERS.map((s) => [s.code, s]));

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

/** 按语义模糊挑表情：matchWords 命中含义/分组即返回代码（供模型参考，不强求用） */
export function suggestStickers(query: string, limit = 5): Sticker[] {
  const q = query.toLowerCase();
  const score = (sticker: Sticker): number => {
    const haystack = `${sticker.meaning} ${sticker.code}`.toLowerCase();
    let hits = 0;
    for (const term of q.split(/\s+/).filter(Boolean)) {
      if (haystack.includes(term)) hits += 1;
    }
    return hits;
  };
  return ALL_STICKERS.map((sticker) => ({ sticker, score: score(sticker) }))
    .filter(({ score: s }) => s > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ sticker }) => sticker);
}

/** 表情包图片的公开地址（无需鉴权，可直接给用户预览） */
export function stickerUrl(baseUrl: string, file: string): string {
  return `${baseUrl}/stickers/${file}`;
}
