'use strict';
// npm test — 정적 점검 → 브라우저 점검 순서로 실행한다. 하나라도 실패하면 종료 코드가 0이 아니다.
const { spawnSync } = require('child_process');
const path = require('path');

for (const file of ['static.js', 'smoke.js']){
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log('\n모든 점검 통과');
