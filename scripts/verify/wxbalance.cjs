// WXML 标签配平检查：对 game.wxml 逐标签统计开合
const fs = require('fs');
const p = 'packages/miniapp/miniprogram/pages/game/game.wxml';
const src = fs.readFileSync(p, 'utf8');

// 去掉注释
const noComment = src.replace(/<!--[\s\S]*?-->/g, '');

const VOID = new Set(); // 小程序没有 void 标签，input/button/image 都要闭合
const stack = [];
const counts = {};
let bad = [];

// 逐字符扫，处理属性值里可能出现的 >
const tagRe = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
let m;
while ((m = tagRe.exec(noComment))) {
  const whole = m[0];
  const name = m[1];
  if (whole.startsWith('</')) {
    const top = stack.pop();
    if (top !== name) {
      bad.push(`闭合错配：</${name}> 但栈顶是 <${top}>`);
    }
    continue;
  }
  // 自闭合？
  const attrs = m[2] || '';
  const selfClose = /\/\s*$/.test(attrs);
  counts[name] = (counts[name] || 0) + 1;
  if (!selfClose) stack.push(name);
}

if (stack.length) bad.push(`未闭合：${stack.join(', ')}`);

const show = ['view', 'text', 'scroll-view', 'button', 'image', 'input', 'canvas', 'block'];
for (const k of show) {
  if (counts[k]) console.log(`  ${k}: ${counts[k]}`);
}
console.log(`view=${counts.view} scroll-view=${counts['scroll-view']} text=${counts.text} button=${counts.button}`);
if (bad.length) {
  console.error('❌ WXML 配平失败：');
  for (const b of bad) console.error('   ' + b);
  process.exit(1);
}
console.log('✅ WXML 配平通过');
