'use strict';
// 정적 점검 — 브라우저 없이 빠르게 걸러낼 수 있는 문제(구문 오류, 깨진 JSON 등).
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./serve');

const failures = [];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// 1) 앱 본문의 인라인 스크립트가 구문 오류 없이 해석되는가
const html = read('case_management_on.html');
const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) failures.push('case_management_on.html: 인라인 <script>를 찾지 못했습니다.');
else { try { new Function(m[1]); } catch (e) { failures.push('case_management_on.html 스크립트 구문 오류: ' + e.message); } }

// 2) 서비스 워커가 구문 오류 없이 해석되는가
try { new Function(read('sw.js')); } catch (e) { failures.push('sw.js 구문 오류: ' + e.message); }

// 3) manifest.json이 올바른 JSON이고 시작 주소가 실제 파일을 가리키는가
try {
  const manifest = JSON.parse(read('manifest.json'));
  const start = (manifest.start_url || '').replace(/^\.\//, '');
  if (!fs.existsSync(path.join(ROOT, start))) failures.push('manifest.json의 start_url 파일이 없습니다: ' + manifest.start_url);
} catch (e) { failures.push('manifest.json 오류: ' + e.message); }

// 4) 서비스 워커가 미리 저장하는 파일이 모두 존재하는가
const shell = (read('sw.js').match(/APP_SHELL\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
(shell.match(/'\.\/[^']+'/g) || []).forEach(q => {
  const rel = q.replace(/['"]|^\.\//g, '');
  if (!fs.existsSync(path.join(ROOT, rel))) failures.push('sw.js가 저장하려는 파일이 없습니다: ' + rel);
});

if (failures.length){
  console.error('정적 점검 실패:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('정적 점검 통과 (스크립트·서비스 워커·manifest)');
