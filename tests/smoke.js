'use strict';
// 브라우저 점검 — 실제 크롬으로 앱을 열어 핵심 흐름이 동작하는지, 화면이 오류 없이 그려지는지,
// 접근성 심각 위반이 없는지 확인한다. 데이터는 매번 새 브라우저에 만들고 끝나면 버린다.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start, ROOT } = require('./serve');

const PASSWORD = 'ci-test-pass-1';
let recoveryCode = '';
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const failures = [];
let stepNo = 0;
async function step(name, fn){
  stepNo++;
  const t = Date.now();
  try{
    await fn();
    console.log('  ✓ ' + name + ' (' + ((Date.now() - t) / 1000).toFixed(1) + 's)');
  }catch(e){
    failures.push(name + ' — ' + (e && e.message ? e.message.split('\n')[0] : e));
    console.error('  ✗ ' + name + '\n      ' + (e && e.message ? e.message.split('\n').slice(0, 3).join('\n      ') : e));
  }
}
function assert(cond, msg){ if (!cond) throw new Error(msg); }

(async () => {
  const { server, url } = await start();
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const noNewErrors = (label) => { assert(pageErrors.length === 0, label + ' 중 화면 오류: ' + pageErrors.splice(0).join(' | ')); };

  const app = url + '/case_management_on.html';
  const show = () => page.evaluate(() => {
    document.querySelectorAll('.detail-tab-group').forEach(g => g.classList.add('active'));
    document.querySelectorAll('details').forEach(d => { d.open = true; });
  });
  const click = async (sel) => { await page.evaluate((s) => document.querySelector(s).click(), sel); await page.waitForTimeout(200); };
  const axeCheck = async (label) => {
    await page.addScriptTag({ content: axeSource });
    const bad = await page.evaluate(async () => {
      const res = await axe.run(document, { resultTypes: ['violations'] });
      return res.violations.filter(v => v.impact === 'critical' || v.impact === 'serious').map(v => v.id + ' x' + v.nodes.length + ' | ' + v.nodes[0].html.replace(/\s+/g, ' ').slice(0, 90));
    });
    assert(bad.length === 0, label + ' 접근성 위반: ' + bad.join(' ; '));
  };

  console.log('사례관리 ON 브라우저 점검');

  await step('앱이 열리고 비밀번호를 설정해 대시보드에 들어간다', async () => {
    await page.goto(app);
    await page.waitForSelector('#ackNoticeCheckbox', { state: 'visible' });
    await page.check('#ackNoticeCheckbox');
    await page.click('text=다음');
    await page.fill('#setupPw1', PASSWORD);
    await page.fill('#setupPw2', PASSWORD);
    await page.click('#setupSubmitBtn');
    await page.waitForSelector('#appShell:not(.hidden)');
    // 처음 설정하면 복구 코드가 한 번 표시되고, 보관했다고 확인하기 전에는 닫히지 않는다.
    await page.waitForSelector('#recoveryCodeText');
    recoveryCode = (await page.textContent('#recoveryCodeText')).trim();
    assert(/^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/.test(recoveryCode), '복구 코드 형식이 다름: ' + recoveryCode);
    await page.keyboard.press('Escape');
    assert(await page.isVisible('#recoveryCodeText'), '복구 코드 창이 Esc로 닫힘(보관 확인 전에는 닫히면 안 됨)');
    assert(await page.isDisabled('#recoveryDone'), '보관 확인 전에 확인 버튼이 눌릴 수 있음');
    await page.check('#recoveryAck');
    await page.click('#recoveryDone');
    await page.waitForFunction(() => document.getElementById('modalOverlay').classList.contains('hidden'));
    await page.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    noNewErrors('첫 실행');
  });

  await step('대상자·SOAP·후속조치·일정을 저장하고 최종 SOAP 수정 이력을 남긴다', async () => {
    const r = await page.evaluate(async () => {
      const level = Object.keys(CONSTANTS.MANAGEMENT_LEVELS)[0];
      await Clients.add({ id: 'CI1', alias: '점검1', managementLevel: level });
      await Clients.add({ id: 'CI2', alias: '점검2', managementLevel: level });
      const s = SoapModule.createBlank({ clientId: 'CI1' });
      s.S = '원본 S'; s.A = '원본 A'; s.PActions = ['대상자 재연락']; s.pDate = Utils.addDaysStr(Utils.todayStr(), 7);
      await SoapModule.save(s, true);
      const edit = JSON.parse(JSON.stringify(SoapModule.get(s.id)));
      edit.S = '수정한 S';
      await SoapModule.save(edit, true);
      await FollowUps.add({ clientId: 'CI1', type: '기타', text: '점검', dueDate: Utils.todayStr() });
      await Schedules.add({ clientId: 'CI1', date: Utils.todayStr(), contactType: '방문', memo: '점검' });
      return { revisions: (SoapModule.get(s.id).revisions || []).length, followUps: FollowUps.list().filter(f => f.clientId === 'CI1').length };
    });
    assert(r.revisions === 1, '최종 기록을 고쳤는데 수정 이력이 ' + r.revisions + '건');
    assert(r.followUps >= 2, 'SOAP 후속조치가 만들어지지 않음');
  });

  await step('입원·위기 대응·가족 상담·연계·서비스계획·평가·강점선호를 저장한다', async () => {
    await page.evaluate(async () => {
      const today = Utils.todayStr();
      await Clients.addAdmission('CI1', { type: '입원', date: Utils.addDaysStr(today, -10), kind: '보호입원', expectedDischarge: Utils.addDaysStr(today, 5) });
      await Clients.addEmergencyContact('CI1', { name: '보호자', relation: '부모', phone: '010-0000-0000' });
      await Clients.addCrisisEvent('CI1', { type: '자해', date: today, time: '10:00', description: '경위', action: '조치' });
      const ev = Clients.get('CI1').crisisEvents[0];
      await Clients.saveCrisisResponse('CI1', ev.id, { steps: [{ time: '10:30', type: '현장 출동·방문', note: 'b' }, { time: '10:00', type: '위기 인지·최초 접촉', note: 'a' }], outcome: '응급입원' });
      const ecId = Clients.get('CI1').emergencyContacts[0].id;
      await Clients.addFamilySession('CI1', { date: today, method: '전화', participantIds: [ecId], topics: ['질병 이해'], nextDate: Utils.addDaysStr(today, 14), agreement: '합의' });
      await Clients.addResourceLink('CI1', { type: '기타', name: '점검기관', date: Utils.addDaysStr(today, -20), status: 'referred', checkDate: Utils.addDaysStr(today, -2) });
      await Clients.addServicePlan('CI1', { date: today, status: 'active', nextReviewDate: Utils.addDaysStr(today, 3), needs: [{ area: '신체건강', hasNeed: true, note: 'n' }], items: [{ area: '신체건강', goal: 'g', service: 's', status: 'in_progress' }] });
      const items = [1, 1, 1, 1, 1, 1, 1, 1, 1];
      await Clients.addAssessment('CI1', { scale: 'PHQ-9 (우울 선별)', items, date: Utils.addDaysStr(today, -40) });
      await Clients.addAssessment('CI1', { scale: 'PHQ-9 (우울 선별)', items: [0, 0, 1, 1, 0, 1, 0, 0, 0], date: today });
      await Clients.saveRecoveryProfile('CI1', { general: { strengths: '강점' }, crisis: { helpful: '조용한 곳', unwanted: '강제 이송' } });
    });
    const r = await page.evaluate(() => ({ steps: Clients.get('CI1').crisisEvents[0].steps.map(x => x.time).join(','), pend: Clients.getPendingReferrals().length, rev: Clients.getPlanReviews().length, inpt: Clients.getInpatients().length, score: Clients.get('CI1').assessments[0].score }));
    assert(r.steps === '10:00,10:30', '위기 대응 단계가 시각순으로 저장되지 않음: ' + r.steps);
    assert(r.pend === 1 && r.rev === 1 && r.inpt === 1, '대시보드 알림 대상 계산 오류: ' + JSON.stringify(r));
    assert(r.score === '9', 'PHQ-9 합계 계산 오류: ' + r.score);
  });

  await step('종결(사후 확인 후속조치)과 재등록이 동작한다', async () => {
    const r = await page.evaluate(async () => {
      await Clients.close('CI2', { reason: '자립/목표 달성', date: Utils.todayStr(), outcome: '목표 달성', summary: '요약', aftercareMonths: [3, 6] });
      const made = FollowUps.list().filter(f => f.clientId === 'CI2' && f.type === '종결 후 사후 확인').length;
      await Clients.reopen('CI2');
      const left = FollowUps.list().filter(f => f.clientId === 'CI2' && f.type === '종결 후 사후 확인').length;
      return { made, left, status: Clients.get('CI2').status };
    });
    assert(r.made === 2 && r.left === 0 && r.status === 'active', '종결/재등록 결과가 다름: ' + JSON.stringify(r));
  });

  await step('월말 마감 점검이 빠진 기록을 짚고 화면에 표시된다', async () => {
    const r = await page.evaluate(async () => {
      const d = Utils.addDaysStr(Utils.todayStr(), -40), m = d.slice(0, 7);
      await Clients.add({ id: 'ME1', alias: '마감', managementLevel: 'intensive', registrationDate: Utils.addDaysStr(d, -30) });
      const s = SoapModule.createBlank({ clientId: 'ME1' }); s.date = d; s.S = '임시';
      await SoapModule.save(s, false);
      await Schedules.add({ clientId: 'ME1', date: d, contactType: '방문' });
      await FollowUps.add({ clientId: 'ME1', type: '기타', text: '밀림', dueDate: d });
      await Clients.addCrisisEvent('ME1', { type: '자해', date: d, time: '10:00', description: 'x', action: '' });
      const c = Stats.monthEndCheck(m);
      const none = Stats.monthEndCheck('2000-01');
      Views._reportMode = 'month'; Views._reportMonth = m;
      UI.navigate('stats', {});
      return { draft: c.draftSoaps.length, sch: c.missedSchedules.length, fu: c.overdueFollowUps.length, cr: c.openCrisis.length, nc: c.noContactMonth.filter(x => x.clientId === 'ME1').length, noneTotal: none.draftSoaps.length + none.missedSchedules.length + none.openCrisis.length };
    });
    assert(r.draft === 1 && r.sch === 1 && r.fu === 1 && r.cr === 1, '월말 점검 집계가 다름: ' + JSON.stringify(r));
    assert(r.nc === 0 && r.noneTotal === 0, '월말 점검 오탐: ' + JSON.stringify(r));
    await page.waitForTimeout(200);
    const txt = await page.evaluate(() => (document.getElementById('monthEndCheck') || {}).textContent || '');
    assert(txt.includes('확인 필요') && txt.includes('ME1'), '월말 마감 점검 패널이 표시되지 않음');
    noNewErrors('월말 마감 점검');
  });

  await step('SOAP 작성 화면에 대상자 참고 패널이 뜨고, 이상한 날짜는 저장 전에 되묻는다', async () => {
    const r = await page.evaluate(async () => {
      await Clients.saveRecoveryProfile('ME1', { general: {}, crisis: { helpful: '참고용 도움말', unwanted: '참고용 금지' } });
      await Clients.addMedication('ME1', { name: '참고약', dose: '5mg', date: Utils.todayStr(), nextRxDate: Utils.addDaysStr(Utils.todayStr(), 20) });
      const html = Views.soapReferenceHtml('ME1', '');
      const today = Utils.todayStr();
      return {
        html: html.includes('참고용 도움말') && html.includes('참고약') && html.includes('다음 처방일'),
        empty: Views.soapReferenceHtml('', '').includes('대상자를 고르면'),
        future: Views.soapDateWarnings({ date: Utils.addDaysStr(today, 3), pDate: '' }).length,
        old: Views.soapDateWarnings({ date: Utils.addDaysStr(today, -90), pDate: '' }).length,
        backward: Views.soapDateWarnings({ date: today, pDate: Utils.addDaysStr(today, -1) }).length,
        far: Views.soapDateWarnings({ date: today, pDate: Utils.addDaysStr(today, 500) }).length,
        ok: Views.soapDateWarnings({ date: today, pDate: Utils.addDaysStr(today, 7) }).length
      };
    });
    assert(r.html && r.empty, '대상자 참고 내용이 다름: ' + JSON.stringify(r));
    assert(r.future === 1 && r.old === 1 && r.backward === 1 && r.far === 1 && r.ok === 0, '날짜 점검이 다름: ' + JSON.stringify(r));
    // 화면에서: 미래 날짜로 임시저장하면 확인 창이 뜨고, 취소하면 저장되지 않는다
    await page.evaluate(() => UI.navigate('soapEditor', { prefillClientId: 'ME1' }));
    await page.waitForTimeout(200);
    const shown = await page.evaluate(() => document.getElementById('soapRefBody').textContent.includes('참고용 도움말'));
    assert(shown, '작성 화면에 대상자 참고 패널이 보이지 않음');
    await page.evaluate(() => {
      document.getElementById('soapDate').value = Utils.addDaysStr(Utils.todayStr(), 5);
      document.getElementById('soapS').value = '미래날짜 점검';
      document.getElementById('saveDraftBtn').click();
    });
    await page.waitForTimeout(200);
    const asked = await page.evaluate(() => (document.querySelector('#modalBox') || {}).textContent || '');
    assert(asked.includes('오늘보다 뒤'), '날짜 확인 창이 뜨지 않음');
    await page.evaluate(() => document.getElementById('confirmNoBtn').click());
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => SoapModule.list().some(x => x.S === '미래날짜 점검'));
    assert(!saved, '취소했는데 저장됨');
    await page.evaluate(() => { Views._draftCache = null; });
    noNewErrors('대상자 참고·날짜 점검');
  });

  await step('개인정보 경고, 비식별 복사, 점검 기준 일수 설정이 동작한다', async () => {
    const r = await page.evaluate(async () => {
      const w = (t) => Views.soapPrivacyWarnings({ S: t, O: '', A: '', PText: '' }).length;
      const c = Clients.get('ME1');
      const d = Utils.deidentify('ME1(' + c.alias + ') 900101-1234567 연락 010-1234-5678 / 02-123-4567', c);
      const before = CONSTANTS.CONTACT_GAP_DAYS_BY_LEVEL.crisis;
      await Thresholds.save({ contactGap: { crisis: '3', intensive: 'abc' }, reassess: {}, planSoon: '7' });
      const after = { gap: CONSTANTS.CONTACT_GAP_DAYS_BY_LEVEL.crisis, bad: CONSTANTS.CONTACT_GAP_DAYS_BY_LEVEL.intensive, plan: CONSTANTS.PLAN_REVIEW_SOON_DAYS };
      const stored = await Storage.getSetting('thresholds');
      await Thresholds.reset();
      return { rrn: w('번호 900101-1234567 입니다'), phone: w('연락처 010-1234-5678'), none: w('2026-10-08에 방문, 3회 연락'), d, before, after, stored: !!stored, back: CONSTANTS.CONTACT_GAP_DAYS_BY_LEVEL.crisis, planBack: CONSTANTS.PLAN_REVIEW_SOON_DAYS };
    });
    assert(r.rrn === 1 && r.phone === 1 && r.none === 0, '개인정보 경고가 다름: ' + JSON.stringify(r));
    assert(!/ME1|마감|900101|1234-5678|123-4567/.test(r.d), '비식별 처리가 덜 됨: ' + r.d);
    assert(r.after.gap === 3 && r.after.bad === 30 && r.after.plan === 7 && r.stored, '기준 일수 저장/잘못된 값 처리가 다름: ' + JSON.stringify(r.after));
    assert(r.back === r.before && r.planBack === 14, '기본값 복원이 다름');
    await page.evaluate(() => UI.navigate('settings', {}));
    await page.waitForTimeout(200);
    assert(await page.evaluate(() => !!document.getElementById('saveThresholdBtn')), '설정 화면에 기준 일수 패널이 없음');
    noNewErrors('개인정보·기준 일수');
  });

  await step('주요 화면이 모두 오류 없이 그려진다', async () => {
    const views = [['dashboard', {}], ['clients', {}], ['clientDetail', { id: 'CI1' }], ['soapList', {}], ['soapEditor', { prefillClientId: 'CI1' }], ['followUps', {}], ['schedule', {}],
      ['resourceDirectory', {}], ['search', {}], ['stats', {}], ['outcomes', {}], ['selfCare', {}], ['training', {}], ['settings', {}], ['tour', {}], ['caseloadSummary', {}],
      ['handoverSummary', { id: 'CI1' }], ['dailyBriefing', {}]];
    for (const [v, params] of views){
      await page.evaluate(([name, p]) => UI.navigate(name, p), [v, params]);
      await page.waitForTimeout(120);
      const txt = await page.evaluate(() => document.getElementById('appMain').textContent);
      assert(txt.length > 30 && !txt.includes('알 수 없는 화면'), v + ' 화면이 비어 있거나 알 수 없는 화면임');
    }
    const plan = await page.evaluate(() => Clients.get('CI1').servicePlans[0].id);
    const ev = await page.evaluate(() => Clients.get('CI1').crisisEvents[0].id);
    for (const [v, params] of [['servicePlanEditor', { clientId: 'CI1', planId: plan }], ['servicePlanPrint', { clientId: 'CI1', planId: plan }], ['crisisReport', { clientId: 'CI1', eventId: ev }]]){
      await page.evaluate(([name, p]) => UI.navigate(name, p), [v, params]);
      await page.waitForTimeout(120);
      const txt = await page.evaluate(() => document.getElementById('appMain').textContent);
      assert(txt.length > 30, v + ' 화면이 비어 있음');
    }
    noNewErrors('화면 이동');
  });

  await step('대화상자(간단 기록·종결·연계 결과·위기 대응·긴급 정보·상용구)가 열린다', async () => {
    await page.evaluate(() => UI.navigate('clientDetail', { id: 'CI1' }));
    await page.waitForTimeout(200);
    await show();
    const open = async (fn, titlePart) => {
      await page.evaluate(fn);
      await page.waitForTimeout(150);
      const title = await page.evaluate(() => (document.querySelector('#modalBox h3') || {}).textContent || '');
      assert(title.includes(titlePart), '"' + titlePart + '" 대화상자가 열리지 않음(현재: ' + title + ')');
      await page.evaluate(() => UI.closeModal());
    };
    await open(() => Views.openQuickRecordModal('CI1'), '간단 기록');
    await open(() => Views.openClosureModal('CI1', false), '종결');
    await open(() => Views.openReferralResultModal('CI1', Clients.get('CI1').resourceLinks[0].id), '연계 결과');
    await open(() => Views.openCrisisResponseModal('CI1', Clients.get('CI1').crisisEvents[0].id), '대응 경과');
    await open(() => Views.openEmergencyInfoModal('CI1'), '긴급 정보');
    await open(() => Views.openSnippetManager(), '상용구');
    noNewErrors('대화상자');
  });

  await step('간단 기록을 화면에서 저장할 수 있다', async () => {
    await page.evaluate(() => Views.openQuickRecordModal('CI1'));
    await page.fill('#qrText', '점검용 간단 기록');
    await click('#qrSave');
    const saved = await page.evaluate(() => SoapModule.list().some(s => s.S === '점검용 간단 기록' && s.status === 'final'));
    assert(saved, '간단 기록이 저장되지 않음');
  });

  await step('새로고침 후 다시 로그인해도 기록이 그대로 있다', async () => {
    const before = await page.evaluate(() => ({ c: Clients.list().length, s: SoapModule.list().length, f: FollowUps.list().length }));
    await page.reload();
    await page.waitForSelector('#loginPw', { state: 'visible' });
    await page.fill('#loginPw', PASSWORD);
    await page.click('#loginSubmitBtn');
    await page.waitForSelector('#appShell:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    const after = await page.evaluate(() => ({ c: Clients.list().length, s: SoapModule.list().length, f: FollowUps.list().length }));
    assert(JSON.stringify(before) === JSON.stringify(after), '다시 로그인한 뒤 기록 수가 다름: ' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
    noNewErrors('재로그인');
  });

  await step('백업 파일에 모든 기록이 들어 있고 평문이 새지 않는다', async () => {
    const r = await page.evaluate(async () => {
      await Snippets.add({ label: '평문확인라벨', field: 'S', text: '평문확인내용XYZ' });
      const d = await Backup.exportAll();
      const raw = JSON.stringify(d);
      return { clients: d.clients.length, soaps: d.soaps.length, hasSnippets: !!d.settings.textSnippetsEnc, leaked: raw.includes('평문확인내용XYZ') || raw.includes('점검1') || raw.includes('원본 S') };
    });
    assert(r.clients >= 2 && r.soaps >= 2, '백업에 기록이 빠짐: ' + JSON.stringify(r));
    assert(r.hasSnippets, '백업에 상용구가 빠짐');
    assert(!r.leaked, '백업 파일에 암호화되지 않은 내용이 들어 있음');
  });

  await step('가벼운 백업(첨부 제외)은 훨씬 작고 기록은 그대로이며, 복원하면 첨부만 비게 된다', async () => {
    const r = await page.evaluate(async () => {
      const c = Clients.get('CI1');
      c.documents = [{ id: 'docci', name: '동의서', receivedDate: '', attachments: [{ id: 'attci', filename: 'scan.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(600000) }] }];
      await Storage.saveEncrypted('clients', c);
      const stats = Backup.attachmentStats();
      const full = JSON.stringify(await Backup.exportAll());
      const lightData = await Backup.exportAll({ excludeAttachments: true });
      const light = JSON.stringify(lightData);
      const row = lightData.clients.find(x => x.id === 'CI1');
      const dec = await CryptoModule.decryptJSON(Auth.cryptoKey, row.iv, row.cipher);
      return { fullKB: Math.round(full.length / 1024), lightKB: Math.round(light.length / 1024), flag: !!lightData.attachmentsExcluded, emptied: dec.documents[0].attachments[0].dataUrl === '', kept: dec.documents[0].attachments[0].filename === 'scan.jpg', statsCount: stats.count, soapsKept: lightData.soaps.length };
    });
    assert(r.flag && r.emptied && r.kept, '가벼운 백업의 첨부 처리가 잘못됨: ' + JSON.stringify(r));
    assert(r.lightKB * 3 < r.fullKB, '가벼운 백업이 충분히 작지 않음: ' + r.fullKB + 'KB → ' + r.lightKB + 'KB');
    assert(r.statsCount === 1, '첨부 현황 집계가 다름: ' + r.statsCount);
    // 가벼운 백업 파일로 복원 → 다시 로그인 → 기록은 남고 첨부 본문만 빈다
    await page.evaluate(async () => {
      const data = await Backup.exportAll({ excludeAttachments: true });
      await Backup.importFromFile(new File([JSON.stringify(data)], 'light.json', { type: 'application/json' }));
    });
    await page.reload();
    await page.waitForSelector('#loginPw', { state: 'visible' });
    await page.fill('#loginPw', PASSWORD);
    await page.click('#loginSubmitBtn');
    await page.waitForSelector('#appShell:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    const after = await page.evaluate(() => ({ clients: Clients.list().length, soaps: SoapModule.list().length, att: Clients.get('CI1').documents[0].attachments[0] }));
    assert(after.clients >= 2 && after.soaps >= 2, '복원 후 기록이 사라짐: ' + JSON.stringify(after));
    assert(after.att.dataUrl === '' && after.att.filename === 'scan.jpg', '복원 후 첨부 상태가 다름');
    await page.evaluate(() => UI.navigate('clientDetail', { id: 'CI1' }));
    await page.waitForTimeout(200);
    await show();
    const ph = await page.evaluate(() => document.getElementById('appMain').textContent.includes('(파일 없음)'));
    assert(ph, '비어 있는 첨부가 "파일 없음"으로 표시되지 않음');
    noNewErrors('가벼운 백업 복원');
  });

  const loginWith = async (pw) => {
    await page.reload();
    await page.waitForSelector('#loginPw', { state: 'visible' });
    await page.fill('#loginPw', pw);
    await page.click('#loginSubmitBtn');
  };
  const counts = () => page.evaluate(() => ({ c: Clients.list().length, s: SoapModule.list().length, f: FollowUps.list().length }));

  await step('비밀번호를 바꿔도 기록과 복구 코드가 그대로 유효하다', async () => {
    const before = await counts();
    await page.evaluate(async ([a, b]) => { await Auth.changePassword(a, b); }, [PASSWORD, 'ci-new-pass-2']);
    await loginWith(PASSWORD);   // 이전 비밀번호는 이제 안 된다
    await page.waitForSelector('#loginError:not(.hidden)');
    await loginWith('ci-new-pass-2');
    await page.waitForSelector('#appShell:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    const after = await counts();
    assert(JSON.stringify(before) === JSON.stringify(after), '비밀번호 변경 후 기록 수가 달라짐: ' + JSON.stringify(before) + ' → ' + JSON.stringify(after));
    noNewErrors('비밀번호 변경');
  });

  await step('비밀번호를 잊어도 복구 코드로 열고 새 비밀번호를 정할 수 있다', async () => {
    const before = await counts();
    await page.reload();
    await page.waitForSelector('#loginPw', { state: 'visible' });
    await page.click('#lrLink');
    // 틀린 코드는 거부된다
    await page.fill('#lrCode', 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    await page.fill('#lrPw1', 'ci-recovered-3');
    await page.fill('#lrPw2', 'ci-recovered-3');
    await page.click('#lrSubmit');
    await page.waitForSelector('#lrError:not(.hidden)');
    assert((await page.textContent('#lrError')).includes('올바르지'), '틀린 복구 코드 안내가 없음');
    // 소문자·하이픈 없는 입력도 같은 코드로 인정된다
    await page.fill('#lrCode', recoveryCode.toLowerCase().replace(/-/g, ' '));
    await page.click('#lrSubmit');
    await page.waitForSelector('#appShell:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    const after = await counts();
    assert(JSON.stringify(before) === JSON.stringify(after), '복구 후 기록 수가 달라짐');
    await loginWith('ci-recovered-3');
    await page.waitForSelector('#appShell:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    noNewErrors('복구 코드로 열기');
  });

  await step('예전 방식 사용자가 복구 코드를 만들면 기록은 그대로 두고 안전하게 옮겨진다', async () => {
    // 이 기능이 생기기 전 방식(비밀번호에서 바로 키를 만들어 기록을 암호화)의 데이터를 새 브라우저에 직접 만든다.
    const ctx = await browser.newContext();
    const old = await ctx.newPage();
    const errs = [];
    old.on('pageerror', (e) => errs.push(e.message));
    await old.goto(app);
    await old.waitForSelector('#ackNoticeCheckbox', { state: 'attached' });
    await old.evaluate(async (pw) => {
      const salt = CryptoModule.generateSaltB64();
      const it = CryptoModule.ITERATIONS;
      const k0 = await CryptoModule.deriveKey(pw, salt, it);
      const v = await CryptoModule.encryptJSON(k0, { v: CryptoModule.VERIFIER_TEXT });
      await Storage.setSetting('authSalt', salt); await Storage.setSetting('authIterations', it);
      await Storage.setSetting('authVerifierIV', v.iv); await Storage.setSetting('authVerifierCipher', v.cipher);
      await Storage.setSetting('autoLockMinutes', 5);
      const client = { id: 'OLD1', alias: '예전방식', managementLevel: 'maintenance', status: 'active', registrationDate: '2024-01-01', admissions: [], resourceLinks: [] };
      const enc = await CryptoModule.encryptJSON(k0, client);
      await Storage.idbPut('clients', { id: 'OLD1', iv: enc.iv, cipher: enc.cipher });
    }, 'legacy-pass-1');
    await old.reload();
    await old.waitForSelector('#loginPw', { state: 'visible' });
    await old.fill('#loginPw', 'legacy-pass-1');
    await old.click('#loginSubmitBtn');
    await old.waitForSelector('#appShell:not(.hidden)');
    await old.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    assert(await old.evaluate(() => Clients.list().some(c => c.id === 'OLD1')), '예전 방식 기록이 열리지 않음');
    assert(await old.evaluate(() => !Auth.recoveryReady), '예전 방식 사용자에게 복구 코드가 이미 있다고 나옴');
    // 예전 방식 상태의 백업을 먼저 받아 둔다(나중에 이 백업을 복원해도 열려야 한다)
    const legacyBackup = await old.evaluate(async () => JSON.stringify(await Backup.exportAll()));
    // 틀린 비밀번호로는 만들 수 없다
    const wrong = await old.evaluate(async () => { try { await Auth.enableRecovery('틀린비밀번호'); return 'ok'; } catch (e) { return e.message; } });
    assert(wrong === 'WRONG_PASSWORD', '틀린 비밀번호로 복구 코드가 만들어짐: ' + wrong);
    const code = await old.evaluate(async () => await Auth.enableRecovery('legacy-pass-1'));
    assert(/^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/.test(code), '복구 코드 형식이 다름');
    // 다시 로그인 — 같은 비밀번호, 같은 기록(기록을 다시 암호화하지 않았다)
    await old.reload();
    await old.waitForSelector('#loginPw', { state: 'visible' });
    await old.fill('#loginPw', 'legacy-pass-1');
    await old.click('#loginSubmitBtn');
    await old.waitForSelector('#appShell:not(.hidden)');
    await old.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    assert(await old.evaluate(() => Clients.list().some(c => c.id === 'OLD1')), '옮긴 뒤 기록이 열리지 않음');
    assert(await old.evaluate(() => Auth.recoveryReady), '복구 코드를 만든 뒤에도 준비 안 됨으로 표시됨');
    // 복구 코드로도 열린다
    const viaCode = await old.evaluate(async (c) => { await Auth.recoverWithCode(c, 'legacy-new-2'); return Clients.list().length; }, code);
    assert(viaCode >= 0, '복구 코드 사용 실패');
    // 옮기기 전(예전 방식) 백업을 복원해도 예전 비밀번호로 열린다(남은 새 방식 정보가 섞이지 않는다)
    await old.evaluate(async (text) => { await Backup.importFromFile(new File([text], 'legacy.json', { type: 'application/json' })); }, legacyBackup);
    await old.reload();
    await old.waitForSelector('#loginPw', { state: 'visible' });
    await old.fill('#loginPw', 'legacy-pass-1');
    await old.click('#loginSubmitBtn');
    await old.waitForSelector('#appShell:not(.hidden)');
    await old.waitForFunction(() => document.getElementById('appMain').textContent.length > 50);
    assert(await old.evaluate(() => Clients.list().some(c => c.id === 'OLD1')), '예전 방식 백업 복원 후 열리지 않음');
    assert(errs.length === 0, '예전 방식 이전 중 화면 오류: ' + errs.join(' | '));
    await ctx.close();
  });

  await step('핵심 화면에 접근성 심각 위반이 없다 (라이트·다크)', async () => {
    for (const scheme of ['light', 'dark']){
      await page.emulateMedia({ colorScheme: scheme });
      for (const [v, params] of [['dashboard', {}], ['clientDetail', { id: 'CI1' }], ['outcomes', {}], ['soapEditor', { prefillClientId: 'CI1' }], ['settings', {}]]){
        await page.evaluate(([name, p]) => UI.navigate(name, p), [v, params]);
        await page.waitForTimeout(150);
        await show();
        await axeCheck(scheme + ' ' + v);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await browser.close();
  server.close();

  if (failures.length){
    console.error('\n브라우저 점검 실패 ' + failures.length + '건:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('\n브라우저 점검 통과 (' + stepNo + '단계)');
})().catch((e) => { console.error('점검 실행 중 오류:', e); process.exit(1); });
