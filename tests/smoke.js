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
  page.on('console', (m) => { if (m.type() === 'error' && m.text().startsWith('[앱 오류]')) pageErrors.push(m.text()); });
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

  await step('소요 시간 통계, 월 접촉 계획 대비 실제, 연계 의뢰서가 동작한다', async () => {
    const r = await page.evaluate(async () => {
      const today = Utils.todayStr(), m = today.slice(0, 7);
      await Clients.add({ id: 'PL1', alias: '계획', managementLevel: 'maintenance', registrationDate: Utils.addDaysStr(today, -400) });
      const mk = async (type, dur) => { const s = SoapModule.createBlank({ clientId: 'PL1' }); s.contactType = type; s.durationMin = dur; s.S = '시간'; await SoapModule.save(s, true); };
      await mk('방문', 60); await mk('방문', 30); await mk('전화', ''); 
      const rep = Stats.monthlyReport(m);
      await Clients.update('PL1', { contactPlanPerMonth: 5 });
      const c = Clients.get('PL1');
      const txt = Clients.contactPlanText(c);
      const lastDay = new Date(parseInt(m.slice(0, 4), 10), parseInt(m.slice(5, 7), 10), 0).getDate();
      const short = Stats.monthEndCheck(m).planShortfall.filter(x => x.clientId === 'PL1').length;
      await Clients.addResourceLink('PL1', { type: '기타', name: '의뢰기관', date: today, status: 'referred', note: '의뢰사유 본문' });
      const link = Clients.get('PL1').resourceLinks[0];
      const html = Views.referralLetter({ clientId: 'PL1', linkId: link.id });
      return { visit: rep.durationByType['방문'], total: rep.durationTotal, rec: rep.durationRecorded, txt, short, lastDay, letter: html.includes('의뢰사유 본문') && html.includes('의뢰기관') && html.includes('PL1') && !html.includes('undefined'), clean: [Utils.cleanMinutes('0'), Utils.cleanMinutes('abc'), Utils.cleanMinutes('45')], linkId: link.id };
    });
    assert(r.visit && r.visit.count === 2 && r.visit.minutes === 90 && r.total === 90 && r.rec === 2, '소요 시간 집계가 다름: ' + JSON.stringify(r));
    assert(r.txt === '이번 달 3회 / 계획 5회', '계획 대비 표시가 다름: ' + r.txt);
    assert(r.clean[0] === '' && r.clean[1] === '' && r.clean[2] === 45, '소요 시간 정리가 다름');
    assert(r.letter, '연계 의뢰서 내용이 다름');
    await page.evaluate(([cid, lid]) => UI.navigate('referralLetter', { clientId: cid, linkId: lid }), ['PL1', r.linkId]);
    await page.waitForTimeout(200);
    const out = await page.evaluate(() => { document.getElementById('ltRequest').value = '요청문구'; document.getElementById('ltRequest').dispatchEvent(new Event('input')); return document.getElementById('ltRequestOut').textContent + '|' + document.getElementById('ltReasonOut').textContent; });
    assert(out === '요청문구|의뢰사유 본문', '의뢰서 인쇄용 문구 동기화가 다름: ' + out);
    await page.evaluate(() => UI.navigate('clientDetail', { id: 'PL1' }));
    await page.waitForTimeout(200);
    const hasPlanInput = await page.evaluate(() => !!document.getElementById('contactPlanInput') && document.getElementById('contactPlanInput').value === '5');
    assert(hasPlanInput, '대상자 화면에 월 접촉 계획 입력이 없음');
    // SOAP 화면의 소요 시간 입력이 저장된다
    await page.evaluate(() => UI.navigate('soapEditor', { prefillClientId: 'PL1' }));
    await page.waitForTimeout(200);
    const saved = await page.evaluate(async () => {
      document.getElementById('soapDuration').value = '40';
      document.getElementById('soapS').value = '소요화면저장';
      document.getElementById('saveFinalBtn').click();
      await new Promise(r => setTimeout(r, 300));
      const el = document.getElementById('confirmYesBtn'); if (el) el.click();
      await new Promise(r => setTimeout(r, 300));
      const s = SoapModule.list().find(x => x.S === '소요화면저장');
      return s ? s.durationMin : null;
    });
    assert(saved === 40, '화면에서 입력한 소요 시간이 저장되지 않음: ' + saved);
    noNewErrors('소요 시간·접촉 계획·의뢰서');
  });

  await step('디브리핑 탭: 미등록 대상자 위기개입·등록 대상자 사건 디브리핑을 저장하고 보고서·통계에 반영한다', async () => {
    const r = await page.evaluate(async () => {
      const ev = Clients.get('CI1').crisisEvents[0];
      const before = Debriefings.hasForEvent('CI1', ev);
      const fuBefore = FollowUps.list().length;
      const d = Debriefings.forEvent('CI1', ev.id);
      Object.assign(d, { participants: '본인', facts: '사실정리본문', wentWell: '잘된점본문', toImprove: '바꿀점본문', staffImpact: '비밀실무자영향', review: ['안전계획 보완', '없는항목'], actions: '안전계획 수정\n\n보호자 연락', forSupervision: true, supervisionQuestion: '슈퍼비전질문' });
      const made = await Debriefings.save(d, true);
      const again = Debriefings.forEvent('CI1', ev.id);
      const html = Views.crisisReport({ clientId: 'CI1', eventId: ev.id });
      const u = Debriefings.blank({ kind: 'crisisUnreg' });
      Object.assign(u, { subjectNote: '50대 여성 이웃 신고', clientId: 'CI1', crisisType: '112 신고', outcome: '현장에서 안정됨', facts: '미등록 사실', actions: '지역센터 안내' });
      const made2 = await Debriefings.save(u, true);
      let err = '';
      try{ const bad = Debriefings.blank({ kind: 'crisisReg' }); await Debriefings.save(bad, false); }catch(e){ err = e.message; }
      const m = Utils.todayStr().slice(0, 7);
      const rep = Stats.monthlyReport(m);
      return { before, made, after: Debriefings.hasForEvent('CI1', ev), review: again.review.join(','), fuAdded: FollowUps.list().length - fuBefore, report: html.includes('사실정리본문') && html.includes('바꿀점본문'), leak: html.includes('비밀실무자영향'), made2, uClient: Debriefings.get(u.id).clientId, err, unreg: rep.debriefCounts.crisisUnreg, reg: rep.debriefCounts.crisisReg };
    });
    assert(r.before === false && r.after === true && r.made === 2 && r.fuAdded === 2, '디브리핑 저장/후속조치 등록이 다름: ' + JSON.stringify(r));
    assert(r.review === '안전계획 보완', '반영 항목 정리가 다름: ' + r.review);
    assert(r.report && !r.leak, '보고서에 디브리핑이 안 실리거나 실무자 영향이 새어 나옴');
    assert(r.made2 === 0 && r.uClient === '' && /대상자/.test(r.err), '미등록 위기개입 처리가 다름: ' + JSON.stringify(r));
    assert(r.unreg === 1 && r.reg === 1, '월간 보고서 디브리핑 건수가 다름: ' + JSON.stringify(r));
    for (const [v, p] of [['debriefings', {}], ['debriefEditor', { kind: 'crisisUnreg' }], ['debriefEditor', { clientId: 'CI1', eventId: await page.evaluate(() => Clients.get('CI1').crisisEvents[0].id) }]]){
      await page.evaluate(([name, params]) => UI.navigate(name, params), [v, p]);
      await page.waitForTimeout(150);
      const txt = await page.evaluate(() => document.getElementById('appMain').textContent);
      assert(txt.length > 30 && !txt.includes('알 수 없는 화면'), v + ' 화면이 비어 있음');
    }
    const filled = await page.evaluate(() => document.getElementById('dbStaff').value);
    assert(filled === '비밀실무자영향', '편집 화면에 저장한 내용이 다시 나타나지 않음');
    // 화면에서 미등록 위기개입 저장
    await page.evaluate(() => UI.navigate('debriefEditor', { kind: 'crisisUnreg' }));
    await page.waitForTimeout(150);
    await page.evaluate(() => { document.getElementById('dbSubject').value = '화면입력 미등록'; document.getElementById('dbFacts').value = '화면 사실'; document.getElementById('dbSaveBtn').click(); });
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => Debriefings.list().some(d => d.subjectNote === '화면입력 미등록')), '화면에서 미등록 디브리핑이 저장되지 않음');
    noNewErrors('디브리핑');
  });

  await step('위기 빠른 기록과 디브리핑 미작성 알림이 동작한다', async () => {
    await page.evaluate(() => UI.navigate('dashboard', {}));
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('qbQuickDebrief').click());
    await page.waitForTimeout(150);
    const r1 = await page.evaluate(async () => {
      document.getElementById('qdSubject').value = '빠른기록 미등록';
      document.getElementById('qdDate').value = Utils.addDaysStr(Utils.todayStr(), -5);
      document.getElementById('qdType').value = '112 신고';
      document.getElementById('qdSave').click();
      await new Promise(r => setTimeout(r, 300));
      const d = Debriefings.list().find(x => x.subjectNote === '빠른기록 미등록');
      return { saved: !!d, incomplete: d && Debriefings.isIncomplete(d), kind: d && d.kind };
    });
    assert(r1.saved && r1.incomplete && r1.kind === 'crisisUnreg', '빠른 기록이 저장되지 않음: ' + JSON.stringify(r1));
    const r2 = await page.evaluate(async () => {
      const p = Debriefings.pendingList();
      const quick = p.find(x => x.label.includes('빠른기록 미등록'));
      const recent = Debriefings.blank({ kind: 'crisisUnreg' }); recent.subjectNote = '오늘건'; await Debriefings.save(recent, false);
      const p2 = Debriefings.pendingList();
      await Thresholds.save({ debrief: '1' });
      const p3 = Debriefings.pendingList();
      await Thresholds.reset();
      UI.navigate('dashboard', {});
      return { found: !!quick, days: quick && quick.days, todayHidden: !p2.some(x => x.label.includes('오늘건')), onDay1: p3.length >= p2.length, back: CONSTANTS.DEBRIEF_DUE_DAYS };
    });
    assert(r2.found && r2.days === 5 && r2.todayHidden && r2.back === 3, '미작성 알림 계산이 다름: ' + JSON.stringify(r2));
    await page.waitForTimeout(250);
    const panel = await page.evaluate(() => (document.getElementById('debriefGapSection') || {}).textContent || '');
    assert(panel.includes('빠른기록 미등록') && panel.includes('5일 경과'), '대시보드에 디브리핑 미작성 알림이 없음');
    await page.evaluate(() => document.querySelector('#debriefGapSection [data-goto-debrief]').click());
    await page.waitForTimeout(200);
    assert(await page.evaluate(() => State.currentView === 'debriefEditor' && !!document.getElementById('dbFacts')), '알림을 눌러도 작성 화면으로 이동하지 않음');
    noNewErrors('빠른 기록·미작성 알림');
  });

  await step('미등록 위기개입 통계·등록 전환·슈퍼비전 안건 출력·위기 대응 부담 알림이 동작한다', async () => {
    const r = await page.evaluate(async () => {
      const m = Utils.todayStr().slice(0, 7);
      const mk = async (o) => { const d = Debriefings.blank({ kind: 'crisisUnreg' }); Object.assign(d, o); await Debriefings.save(d, false); return d; };
      const a = await mk({ subjectNote: '전환대상', crisisType: '자해', route: '전화', outcome: '현장에서 안정됨', facts: '전환 사실 010-9999-8888', actions: '재방문', forSupervision: true, supervisionQuestion: '질문', staffImpact: '출력금지영향' });
      await mk({ subjectNote: '다른건', crisisType: '자해', route: '방문', outcome: '응급입원' });
      const st = Debriefings.unregStats(m);
      const load = Debriefings.crisisLoad(m);
      // 안건 출력
      const agendaHtml = Views.supervisionAgenda();
      // 전환
      const c = await Debriefings.convertToClient(a.id, { clientId: 'CV1', alias: '전환별칭', managementLevel: 'crisis' });
      const conv = Debriefings.get(a.id);
      const ev = Clients.get('CV1').crisisEvents[0];
      let dupErr = '';
      try{ await Debriefings.convertToClient(a.id, { clientId: 'CV2' }); }catch(e){ dupErr = e.message; }
      // 부담 알림
      await Thresholds.save({ crisisLoad: '1' });
      UI.navigate('dashboard', {});
      return { typeSelf: st.byType['자해'], total: st.total, route: st.byRoute['전화'], load, loadOk: load >= 2,
        agenda: agendaHtml.includes('전환 사실') && agendaHtml.includes('[전화번호 가림]') && !agendaHtml.includes('010-9999') && !agendaHtml.includes('출력금지영향'),
        conv: conv.kind === 'crisisReg' && conv.clientId === 'CV1' && conv.eventId === ev.id && conv.subjectNote === '', evType: ev.type, evOutcome: ev.outcome, evDate: ev.date === conv.date, level: c.managementLevel, dupErr };
    });
    assert(r.total >= 2 && r.typeSelf >= 2 && r.route >= 1 && r.loadOk, '미등록 통계가 다름: ' + JSON.stringify(r));
    assert(r.agenda, '슈퍼비전 안건 출력이 다름(비식별/영향 제외): ' + JSON.stringify(r));
    assert(r.conv && r.evType === '자해' && r.evOutcome === '현장에서 안정됨' && r.evDate && r.level === 'crisis' && /미등록/.test(r.dupErr), '등록 전환이 다름: ' + JSON.stringify(r));
    await page.waitForTimeout(250);
    const loadPanel = await page.evaluate(() => (document.getElementById('crisisLoadSection') || {}).textContent || '');
    assert(loadPanel.includes('위기 응대') && loadPanel.includes('건'), '위기 대응 부담 알림이 대시보드에 없음');
    await page.evaluate(async () => { await Thresholds.reset(); });
    for (const v of ['supervisionAgenda', 'outcomes']){
      await page.evaluate((name) => UI.navigate(name, {}), v);
      await page.waitForTimeout(200);
      const txt = await page.evaluate(() => document.getElementById('appMain').textContent);
      assert(txt.length > 30 && !txt.includes('알 수 없는 화면'), v + ' 화면이 비어 있음');
      if (v === 'outcomes') assert(txt.includes('미등록 대상자 위기개입'), '성과지표에 미등록 위기개입이 없음');
    }
    noNewErrors('미등록 통계·전환·안건·부담');
  });

  await step('보고서 CSV·연간 보고서·오늘의 브리핑·슈퍼비전 결과 기록 연결이 동작한다', async () => {
    const r = await page.evaluate(async () => {
      const m = Utils.todayStr().slice(0, 7), y = m.slice(0, 4);
      const rows = CSV.reportExtraRows(Stats.monthlyReport(m)).map(x => x.join('='));
      const yrows = CSV.reportExtraRows(Stats.annualReport(y)).map(x => x.join('='));
      // 슈퍼비전 결과 기록
      const d = Debriefings.blank({ kind: 'crisisUnreg' });
      Object.assign(d, { subjectNote: '안건건', facts: '내용', forSupervision: true, supervisionQuestion: '어떻게 할까요' });
      await Debriefings.save(d, false);
      const notesBefore = SelfCare.list().filter(n => n.category === 'supervision').length;
      const note = await Debriefings.setSupervisionDone(d.id, true, '경계를 분명히 하세요');
      const again = await Debriefings.setSupervisionDone(d.id, true, '경계를 분명히, 기록은 짧게');
      const notesAfter = SelfCare.list().filter(n => n.category === 'supervision');
      const done = Debriefings.get(d.id);
      // 브리핑
      const today = Utils.todayStr();
      await Clients.update('PL1', { safetyPlan: { warningSigns: '브리핑경고신호' } });
      await Schedules.add({ clientId: 'PL1', date: today, contactType: '방문' });
      Views._briefingDate = today;
      const briefing = Views.dailyBriefing();
      UI.navigate('stats', {});
      return { hasDur: rows.some(x => x.startsWith('소요 시간을 적은 상담 기록 수=')), hasDeb: rows.some(x => x.startsWith('디브리핑 - 위기개입(미등록 대상자)=')), hasUnreg: rows.some(x => x.startsWith('미등록 위기개입 유형:')), yDeb: yrows.some(x => x.startsWith('디브리핑 - 위기개입(미등록 대상자)=')),
        noteMade: !!note && note.category === 'supervision', sameNote: again.id === note.id, notesAdded: notesAfter.length - notesBefore, noteText: notesAfter.find(n => n.id === note.id).note, linked: done.supervisionNoteId === note.id && done.supervisionDone,
        briefing: briefing.includes('브리핑경고신호') && briefing.includes('먼저 챙길 것') };
    });
    assert(r.hasDur && r.hasDeb && r.hasUnreg && r.yDeb, '보고서 CSV에 새 항목이 빠짐: ' + JSON.stringify(r));
    assert(r.noteMade && r.sameNote && r.notesAdded === 1 && r.linked && r.noteText.includes('기록은 짧게') && r.noteText.includes('어떻게 할까요'), '슈퍼비전 결과 기록 연결이 다름: ' + JSON.stringify(r));
    assert(r.briefing, '오늘의 브리핑에 경고신호/먼저 챙길 것이 없음');
    await page.evaluate(() => { Views._reportMode = 'year'; UI.navigate('stats', {}); });
    await page.waitForTimeout(250);
    const annual = await page.evaluate(() => document.getElementById('appMain').textContent);
    assert(annual.includes('디브리핑 기록') && annual.includes('접촉유형별 소요 시간'), '연간 보고서에 디브리핑/소요 시간이 없음');
    await page.evaluate(() => { Views._reportMode = 'month'; });
    noNewErrors('보고서·브리핑·슈퍼비전 연결');
  });

  await step('날짜 확인 확대, 긴 목록 나눠 보기, 기록 보관·파기가 동작한다', async () => {
    const r = await page.evaluate(async () => {
      const today = Utils.todayStr();
      const w = {
        crisisFuture: Utils.dateWarning('위기개입 날짜', Utils.addDaysStr(today, 2), { maxPastDays: 90 }),
        crisisOld: Utils.dateWarning('위기개입 날짜', Utils.addDaysStr(today, -200), { maxPastDays: 90 }),
        crisisOk: Utils.dateWarning('위기개입 날짜', Utils.addDaysStr(today, -3), { maxPastDays: 90 }),
        schFarFuture: Utils.dateWarning('일정 날짜', Utils.addDaysStr(today, 500), { future: true, maxFutureDays: 366, maxPastDays: 60 }),
        schOk: Utils.dateWarning('일정 날짜', Utils.addDaysStr(today, 10), { future: true, maxFutureDays: 366, maxPastDays: 60 }),
        empty: Utils.dateWarning('x', '', {})
      };
      const st = {}, el = { textContent: '', classList: { remove(){} } };
      const first = Views.guardDates(el, ['경고'], st), second = Views.guardDates(el, ['경고'], st), none = Views.guardDates(el, [], {});
      // 긴 목록: 100건만 그린다
      for (let i = 0; i < 130; i++){ const s = SoapModule.createBlank({ clientId: 'PL1' }); s.S = '목록' + i; s.date = Utils.addDaysStr(today, -10); await SoapModule.save(s, true); }
      State.currentParams = {}; Views._rowLimits = {};
      const rows1 = (Views.soapList().match(/data-open-soap=/g) || []).length;
      const hasMore = Views.soapList().includes('data-more-rows');
      Views._rowLimits['soap:all'] = 200;
      const rows2 = (Views.soapList().match(/data-open-soap=/g) || []).length;
      Views._rowLimits = {};
      // 보관기간
      await Clients.add({ id: 'OLD1', alias: '오래된', managementLevel: 'maintenance', registrationDate: '2010-01-01' });
      await Clients.close('OLD1', { reason: '자립/목표 달성', date: '2015-03-01', outcome: '목표 달성', summary: '요약', aftercareMonths: [] });
      await Clients.add({ id: 'NEW1', alias: '최근', managementLevel: 'maintenance' });
      await Clients.close('NEW1', { reason: '자립/목표 달성', date: today, outcome: '목표 달성', summary: '요약', aftercareMonths: [] });
      const exp = Retention.expiredList().map(x => x.id);
      let badYears = '';
      try{ await Retention.setYears('0'); }catch(e){ badYears = e.message; }
      await Retention.setYears('3');
      const years = Retention.years;
      return { w, first, second, none, rows1, hasMore, rows2, exp, badYears, years };
    });
    assert(/오늘보다 뒤/.test(r.w.crisisFuture) && /90일보다/.test(r.w.crisisOld) && r.w.crisisOk === '' && /개월 넘게/.test(r.w.schFarFuture) && r.w.schOk === '' && r.w.empty === '', '날짜 경고가 다름: ' + JSON.stringify(r.w));
    assert(r.first === false && r.second === true && r.none === true, '날짜 확인 흐름이 다름: ' + JSON.stringify(r));
    assert(r.rows1 === 100 && r.hasMore && r.rows2 >= 130, '긴 목록 나눠 보기가 다름: ' + JSON.stringify(r));
    assert(r.exp.includes('OLD1') && !r.exp.includes('NEW1') && /1~50/.test(r.badYears) && r.years === 3, '보관기간 계산이 다름: ' + JSON.stringify(r));
    await page.evaluate(() => UI.navigate('settings', {}));
    await page.waitForTimeout(250);
    const txt = await page.evaluate(() => (document.getElementById('retentionSection') || {}).textContent || '');
    assert(txt.includes('OLD1') && txt.includes('완전 삭제'), '설정에 보관기간 지난 대상자가 보이지 않음');
    await page.evaluate(() => document.querySelector('[data-retention-del="OLD1"]').click());
    await page.waitForTimeout(150);
    assert((await page.evaluate(() => document.getElementById('modalBox').textContent)).includes('되돌릴 수 없습니다'), '삭제 확인 창이 뜨지 않음');
    await page.evaluate(() => document.getElementById('confirmYesBtn').click());
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => !Clients.get('OLD1') && !!Clients.get('NEW1')), '보관기간 삭제가 다름');
    await page.evaluate(async () => { await Retention.setYears('5'); });
    noNewErrors('날짜 확인·긴 목록·보관기간');
  });

  await step('자동 백업(폴더), 백업 파일 검증, 저장 안 한 입력 이탈 경고가 동작한다', async () => {
    const r = await page.evaluate(async () => {
      // 가짜 폴더: 파일 쓰기/읽기/삭제를 흉내 낸다(실제 폴더 선택 창은 자동화할 수 없다).
      const files = new Map();
      const fakeDir = {
        name: '가짜백업폴더', kind: 'directory',
        async queryPermission(){ return fakeDir._perm; }, async requestPermission(){ fakeDir._perm = 'granted'; return 'granted'; }, _perm: 'prompt',
        async getFileHandle(n, o){
          if (!files.has(n) && !(o && o.create)) throw new Error('없음');
          if (!files.has(n)) files.set(n, '');
          return { async createWritable(){ let buf = ''; return { async write(t){ buf += t; }, async close(){ files.set(n, buf); } }; }, async getFile(){ return { size: new TextEncoder().encode(files.get(n)).length, async text(){ return files.get(n); } }; } };
        },
        async removeEntry(n){ files.delete(n); },
        async *entries(){ for (const n of Array.from(files.keys())) yield [n, { kind: 'file' }]; }
      };
      AutoBackup.handle = fakeDir; AutoBackup.on = true; AutoBackup.keep = 2; AutoBackup.minutes = 5;
      const needs1 = (await AutoBackup.refreshPermission(), AutoBackup.needsPermission());
      let denied = '';
      try{ await AutoBackup.runNow(); }catch(e){ denied = e.message; }
      await AutoBackup.requestAccess();
      Backup.markDirty();
      const res = await AutoBackup.runNow();
      const dirtyAfter = Backup.dirtySince;
      // 보관 개수 정리: 파일 이름이 서로 다르도록 가짜 파일을 더 넣고 다시 실행
      files.set(AutoBackup.PREFIX + '2000-01-01_0000.json', '{}'); files.set(AutoBackup.PREFIX + '2000-01-02_0000.json', '{}');
      await AutoBackup.runNow();
      const names = Array.from(files.keys()).sort();
      // tick: 변경이 없으면 저장하지 않는다
      const before = files.size; await AutoBackup.tick(true); const afterNoChange = files.size;
      const savedText = files.get(res.name);
      const blob = new File([savedText], 'a.json', { type: 'application/json' });
      const ok = await Backup.inspectFile(blob);
      const bad = await Backup.inspectFile(new File(['{ 깨진 파일'], 'b.json'));
      const wrongApp = await Backup.inspectFile(new File([JSON.stringify({ app: 'other' })], 'c.json'));
      const tampered = JSON.parse(savedText); tampered.clients[0].cipher = tampered.clients[0].cipher.slice(0, -6) + 'AAAAAA';
      const broken = await Backup.inspectFile(new File([JSON.stringify(tampered)], 'd.json'));
      AutoBackup.handle = null; AutoBackup.on = false; AutoBackup.perm = 'none';
      return { needs1, denied, res: !!res.name, dirtyAfter, names, noChange: before === afterNoChange, ok: ok.ok && ok.rows > 0 && ok.failed === 0, counts: ok.counts.clients, bad: bad.errors.length, wrongApp: wrongApp.errors.length, broken: broken.ok === false && broken.failed >= 1 };
    });
    assert(r.needs1 === true && /허용/.test(r.denied), '폴더 접근 허용 흐름이 다름: ' + JSON.stringify(r));
    assert(r.res && r.dirtyAfter === null, '자동 백업 후 변경 표시가 지워지지 않음: ' + JSON.stringify(r));
    assert(r.names.length === 2 && !r.names.some(n => n.includes('2000-01-01')), '오래된 자동 백업 정리가 다름: ' + JSON.stringify(r.names));
    assert(r.noChange, '변경이 없는데 자동 백업이 또 저장됨');
    assert(r.ok && r.counts >= 2 && r.bad === 1 && r.wrongApp === 1 && r.broken, '백업 파일 검증이 다름: ' + JSON.stringify(r));
    // 이탈 경고: 디브리핑 작성 화면에서 입력 후 다른 화면으로 가려 하면 확인 창이 뜨고 취소하면 그대로 남는다
    await page.evaluate(() => UI.navigate('debriefEditor', { kind: 'crisisUnreg' }));
    await page.waitForTimeout(200);
    await page.evaluate(() => { const el = document.getElementById('dbFacts'); el.value = '쓰던 내용'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => UI.navigate('dashboard', {}));
    await page.waitForTimeout(150);
    const asked = await page.evaluate(() => ({ view: State.currentView, modal: (document.getElementById('modalBox') || {}).textContent || '' }));
    assert(asked.view === 'debriefEditor' && asked.modal.includes('저장하지 않은 내용'), '이탈 경고가 뜨지 않음: ' + JSON.stringify(asked));
    await page.evaluate(() => document.getElementById('confirmNoBtn').click());
    await page.waitForTimeout(100);
    assert(await page.evaluate(() => State.currentView === 'debriefEditor' && document.getElementById('dbFacts').value === '쓰던 내용' && !!Views._debriefDraft), '취소했는데 입력이 사라지거나 화면 상태가 깨짐');
    await page.evaluate(() => { document.getElementById('dbBackBtn').click(); });
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById('confirmYesBtn').click());
    await page.waitForTimeout(200);
    assert(await page.evaluate(() => State.currentView === 'debriefings' && !Views._dirty), '확인 후 목록으로 나가지 못함');
    // 저장하면 경고 없이 이동
    await page.evaluate(() => UI.navigate('debriefEditor', { kind: 'crisisUnreg' }));
    await page.waitForTimeout(200);
    await page.evaluate(() => { const el = document.getElementById('dbFacts'); el.value = '저장할 내용'; el.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('dbSubject').value = '이탈테스트'; document.getElementById('dbSaveBtn').click(); });
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => State.currentView === 'debriefings' && !Views._dirty), '저장 뒤에도 이탈 경고 상태가 남음');
    await page.evaluate(() => UI.navigate('settings', {}));
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => !!document.getElementById('autoBackupSection') && !!document.getElementById('verifyBackupBtn')), '설정에 자동 백업/검증이 없음');
    noNewErrors('자동 백업·검증·이탈 경고');
  });

  await step('대상자 요약 탭, 빠른 이동(Ctrl+K), 통합검색 필터가 동작한다', async () => {
    // 요약 탭: 대상자를 처음 열면 요약이 보이고 핵심 정보가 모여 있다
    await page.evaluate(() => { Views._clientDetailTabClientId = null; });
    await page.evaluate(() => Clients.update('PL1', { safetyPlan: { warningSigns: '요약경고신호' } }));
    await page.evaluate(() => UI.navigate('clientDetail', { id: 'PL1' }));
    await page.waitForTimeout(250);
    const sum = await page.evaluate(() => {
      const g = document.querySelector('.detail-tab-group[data-tab-group="summary"]');
      return { active: g.classList.contains('active'), text: g.textContent, btn: !!document.querySelector('.detail-tab-btn[data-tab="summary"]') };
    });
    assert(sum.btn && sum.active && sum.text.includes('요약경고신호') && sum.text.includes('마지막 상담') && sum.text.includes('월 접촉 계획'), '요약 탭 내용이 다름: ' + sum.text.slice(0, 120));
    await page.evaluate(() => { const el = document.querySelector('[data-summary-tab]'); if (el) el.click(); });
    // 빠른 이동
    await page.evaluate(() => UI.navigate('dashboard', {}));
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#qsInput');
    await page.keyboard.type('PL1');
    await page.waitForTimeout(100);
    const opts = await page.evaluate(() => Array.from(document.querySelectorAll('#qsList [role=option]')).map(x => x.textContent));
    assert(opts.length >= 1 && opts[0].includes('PL1'), '빠른 이동 결과가 다름: ' + JSON.stringify(opts));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => State.currentView === 'clientDetail' && State.currentParams.id === 'PL1'), '빠른 이동으로 대상자 화면에 가지 못함');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#qsInput');
    await page.keyboard.type('디브리');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => State.currentView === 'debriefings'), '빠른 이동으로 화면 이름 이동이 안 됨');
    // 통합검색 필터
    const r = await page.evaluate(() => {
      const all = Search.runUniversal('목록');
      const soapOnly = Search.runUniversal('목록', { types: ['soap'] });
      const task = Search.runUniversal('목록', { types: ['task'] });
      const byClient = Search.runUniversal('목록', { clientId: 'PL1' });
      const none = Search.runUniversal('목록', { clientId: 'ME1' });
      const dated = Search.runUniversal('목록', { dateFrom: Utils.addDaysStr(Utils.todayStr(), -11), dateTo: Utils.addDaysStr(Utils.todayStr(), -9) });
      const outside = Search.runUniversal('목록', { dateFrom: Utils.addDaysStr(Utils.todayStr(), 5) });
      const unreg = Search.runUniversal('미등록 사실', { types: ['debrief'] });
      return { all: all.length, soapOnly: soapOnly.length, task: task.length, byClient: byClient.length, none: none.length, dated: dated.length, outside: outside.length, unreg: unreg.map(x => [x.clientId, !!x.target.debriefId]), target: soapOnly[0] && !!soapOnly[0].target.soapId, snippet: soapOnly[0] && soapOnly[0].snippet.includes('목록'), sorted: all.every((x, i) => i === 0 || (all[i - 1].date || '') >= (x.date || '')) };
    });
    assert(r.soapOnly >= 130 && r.all >= r.soapOnly && r.task === 0 && r.byClient >= 130 && r.none === 0, '통합검색 종류/대상자 필터가 다름: ' + JSON.stringify(r));
    assert(r.dated >= 130 && r.outside === 0 && r.target && r.snippet && r.sorted, '통합검색 기간/정렬/이동 대상이 다름: ' + JSON.stringify(r));
    assert(r.unreg.length >= 1 && r.unreg[0][0] === '' && r.unreg[0][1], '미등록 디브리핑이 통합검색에 안 나옴: ' + JSON.stringify(r.unreg));
    await page.evaluate(() => { Views._searchMode = 'universal'; UI.navigate('search', {}); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById('uniKeyword').value = '목록'; document.querySelector('.uniType[value="soap"]').click(); document.getElementById('doUniSearchBtn').click(); });
    await page.waitForTimeout(250);
    const rows = await page.evaluate(() => document.querySelectorAll('#searchResults [data-uni-i]').length);
    assert(rows === 130 || rows === 200 || rows > 100, '통합검색 화면에 결과가 안 나옴: ' + rows);
    await page.evaluate(() => { Views._searchMode = 'soap'; });
    noNewErrors('요약·빠른 이동·통합검색');
  });

  await step('데이터가 있는 상태에서 기관주소록·일정·후속조치 목록이 그려진다(회귀 방지)', async () => {
    const r = await page.evaluate(async () => {
      await ResourceDirectory.add({ type: '정신의료기관', name: '회귀점검병원', phone: '02-111-2222' });
      await ResourceDirectory.add({ type: '사회복지관', name: '회귀점검복지관' });
      for (let i = 0; i < 120; i++) await Schedules.add({ clientId: 'PL1', date: Utils.addDaysStr(Utils.todayStr(), 1 + (i % 30)), contactType: '방문', memo: '회귀' + i });
      for (let i = 0; i < 120; i++) await FollowUps.add({ clientId: 'PL1', type: '기타', text: '회귀후속' + i, dueDate: Utils.addDaysStr(Utils.todayStr(), 2 + (i % 30)) });
      const out = {};
      for (const [v, p] of [['resourceDirectory', {}], ['schedule', {}], ['followUps', {}], ['soapList', {}]]){
        State.currentParams = p; Views._rowLimits = {};
        const html = Views[v]();
        out[v] = { len: html.length, more: html.includes('data-more-rows') };
      }
      State.currentParams = {};
      return { out, rd: Views.resourceDirectory().includes('회귀점검병원') && Views.resourceDirectory().includes('회귀점검복지관') && Views.resourceDirectory().includes('data-edit-resdir') };
    });
    assert(r.rd, '기관주소록에 등록한 기관이 목록에 나오지 않음');
    assert(r.out.schedule.more && r.out.followUps.more && r.out.soapList.more, '긴 목록에 더 보기가 없음: ' + JSON.stringify(r.out));
    // 실제 화면 이동에서도 오류 없이 그려진다
    for (const v of ['resourceDirectory', 'schedule', 'followUps']){
      await page.evaluate((name) => UI.navigate(name, {}), v);
      await page.waitForTimeout(200);
      const txt = await page.evaluate(() => document.getElementById('appMain').textContent);
      assert(txt.length > 100, v + ' 화면이 비어 있음');
      if (v === 'resourceDirectory') assert(txt.includes('회귀점검병원'), '기관주소록 화면에 기관이 안 보임');
    }
    noNewErrors('목록 회귀 점검');
  });

  await step('SOAP 작성 화면에 상용구와 A 자동작성이 없다', async () => {
    await page.evaluate(() => { Views._dirty = false; UI.navigate('soapEditor', { prefillClientId: 'CI1' }); });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => ({
      snippetUi: document.querySelectorAll('.snippetSelect, [data-manage-snippets], .snippet-bar').length,
      gen: !!document.getElementById('genABtn') || !!document.getElementById('regenABtn') || !!document.getElementById('checklistBox'),
      copyA: !!document.getElementById('copyABtn'), textareas: ['soapS', 'soapO', 'soapA', 'soapPText'].every(id => !!document.getElementById(id)),
      apis: [typeof Snippets, typeof SoapModule.generateADraft, typeof Views.snippetBarHtml, typeof Views.openSnippetManager]
    }));
    assert(r.snippetUi === 0 && !r.gen, '상용구/자동작성 화면 요소가 남아 있음: ' + JSON.stringify(r));
    assert(r.copyA && r.textareas, 'SOAP 입력칸이나 A 복사 버튼이 사라짐: ' + JSON.stringify(r));
    assert(r.apis.every(x => x === 'undefined'), '상용구/자동작성 코드가 남아 있음: ' + JSON.stringify(r.apis));
    await page.evaluate(() => { Views.openQuickRecordModal('CI1'); });
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => document.querySelectorAll('#modalBox .snippetSelect').length === 0 && !!document.getElementById('qrText')), '간단 기록 창에 상용구가 남아 있음');
    await page.evaluate(() => UI.closeModal());
    noNewErrors('상용구·자동작성 제거');
  });

  await step('화면 구성: 메뉴·빠른 버튼·대상자 패널을 감추고 다시 보이게 할 수 있다(핵심 안전 패널은 제외)', async () => {
    const cat = await page.evaluate(() => FeatureVisibility.panelCatalog().map(x => x.title));
    assert(cat.includes('복약 현황') && cat.includes('사례회의 기록') && !cat.includes('위기개입 기록') && !cat.includes('위기 시 안전계획') && !cat.includes('위험도 평가 (구조화)'), '패널 목록이 다름: ' + cat.join(','));
    await page.evaluate(async () => {
      await FeatureVisibility.set('nav', 'training', true); await FeatureVisibility.set('quick', 'qbQuickRecord', true);
      await FeatureVisibility.set('panels', '복약 현황', true); await FeatureVisibility.set('panels', '위기개입 기록', true);
      FeatureVisibility.applyNav();
    });
    const r = await page.evaluate(() => {
      const out = { navHidden: document.querySelector('.nav-btn[data-view="training"]').classList.contains('hidden'), navShown: !document.querySelector('.nav-btn[data-view="stats"]').classList.contains('hidden'), moreHas: UI.MOBILE_MORE_ITEMS.filter(i => !FeatureVisibility.isNavHidden(i.view)).some(i => i.view === 'training') };
      Views._dirty = false; UI.navigate('dashboard', {});
      out.quickHidden = document.getElementById('qbQuickRecord').classList.contains('user-hidden') && getComputedStyle(document.getElementById('qbQuickRecord')).display === 'none';
      out.quickOther = getComputedStyle(document.getElementById('qbNewFollowUp')).display !== 'none';
      UI.navigate('clientDetail', { id: 'CI1' });
      const panels = Array.from(document.querySelectorAll('.detail-tab-group > .panel, .detail-tab-group > details'));
      const find = (t) => panels.find(p => { const x = p.querySelector(':scope > .panel-title, :scope > summary'); return x && x.textContent.trim().startsWith(t); });
      out.medHidden = !!find('복약 현황') && find('복약 현황').classList.contains('user-hidden');
      out.crisisShown = !!find('위기개입 기록') && !find('위기개입 기록').classList.contains('user-hidden');
      out.summaryShown = !document.querySelector('.detail-tab-group[data-tab-group="summary"]').classList.contains('user-hidden');
      const q = UI.quickSwitchItems('교육').map(x => x.label);
      out.switcher = !q.some(l => l.includes('교육·슈퍼비전'));
      return out;
    });
    assert(r.navHidden && r.navShown && !r.moreHas && r.quickHidden && r.quickOther, '메뉴/빠른 버튼 감추기가 다름: ' + JSON.stringify(r));
    assert(r.medHidden && r.crisisShown && r.summaryShown && r.switcher, '패널 감추기가 다름: ' + JSON.stringify(r));
    // 인쇄할 때는 감춘 패널도 나온다
    await page.emulateMedia({ media: 'print' });
    const printShown = await page.evaluate(() => { const p = Array.from(document.querySelectorAll('.detail-tab-group > .panel, .detail-tab-group > details')).find(x => (x.querySelector(':scope > .panel-title, :scope > summary') || {}).textContent && x.querySelector(':scope > .panel-title, :scope > summary').textContent.trim().startsWith('복약 현황')); return getComputedStyle(p).display !== 'none'; });
    await page.emulateMedia({ media: null });
    assert(printShown, '인쇄에서 감춘 패널이 빠짐');
    await page.evaluate(() => { Views._dirty = false; UI.navigate('settings', {}); });
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => !!document.getElementById('featuresSection') && document.querySelectorAll('.featChk').length > 10), '설정에 화면 구성이 없음');
    await page.evaluate(() => document.getElementById('featResetBtn').click());
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => !document.querySelector('.nav-btn[data-view="training"]').classList.contains('hidden') && FeatureVisibility.hidden.nav.length === 0 && FeatureVisibility.hidden.panels.length === 0), '모두 다시 표시가 동작하지 않음');
    noNewErrors('화면 구성');
  });

  await step('주요 화면이 모두 오류 없이 그려진다', async () => {
    const views = [['dashboard', {}], ['clients', {}], ['clientDetail', { id: 'CI1' }], ['soapList', {}], ['soapEditor', { prefillClientId: 'CI1' }], ['followUps', {}], ['schedule', {}],
      ['resourceDirectory', {}], ['debriefings', {}], ['search', {}], ['stats', {}], ['outcomes', {}], ['selfCare', {}], ['training', {}], ['settings', {}], ['tour', {}], ['caseloadSummary', {}],
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

  await step('대화상자(간단 기록·종결·연계 결과·위기 대응·긴급 정보)가 열린다', async () => {
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

  await step('후속조치 일괄 처리, 접촉 계획 일정 제안, 데이터 건강검진, 연말 활동 요약이 동작한다', async () => {
    const r = await page.evaluate(async () => {
      const today = Utils.todayStr();
      // --- 일괄 처리
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await FollowUps.add({ clientId: 'PL1', type: '기타', text: '일괄' + i, dueDate: Utils.addDaysStr(today, i === 0 ? -20 : 3) })).id);
      const done1 = await FollowUps.bulkComplete([ids[0]]);
      const done2 = await FollowUps.bulkComplete([ids[0]]);
      const p7 = await FollowUps.bulkPostpone([ids[1], ids[2]], { days: 7 });
      const skipped = await FollowUps.bulkPostpone([ids[0]], { days: 7 });
      const late = await FollowUps.add({ clientId: 'PL1', type: '기타', text: '많이 밀림', dueDate: Utils.addDaysStr(today, -30) });
      await FollowUps.bulkPostpone([late.id], { days: 7 });
      const byDate = await FollowUps.bulkPostpone([ids[3]], { date: Utils.addDaysStr(today, 40) });
      const snaps = await FollowUps.bulkRemove([ids[3]]);
      await FollowUps.restoreSnapshot(snaps[0]);
      const res = { done1, done2, p7, skipped, due1: FollowUps.get(ids[1]).dueDate === Utils.addDaysStr(today, 10), lateDue: FollowUps.get(late.id).dueDate === Utils.addDaysStr(today, 7), dateOk: FollowUps.get(ids[3]).dueDate === Utils.addDaysStr(today, 40), restored: !!FollowUps.get(ids[3]), byDate };
      // --- 접촉 계획 일정 제안
      await Clients.add({ id: 'SC1', alias: '일정제안', managementLevel: 'maintenance', registrationDate: Utils.addDaysStr(today, -100) });
      await Clients.update('SC1', { contactPlanPerMonth: 4 });
      const nextM = (() => { const d = new Date(); const n = new Date(d.getFullYear(), d.getMonth() + 1, 1); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0'); })();
      const dates = Clients.suggestContactDates(Clients.get('SC1'), nextM, 4);
      const wk = dates.every(ds => { const dow = new Date(ds + 'T00:00:00').getDay(); return dow !== 0 && dow !== 6; });
      await Schedules.add({ clientId: 'SC1', date: dates[0], contactType: '방문' });
      const sf = Clients.planShortfall(Clients.get('SC1'), nextM);
      const again = Clients.suggestContactDates(Clients.get('SC1'), nextM, 4);
      const noPlan = Clients.planShortfall(Clients.get('PL1').contactPlanPerMonth ? { id: 'x', contactPlanPerMonth: 0 } : Clients.get('PL1'), nextM).need;
      res.sched = { n: dates.length, wk, uniq: new Set(dates).size === dates.length, avoidsTaken: !again.includes(dates[0]), sfPlanned: sf.planned, noPlan };
      // --- 건강검진
      await State.followUps.set('orph1', { id: 'orph1', clientId: 'NOPE', type: '기타', text: '고아', dueDate: today, status: 'pending' });
      await Storage.saveEncrypted('followUps', State.followUps.get('orph1'));
      const bad = SoapModule.createBlank({ clientId: 'PL1' }); bad.date = '2031-01-01'; bad.S = '이상한날짜'; await SoapModule.save(bad, true);
      const emptyDraft = SoapModule.createBlank({ clientId: 'PL1' }); await SoapModule.save(emptyDraft, false);
      const groups = Health.run();
      const g = (k) => groups.find(x => x.key === k);
      res.health = { orphan: g('orphans').items.some(i => i.text.includes('NOPE')), dates: g('dates').items.some(i => i.text.includes('2031-01-01')), empty: g('empty').items.some(i => !!i.del), clean: !g('orphans').items.some(i => i.text.includes('PL1')) };
      const removed = await Health.fix('orphans');
      res.health.fixed = removed >= 1 && !State.followUps.has('orph1');
      res.health.untouched = SoapModule.get(bad.id) !== undefined;
      // --- 연말 요약
      const html = Views.yearSummary({ year: today.slice(0, 4) });
      res.year = { has: html.includes('활동 요약') && html.includes('위기개입과 디브리핑') && html.includes('서비스 성과') && html.includes('미등록'), noUndefined: !html.includes('undefined') && !html.includes('NaN') };
      return res;
    });
    assert(r.done1 === 1 && r.done2 === 0 && r.p7 === 2 && r.skipped === 0 && r.due1 && r.lateDue && r.dateOk && r.restored, '후속조치 일괄 처리가 다름: ' + JSON.stringify(r));
    assert(r.sched.n === 4 && r.sched.wk && r.sched.uniq && r.sched.avoidsTaken && r.sched.sfPlanned === 1 && r.sched.noPlan === 0, '일정 제안이 다름: ' + JSON.stringify(r.sched));
    assert(r.health.orphan && r.health.dates && r.health.empty && r.health.clean && r.health.fixed && r.health.untouched, '건강검진이 다름: ' + JSON.stringify(r.health));
    assert(r.year.has && r.year.noUndefined, '연말 요약 내용이 다름: ' + JSON.stringify(r.year));
    // 화면: 일괄 선택 → 완료
    await page.evaluate(() => { Views._dirty = false; UI.navigate('followUps', { filter: 'upcoming' }); });
    await page.waitForTimeout(250);
    const ui = await page.evaluate(async () => {
      const first = document.querySelectorAll('.fuSel');
      const total = first.length;
      const upBefore = FollowUps.upcoming().length;
      document.getElementById('fuSelAll').click();
      const afterAll = document.getElementById('fuSelCount').textContent;
      const enabled = !document.getElementById('fuBulk7').disabled;
      document.querySelectorAll('.fuSel').forEach((b, i) => { if (i > 1){ b.checked = false; b.dispatchEvent(new Event('change')); } });
      const two = document.getElementById('fuSelCount').textContent;
      document.getElementById('fuBulkDone').click();
      await new Promise(r => setTimeout(r, 400));
      return { total, afterAll, enabled, two, dropped: upBefore - FollowUps.upcoming().length };
    });
    assert(ui.total >= 3 && ui.enabled && ui.two === '2건 선택' && ui.dropped === 2, '일괄 선택 화면이 다름: ' + JSON.stringify(ui));
    // 화면: 대상자 화면의 일정 제안 창, 설정의 건강검진, 연말 요약 화면
    await page.evaluate(() => { Views._dirty = false; UI.navigate('clientDetail', { id: 'SC1' }); });
    await page.waitForTimeout(250);
    await page.evaluate(() => document.getElementById('planSchedBtn').click());
    await page.waitForTimeout(150);
    const modalTxt = await page.evaluate(() => (document.getElementById('modalBox') || {}).textContent || '');
    assert(modalTxt.includes('월 접촉 계획으로 일정 만들기') && modalTxt.includes('더 필요한 횟수'), '일정 제안 창이 열리지 않음');
    const before = await page.evaluate(() => Schedules.list().filter(x => x.clientId === 'SC1').length);
    await page.evaluate(() => document.getElementById('psMonth').selectedIndex = 1);
    await page.evaluate(() => document.getElementById('psMonth').dispatchEvent(new Event('change')));
    await page.evaluate(() => document.getElementById('psOk').click());
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => Schedules.list().filter(x => x.clientId === 'SC1').length);
    assert(after > before, '제안한 일정이 등록되지 않음: ' + before + '→' + after);
    await page.evaluate(() => { Views._dirty = false; UI.navigate('settings', {}); });
    await page.waitForTimeout(250);
    await page.evaluate(() => document.getElementById('healthRunBtn').click());
    const hr = await page.evaluate(() => document.getElementById('healthResult').textContent);
    assert(hr.includes('검사 결과') || hr.includes('문제가 발견되지'), '건강검진 결과가 표시되지 않음');
    await page.evaluate(() => { Views._dirty = false; UI.navigate('yearSummary', {}); });
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => document.getElementById('appMain').textContent.includes('활동 요약') && !!document.getElementById('ysPrintBtn')), '연말 요약 화면이 없음');
    noNewErrors('일괄 처리·일정 제안·건강검진·연말 요약');
  });

  await step('기록이 가득 찬 상태에서 모든 화면·탭·필터가 오류 없이 그려진다', async () => {
    const result = await page.evaluate(() => {
      const bad = [];
      const go = (label, view, params, pre) => {
        Views._dirty = false;
        if (pre) pre();
        try{ UI.navigate(view, params || {}); }catch(e){ bad.push(label + ': 예외 ' + e.message); return; }
        const main = document.getElementById('appMain');
        if (document.getElementById('renderErrorPanel')) bad.push(label + ': ' + document.querySelector('#renderErrorPanel pre').textContent);
        else if (main.textContent.trim().length < 20) bad.push(label + ': 빈 화면');
      };
      const soap = SoapModule.list()[0], deb = Debriefings.list().find(d => d.kind === 'crisisUnreg'), plan = Clients.get('CI1').servicePlans[0], ev = Clients.get('CI1').crisisEvents[0];
      const link = (Clients.get('PL1').resourceLinks || [])[0];
      const clientIds = Clients.list().map(c => c.id);
      ['dashboard', 'clients', 'followUps', 'schedule', 'resourceDirectory', 'stats', 'outcomes', 'yearSummary', 'debriefings', 'supervisionAgenda', 'selfCare', 'training', 'settings', 'tour', 'caseloadSummary', 'dailyBriefing'].forEach(v => go(v, v));
      ['all', 'draft', 'final'].forEach(f => go('soapList:' + f, 'soapList', { filter: f }));
      ['all', 'today', 'overdue', 'upcoming', 'done'].forEach(f => { go('followUps:' + f, 'followUps', { filter: f }); go('schedule:' + f, 'schedule', { filter: f }); });
      go('schedule:날짜', 'schedule', { selectedDate: Utils.todayStr() });
      [Utils.todayStr().slice(0, 4), String(parseInt(Utils.todayStr().slice(0, 4), 10) - 1)].forEach(y => go('outcomes:' + y, 'outcomes', { year: y }));
      ['month', 'year'].forEach(m => go('stats:' + m, 'stats', {}, () => { Views._reportMode = m; }));
      Views._reportMode = 'month';
      ['soap', 'universal'].forEach(m => go('search:' + m, 'search', {}, () => { Views._searchMode = m; }));
      Views._searchMode = 'soap';
      clientIds.forEach(id => {
        ['summary', 'basic', 'history', 'safety', 'soap', 'plan', 'timeline'].forEach(t => go('clientDetail:' + id + ':' + t, 'clientDetail', { id }, () => { Views._clientDetailTab = t; Views._clientDetailTabClientId = id; }));
        go('handover:' + id, 'handoverSummary', { id });
        go('soapEditor새글:' + id, 'soapEditor', { prefillClientId: id });
      });
      if (soap) go('soapEditor:기존', 'soapEditor', { soapId: soap.id });
      if (deb) go('debriefEditor:기존', 'debriefEditor', { debriefId: deb.id });
      ['crisisUnreg', 'crisisReg', 'counsel', 'other'].forEach(k => go('debriefEditor:' + k, 'debriefEditor', { kind: k }));
      go('debriefEditor:사건', 'debriefEditor', { clientId: 'CI1', eventId: ev.id });
      go('servicePlanEditor', 'servicePlanEditor', { clientId: 'CI1', planId: plan.id });
      go('servicePlanEditor새글', 'servicePlanEditor', { clientId: 'CI1' });
      go('servicePlanPrint', 'servicePlanPrint', { clientId: 'CI1', planId: plan.id });
      go('crisisReport', 'crisisReport', { clientId: 'CI1', eventId: ev.id });
      if (link) go('referralLetter', 'referralLetter', { clientId: 'PL1', linkId: link.id });
      Views._clientDetailTab = 'summary';
      return { bad, count: UI.errorLog.length };
    });
    assert(result.bad.length === 0, '화면 그리기 실패 ' + result.bad.length + '건: ' + result.bad.slice(0, 4).join(' | '));
    noNewErrors('전체 화면 점검');
  });

  await step('화면 그리기 오류가 나면 안내와 복사 버튼이 나오고 다른 화면은 계속 쓸 수 있다', async () => {
    const r = await page.evaluate(() => {
      Views._dirty = false;
      const orig = Views.stats;
      Views.stats = () => { throw new Error('시험용 오류'); };
      const logBefore = UI.errorLog.length;
      const origConsole = console.error; console.error = () => {};
      UI.navigate('stats', {});
      console.error = origConsole;
      const panel = document.getElementById('renderErrorPanel');
      const shown = !!panel && panel.textContent.includes('시험용 오류') && !!document.getElementById('renderErrCopyBtn');
      const report = UI.errorReportText();
      const logged = UI.errorLog.length === logBefore + 1;
      Views.stats = orig;
      UI.errorLog = [];
      document.getElementById('renderErrHomeBtn').click();
      return { shown, logged, report: report.includes('시험용 오류') && report.includes('오류 보고'), after: State.currentView, errPanelGone: !document.getElementById('renderErrorPanel') };
    });
    assert(r.shown && r.logged && r.report, '오류 안내가 다름: ' + JSON.stringify(r));
    assert(r.after === 'dashboard' && r.errPanelGone, '오류 후 다른 화면으로 이동하지 못함');
    await page.evaluate(() => UI.navigate('settings', {}));
    await page.waitForTimeout(200);
    assert(await page.evaluate(() => !!document.getElementById('errorReportSection') && !!document.getElementById('errCopyBtn')), '설정에 문제 보고가 없음');
    noNewErrors('오류 안내');
  });

  await step('인쇄물: 메뉴·버튼이 빠지고 주요 문서가 정해진 쪽수에 들어간다', async () => {
    // 인쇄 화면에서는 메뉴·상단 막대·조작 버튼이 보이지 않아야 한다
    await page.evaluate(() => { Views._dirty = false; UI.navigate('yearSummary', {}); });
    await page.waitForTimeout(250);
    await page.emulateMedia({ media: 'print' });
    const chrome = await page.evaluate(() => {
      const shown = (sel) => Array.from(document.querySelectorAll(sel)).filter(el => getComputedStyle(el).display !== 'none' && el.getClientRects().length).map(el => el.id || el.className);
      return { shell: Array.from(document.getElementById('appShell').children).filter(el => el.id !== 'appMain' && !el.classList.contains('skip-link') && getComputedStyle(el).display !== 'none' && el.getClientRects().length).map(el => el.tagName + '#' + el.id + '.' + el.className), buttons: shown('#ysPrintBtn, #ysBackBtn, #ysYearSelect, .page-header button, .page-header select') };
    });
    await page.emulateMedia({ media: null });
    assert(chrome.shell.length === 0 && chrome.buttons.length === 0, '인쇄 화면에 메뉴/버튼이 남아 있음: ' + JSON.stringify(chrome));
    // 쪽수 (A4, 여백 12/10mm)
    const pages = async (view, params) => {
      await page.evaluate(([v, p]) => { Views._dirty = false; UI.navigate(v, p); }, [view, params]);
      await page.waitForTimeout(250);
      await show();
      const buf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
      return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    };
    const y = await page.evaluate(() => Utils.todayStr().slice(0, 4));
    const plan = await page.evaluate(() => Clients.get('CI1').servicePlans[0].id);
    const ev = await page.evaluate(() => Clients.get('CI1').crisisEvents[0].id);
    const link = await page.evaluate(() => Clients.get('PL1').resourceLinks[0].id);
    const limits = [['연말 활동 요약', 'yearSummary', { year: y }, 1], ['연계 의뢰서', 'referralLetter', { clientId: 'PL1', linkId: link }, 1], ['서비스계획서', 'servicePlanPrint', { clientId: 'CI1', planId: plan }, 1],
      ['슈퍼비전 안건', 'supervisionAgenda', {}, 1], ['오늘의 방문 브리핑', 'dailyBriefing', {}, 1], ['위기개입 보고서', 'crisisReport', { clientId: 'CI1', eventId: ev }, 2], ['인계서', 'handoverSummary', { id: 'CI1' }, 2]];
    const over = [];
    for (const [label, view, params, max] of limits){
      const n = await pages(view, params);
      if (n > max) over.push(label + ' ' + n + '쪽(기준 ' + max + '쪽)');
    }
    assert(over.length === 0, '인쇄 쪽수가 기준을 넘음: ' + over.join(', '));
    noNewErrors('인쇄물 점검');
  });

  await step('백업 파일에 모든 기록이 들어 있고 평문이 새지 않는다', async () => {
    const r = await page.evaluate(async () => {
      const d = await Backup.exportAll();
      const raw = JSON.stringify(d);
      return { clients: d.clients.length, soaps: d.soaps.length, debriefs: (d.debriefings || []).length, leaked: raw.includes('점검1') || raw.includes('원본 S') || raw.includes('비밀실무자영향') || raw.includes('화면 사실') };
    });
    assert(r.clients >= 2 && r.soaps >= 2 && r.debriefs >= 3, '백업에 기록이 빠짐: ' + JSON.stringify(r));
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
