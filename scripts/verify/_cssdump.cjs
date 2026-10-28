const fs = require('fs');
const path = require('path');
const wxss = fs.readFileSync(path.resolve(__dirname, '../../packages/miniapp/miniprogram/pages/game/game.wxss'), 'utf8');
const want = ['.side-panel', '.panel-card', '.panel-body', '.chat-log', '.game-main', '.panel-head'];
for (const sel of want) {
  const re = new RegExp('\\' + sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}', 'g');
  let m, n = 0;
  while ((m = re.exec(wxss))) { n++; console.log('--- ' + sel + ' #' + n + ' ---\n' + m[1]); }
  if (!n) console.log('--- ' + sel + ': NOT FOUND ---');
}
