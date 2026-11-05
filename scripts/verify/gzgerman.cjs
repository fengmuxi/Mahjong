/**
 * 赣州「精吊德国」判定回归（2026-11-05 收紧口径）
 *
 * 判据：德国 = 手上无精 / 精归位（精全按本张标准分解）。「精代牌」把精当万能牌补面子缺口，
 * 即使将牌是同面精对也只算精吊 +5，不给德国 +8，也不进德中德 ×4。
 * 见 docs/rules/ganzhou.md §6.4 / §6.5 / §6.6 与 packages/shared/src/gzwin.ts 的 usedWild。
 *
 * 用法：先 `npm run build:mg`，再 `node scripts/verify/gzgerman.cjs`
 * 校验的是小游戏端实际加载的 CJS 产物，不是 TS 源码。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '../..');
const OUT_MG = path.join(ROOT, 'packages/minigame/game/lib/shared');
const TMP = path.join(os.tmpdir(), `mj-gzgerman-${process.pid}`);

function prepare() {
  const b = path.join(OUT_MG, 'gzwin.js');
  if (!fs.existsSync(b)) throw new Error('缺少 lib/shared 产物，请先跑 build:mg');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) copy(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  copy(OUT_MG, TMP);
  fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"commonjs"}');
}

const { gzAnalyzeWin, gzWinLabel, gzIsDezhongde } = (() => {
  prepare();
  return { ...require(path.join(TMP, 'gzwin.js')) };
})();
const { tileName } = require(path.join(TMP, 'tiles.js'));

// 截图状态栏：正精 中/4条/9万/6万/9筒/7条 · 副精 发/5条/1万/7万/1筒/8条
const J = { zheng: [31, 12, 8, 5, 26, 15], fu: [32, 13, 0, 6, 18, 16] };
// 文档 §6.5 精代牌示例：明面正精 1筒(18) / 副精 2筒(19)
const J2 = { zheng: [18], fu: [19] };
const pung = (t) => ({ type: 'peng', tiles: [t, t, t], from: 0 });
const MELDS2 = [pung(27), pung(26)]; // 东东东 + 9筒9筒9筒

// game.ts:1576-1580 gzPatternScore 公式（天和/地和、杠开、德中德均为 0 时）
const score = (f) => {
  let s = f.patternBase;
  if (f.jingdiao) s += 5;
  if (f.german) s += 8;
  else if (f.hasJing && !f.jingdiao && f.shapes.some((x) => x !== 'pinghu')) s -= 5;
  return s;
};

const cases = [
  {
    name: '截图反例：发发将牌 + 中代3筒（精代牌）',
    hand: [9, 10, 11, 19, 21, 31, 32, 32], melds: MELDS2, jing: J, win: 31, via: 'zimo',
    want: { valid: true, jingdiao: true, german: false, points: 9, label: '精吊' },
  },
  {
    name: '正向：单吊精恰好摸上本张（中中将 + 面子全按本张）',
    hand: [9, 10, 11, 19, 20, 21, 31, 31], melds: MELDS2, jing: J, win: 31, via: 'zimo',
    want: { valid: true, jingdiao: true, german: true, points: 17, label: '精吊·德国' },
  },
  {
    name: '正向：同面精对作将 + 面子全按本张（自摸）',
    hand: [9, 10, 11, 19, 20, 21, 32, 32], melds: MELDS2, jing: J, win: 21, via: 'zimo',
    want: { valid: true, jingdiao: true, german: true, points: 17, label: '精吊·德国' },
  },
  {
    name: '文档 §6.5 精代牌例：2筒代7条补第二副七八九',
    hand: [15, 16, 16, 17, 17, 19, 19, 4], melds: MELDS2, jing: J2, win: 4, via: 'zimo',
    want: { valid: true, jingdiao: true, german: false, points: 9, label: '精吊' },
  },
  {
    name: '点炮：精按本张成对属德国路线（不给精吊 +5）',
    hand: [9, 10, 11, 19, 20, 21, 31, 31], melds: MELDS2, jing: J, win: 31, via: 'ron',
    want: { valid: true, jingdiao: false, german: true, points: 12, label: '德国' },
  },
  {
    name: '七对含同面精对（不走通配，德国仍成立）',
    hand: [31, 31, 0, 0, 1, 1, 9, 9, 18, 18, 19, 19, 20, 20], melds: [], jing: J, win: 20, via: 'zimo',
    want: { valid: true, jingdiao: true, german: true, points: 26, label: null },
  },
  {
    name: '精按本张作刻子 + 同面精对将牌（标准分解存在）',
    hand: [31, 31, 31, 31, 31, 9, 10, 11], melds: MELDS2, jing: J, win: 31, via: 'zimo',
    want: { valid: true, jingdiao: true, german: true, points: 17, label: '精吊·德国' },
  },
  {
    name: '无精平胡 → 德国（baseline 不受影响）',
    hand: [9, 10, 11, 19, 20, 21, 0, 0], melds: MELDS2, jing: J, win: 0, via: 'zimo',
    want: { valid: true, jingdiao: false, german: true, points: 12, label: '德国' },
  },
];

let pass = 0;
let fail = 0;
try {
  for (const c of cases) {
    const f = gzAnalyzeWin(c.hand, c.melds, c.jing, false, c.win, c.via);
    const label = gzWinLabel(f, false, null, false);
    const got = {
      valid: f.valid,
      jingdiao: f.jingdiao,
      german: f.german,
      points: score(f),
      label: c.name.startsWith('七对') ? null : label,
    };
    // 德国为假时，即使其余三家一张精都没有，德中德也必须关掉
    const dzd = gzIsDezhongde(f.german, [[], [], []], c.jing);
    const ok = JSON.stringify(got) === JSON.stringify(c.want) && (c.want.german || dzd === false);
    if (ok) pass++;
    else {
      fail++;
      console.log('FAIL', c.name, '\n  got ', JSON.stringify(got), ' dezhongde=', dzd, '\n  want', JSON.stringify(c.want));
    }
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(38)} 精吊=${f.jingdiao} 德国=${f.german} 底分=${f.patternBase} 牌型分=${got.points} 标签=${label ?? '平胡'}`);
  }
  console.log(`\n截图牌面：${cases[0].hand.map(tileName).join(' ')} + 副露 东×3 / 9筒×3`);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
