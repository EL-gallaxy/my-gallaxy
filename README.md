# my-gallaxy

## 자동 점검

앱은 단일 HTML 파일(`case_management_on.html`)이며, `main`에 병합되면 GitHub Pages로 바로 배포됩니다.
그래서 병합 전에 아래 점검이 자동으로 실행됩니다(`.github/workflows/check.yml`).

- 정적 점검: 앱 스크립트·서비스 워커의 구문 오류, `manifest.json` 유효성
- 브라우저 점검: 실제 크롬으로 앱을 열어 비밀번호 설정, 기록 저장, 재로그인 후 데이터 유지, 주요 화면·대화상자 표시,
  백업 파일 내용, 접근성 심각 위반(라이트·다크)을 확인

로컬에서 실행하려면 `npm install` 후 `npm test`를 실행하세요(Playwright 크롬 필요).
GitHub 저장소 설정(Settings → Branches)에서 `main`에 "Require status checks to pass: check"를 켜 두면
점검을 통과하지 못한 변경은 병합할 수 없습니다.
