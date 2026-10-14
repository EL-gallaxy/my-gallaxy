# 사례관리 ON (my-gallaxy)

정신건강 사례관리 실무자 한 사람이 자기 PC에서 쓰는 업무 보조 웹앱입니다.
서버·외부 API·CDN이 없는 **단일 HTML 파일**(`case_management_on.html`)이고, 모든 기록은 쓰는 브라우저의 IndexedDB에
암호화되어 저장됩니다. `main`에 병합하면 GitHub Pages로 바로 배포됩니다.

- 사용법: 앱의 설정 → "새 기능과 사용법"(`Views.TOUR_SECTIONS`, 업데이트 내역은 `Views.CHANGELOG`)
- 이 문서: 코드를 이어서 고치는 사람을 위한 안내

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `case_management_on.html` | 앱 전체(스타일, 마크업, 스크립트). 약 1만 줄 |
| `sw.js` | 오프라인용 서비스 워커(캐시 우선, 새 버전이 있으면 화면에 "새로고침" 안내) |
| `manifest.json`, `icon.svg` | 설치(PWA)용 |
| `recovery_toolbox.html` | 회복 도구함: 회복 사다리(종이 카드 인쇄)와 위기 대화 가이드. 저장·전송 없는 독립 파일 |
| `resource_map.html` | 원주 자원 지도: 이동·부담도·사다리 단계로 찾는 자원 목록(이 브라우저의 localStorage에 저장하고, 비공개 GitHub 저장소의 `resources.json`(또는 동기화 폴더의 파일)을 연결하면 컴퓨터 사이에 맞춤) |
| `index.html` | 도구 모음 첫 화면(회복 도구함·자원 지도·사례관리 ON 링크) |
| `first.html` | 이 앱과 무관한 별도 예제 페이지(예산 산출 계산기) |
| `tests/static.js` | 스크립트·서비스 워커 구문, manifest 점검 |
| `tests/smoke.js` | 실제 크롬으로 앱을 열어 전 흐름을 점검(Playwright + axe-core) |
| `tests/run.js`, `tests/serve.js` | 점검 실행기, 로컬 정적 서버 |
| `.github/workflows/check.yml` | PR과 `main` 푸시마다 `npm test` 실행 |

## 앱 스크립트 구조

한 파일 안에 전역 객체로 나뉘어 있습니다(위에서 아래로 읽으면 의존 순서와 대체로 같습니다).

- 바탕: `Utils`(날짜·문자열), `CryptoModule`(AES-GCM, PBKDF2), `Storage`(IndexedDB), `State`(메모리 상태), `CONSTANTS`
- 인증: `Auth`(비밀번호, 마스터 키, 복구 코드, 잠금)
- 설정류: `Theme`, `OrgInfo`, `FontSize`, `DashboardPrefs`, `Thresholds`(점검 기준 일수), `Retention`(보관기간), `FeatureVisibility`(화면 구성), `SimpleMode`
- 도메인: `Clients`(대상자와 그 하위 기록 전부), `SoapModule`, `FollowUps`, `Schedules`, `ResourceDirectory`, `SelfCare`(자기돌봄·교육·슈퍼비전), `Debriefings`
- 도구: `Search`, `Stats`(월·연·주 집계, 성과, 월말 점검), `CSV`, `Health`(데이터 건강검진), `Backup`, `AutoBackup`, `Notifications`
- 화면: `UI`(라우터 `renderCurrentView`, 모달, 빠른 이동), `Views`(화면마다 HTML 문자열을 돌려주는 함수와 `bind*` 함수 쌍)

화면을 그리는 방식은 단순합니다. `Views.xxx()`가 HTML 문자열을 돌려주고 `renderCurrentView`가 `#appMain`에 넣은 뒤
`Views.bindXxx()`가 이벤트를 붙입니다. 상태가 바뀌면 `UI.renderCurrentView()`로 통째로 다시 그립니다.
화면 그리기 중 오류가 나면 안내와 "오류 내용 복사" 버튼이 나옵니다(`UI.showRenderError`).

## 저장과 보안 모델

- 기록은 무작위 32바이트 **마스터 키**로 AES-GCM 암호화되어 `{ id, iv, cipher }`로 저장됩니다.
  마스터 키는 비밀번호(PBKDF2)와 복구 코드로 각각 감싸 `settings`에 둡니다(`masterWrap`, `recoveryWrap`).
  비밀번호를 바꿔도 기록은 다시 암호화하지 않습니다.
- 설정 저장소(`settings`)에는 개인정보가 아닌 값(기준 일수, 화면 구성, 인증 메타데이터)만 둡니다.
  개인정보가 섞일 수 있는 것은 반드시 `Storage.saveEncrypted`로 저장하세요.
- 저장소: `clients`, `soaps`, `followUps`, `schedules`, `resourceDirectory`, `selfCareNotes`, `debriefings`, `settings`.
- 백업 파일은 암호화된 행을 그대로 담은 JSON입니다(`Backup.exportAll`). 백업에 들어가는 설정 키는 `Backup.SETTINGS_KEYS`입니다.
- 자동 백업(`AutoBackup`)은 크롬의 폴더 접근 기능을 씁니다. 폴더 핸들은 기기에만 저장하고 백업 파일에는 넣지 않습니다.

### 저장소를 새로 추가하거나 구조를 바꿀 때 (중요)

새 IndexedDB 저장소를 추가하면 아래를 **모두** 고쳐야 합니다. 하나라도 빠지면 백업·복원·암호화 갱신에서 조용히 빠집니다.

1. `Storage.DB_VERSION`을 올리고 `onupgradeneeded`의 저장소 이름 목록에 추가
2. `State`에 Map 추가, 비울 때(`State.clear()`, 로그아웃)와 불러올 때(`loadAllDataIntoState`)
3. `Backup.DATA_STORES`, `exportAll`, `importFromFile`(비우는 목록과 넣는 줄)
4. 모든 기록을 다시 암호화하는 곳(비밀번호 체계를 바꾸는 흐름)
5. 대상자를 삭제할 때 함께 지울 기록이면 `Clients.remove`
6. `tests/smoke.js`의 백업 점검(건수와 평문 누출)

저장 구조(`DB_VERSION`)가 바뀌는 배포는 사용자가 업데이트 전에 백업을 받도록 `Storage.confirmUpgradeBackup`이 안내합니다.
이 흐름은 예전 버전 저장소를 직접 만들어 `tests/smoke.js`에서 점검합니다.

## 자동 점검

앱이 `main`에 병합되면 곧바로 배포되므로, 병합 전에 `npm test`(= `tests/run.js`)가 통과해야 합니다.
GitHub 저장소 설정(Settings → Branches)에서 `main`에 "Require status checks to pass: check"를 켜 두면
점검을 통과하지 못한 변경은 병합할 수 없습니다.

로컬 실행: `npm install` 후 `npm test`(Playwright 크롬 필요, 약 1~2분).

점검 내용(`tests/smoke.js`는 한 브라우저에서 순서대로 진행하므로 앞 단계의 데이터를 뒤 단계가 씁니다):

- 비밀번호 설정, 기록 저장, 새로고침 후 재로그인, 주요 흐름(위기·가족·연계·계획·종결 등)
- 모든 화면·대상자 상세 7개 탭·목록 필터·작성 화면·인쇄 화면을 **기록이 가득 찬 상태로** 그려 오류 안내가 뜨지 않는지
- 백업 파일 내용과 평문 누출, 가벼운 백업, 비밀번호 변경·복구 코드·예전 사용자 이전
- 자동 백업(가짜 폴더), 백업 파일 검증, 업데이트 전 백업 안내
- 인쇄: 메뉴·버튼이 빠지는지, 한 장 문서(연말 요약, 주간 요약, 연계 의뢰서 등)가 정해진 쪽수에 들어가는지(실제 PDF 생성)
- 접근성 심각 위반(라이트·다크, axe-core)
- 앱이 기록하는 오류(`[앱 오류]` 콘솔 출력)는 모든 단계에서 실패로 처리

### 점검 도구를 다룰 때 겪었던 함정

- 점검 중 `page.emulateMedia({ media: 'screen' })`로 고정하면 이후 `page.pdf()`도 화면 모양으로 나와 인쇄 점검이 틀립니다.
  되돌릴 때는 `{ media: null }`을 쓰세요.
- 점검 데이터는 오늘 날짜에 따라 달라지는 값(이번 주, 다음 주 등)이 있습니다. 특정 날짜·건수에 기대는 단언은 날짜가 바뀌면 깨집니다.
- 코드를 문자열로 치환해 고칠 때는 치환 대상이 **한 곳만** 맞는지 확인하세요. 비슷한 코드(예: 목록 끝의 `</tbody></table>`)가
  여러 화면에 있어 엉뚱한 화면이 바뀐 적이 있습니다. 새 점검을 넣었으면 일부러 망가뜨려 실패하는지도 확인하세요.

## 화면·기능을 추가할 때 체크리스트

- 새 화면: `UI.renderCurrentView`의 `case`, 필요하면 `NAV_SECONDARY_VIEWS`, `MOBILE_MORE_ITEMS`, `UI.QUICK_VIEWS`(빠른 이동),
  인쇄 화면이면 인쇄에서 숨길 요소 id를 `@media print` 목록에 추가, `tests/smoke.js`의 전체 화면 점검 목록에 추가
- 긴 목록: `Views.rowLimit`/`moreRowsHtml`/`bindMoreRows`로 처음 100건만 그리기
- 날짜 입력: `Utils.dateWarning`으로 오타로 보이는 날짜를 되묻기
- 편집 화면: `Views.trackDirty`로 저장 안 한 입력 이탈 경고, 저장·삭제 뒤 `Views._dirty = false`
- 사용자에게 보이는 변경: 설정 → "새 기능과 사용법"의 `Views.TOUR_SECTIONS`와 `Views.CHANGELOG` 갱신
- 없앤 기능은 코드뿐 아니라 안내 문구, 테스트, 백업 설정 키에서도 지웠는지 확인

## 비밀번호 복구 코드

처음 설정할 때 복구 코드가 한 번 표시되며(설정 → 비밀번호 복구 코드에서 다시 만들 수 있음), 비밀번호를 잊으면
로그인 화면의 "복구 코드로 열기"로 새 비밀번호를 정할 수 있습니다. 이 기능이 생기기 전부터 쓰던 데이터는 복구 코드를 만들 때
같은 키를 그대로 옮겨 오므로 기록은 건드리지 않습니다(`tests/smoke.js`에서 확인).

## 알려진 한계

- 한 대의 PC·브라우저용입니다. 기기 간 동기화나 여러 사람 동시 사용은 없습니다.
- 브라우저 데이터를 지우면 기록이 사라집니다. 자동 백업이나 정기 백업이 유일한 안전장치입니다.
- 자동 백업의 폴더 지정 창은 자동화 점검으로 열 수 없어, 실제 폴더에 쓰는 부분은 가짜 폴더로만 점검했습니다.
- 서비스 워커는 캐시 우선이라, 새 버전은 한 번 더 열거나 안내가 뜬 뒤 새로고침해야 적용됩니다.
