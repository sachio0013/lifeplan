// スマホ幅のブラウザで実際に操作して確かめる。 npm run build && npm run e2e
// スクリーンショットは引数で渡したフォルダ（省略時は dist/shots）に保存する。
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] || join(root, 'dist/shots');
mkdirSync(shots, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'));

const html = readFileSync(join(root, 'dist/preview.html'));
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); }
// スマホで入力中は上のバーと目次がたたまれるので、キーボードを閉じて（フォーカスを外して）から押す
async function go(p, sel) {
  await p.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await p.waitForTimeout(250);
  await p.tap(sel);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Webフォントの読み込み失敗（作業環境のプロキシ証明書をテスト用ブラウザが信頼しないため）はアプリの不具合ではないので除く
page.on('console', (m) => {
  const src = (m.location() && m.location().url) || '';
  if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(src + m.text())) errors.push(`${m.text()} ${src}`);
});

await page.goto(url);
await page.waitForSelector('.cover');
check('はじめて開くと表紙が出る', /のぞいてみよう/.test(await page.textContent('.cover')));
await page.screenshot({ path: join(shots, '0-cover.png') });
await page.locator('.cvalt .btn', { hasText: '記入例' }).tap();
await page.waitForSelector('#f-start');
await page.waitForTimeout(400);

// 「？」を押すとFPのひとことが出て、もう一度押すと閉じる
await page.locator('#card-living .hq').tap();
await page.waitForTimeout(100);
const helpText = await page.locator('#card-living .helpbox').textContent().catch(() => '');
await page.locator('#card-living').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, '0b-help.png') });
await page.locator('#card-living .hq').tap();
await page.waitForTimeout(100);
check('「？」でFPのひとことが開き、もう一度押すと閉じる', /FPのひとこと/.test(helpText) && /食費/.test(helpText) && (await page.locator('.helpbox').count()) === 0, helpText.slice(0, 40));
const helpCount = await page.$$eval('#content .hq', (els) => els.length);
check('入力画面の各欄に「？」がある', helpCount >= 18, `${helpCount}個`);

const summaryText = await page.textContent('#summary');
check('サマリーに終了時点の金融資産が出る', /終了時点|預金が不足/.test(summaryText), summaryText.trim().slice(0, 60));
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('入力画面が横にはみ出さない', overflow <= 0, `${overflow}px`);
await page.screenshot({ path: join(shots, '1-input-top.png') });

// 金額を変えるとサマリーが変わる
const before = await page.textContent('#summary');
await page.fill('#f-living-1-amt', '520');
await page.press('#f-living-1-amt', 'Tab');
await page.waitForTimeout(200);
const after = await page.textContent('#summary');
check('基本生活費を変えるとサマリーの数字が変わる', before !== after, `${before.trim().slice(0, 30)} → ${after.trim().slice(0, 30)}`);
const deltaText = await page.locator('#delta.show').textContent().catch(() => '');
const pillClear = await page.evaluate(() => {
  const p = document.getElementById('delta').getBoundingClientRect(), g = document.querySelector('#summary svg[preserveAspectRatio]').getBoundingClientRect();
  return p.bottom <= g.top + 2;
});
check('変えた直後に、終了時点の金融資産の増減が出る（グラフには重ならない）', /今の変更で−[\d,]+万円/.test(deltaText) && pillClear, `${deltaText} 重ならない=${pillClear}`);
await page.screenshot({ path: join(shots, '1b-delta.png') });
await page.waitForTimeout(3000);
check('増減の表示は数秒で消える', (await page.locator('#delta').isHidden()));

// 入力欄を移ってもフォーカスが外れない（スマホでキーボードが閉じない）
await page.tap('#f-housing-1-amt');
await page.fill('#f-housing-1-amt', '110');
await page.tap('#f-housing-2-amt');
await page.waitForTimeout(200);
const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
check('次の入力欄をタップしたらそこにフォーカスが残る', focused === 'f-housing-2-amt', `activeElement=${focused}`);
await page.locator('#f-housing-2-amt').blur();

// 数字の欄：タップすると中身が全部選ばれ、全角で打っても数字になり、Enterで次の欄へ。入力中は上のバーがたたまれる
await page.locator('#f-insurance-1-amt').scrollIntoViewIfNeeded();
await page.tap('#f-insurance-1-amt');
await page.waitForTimeout(250);
const sel = await page.evaluate(() => { const e = document.activeElement; return [e.id, e.selectionStart, e.selectionEnd, e.value.length]; });
const folded = await page.evaluate(() => document.getElementById('shell').classList.contains('kb') && getComputedStyle(document.getElementById('topbar')).display === 'none');
const graphWhileTyping = await page.evaluate(() => { const g = document.querySelector('#summary svg[preserveAspectRatio]'); return !!g && g.getBoundingClientRect().height > 20; });
await page.keyboard.type('２４');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const afterEnter = await page.evaluate(() => document.activeElement && document.activeElement.id);
const insVal = await page.inputValue('#f-insurance-1-amt');
await page.evaluate(() => document.activeElement.blur());
await page.waitForTimeout(300);
const unfolded = await page.evaluate(() => !document.getElementById('shell').classList.contains('kb'));
check('数字の欄はタップで全選択・全角も可・Enterで次へ。入力中は上のバーをたたむがグラフは残し、終わると戻る',
  sel[0] === 'f-insurance-1-amt' && sel[1] === 0 && sel[2] === sel[3] && sel[3] > 0 && folded && graphWhileTyping && insVal === '24' && afterEnter === 'f-insurance-1-memo' && unfolded,
  `選択=${sel} たたむ=${folded} グラフ=${graphWhileTyping} 値=${insVal} 次=${afterEnter} 戻る=${unfolded}`);
// キーボードを閉じてもフォーカスが残ったまま（Androidの戻るボタンなど）でも、入力欄以外に触れればタブが戻る
await page.tap('#f-insurance-1-amt');
await page.waitForTimeout(250);
const stuck = await page.evaluate(() => document.getElementById('shell').classList.contains('kb') && getComputedStyle(document.getElementById('tabbar')).display === 'none');
const hintBox = await page.locator('#card-insurance .hint').first().boundingBox().catch(() => null)
  || await page.locator('#content .hint').first().boundingBox();
await page.touchscreen.tap(hintBox.x + 10, hintBox.y + hintBox.height / 2);
await page.waitForTimeout(300);
const back = await page.evaluate(() => !document.getElementById('shell').classList.contains('kb') && getComputedStyle(document.getElementById('tabbar')).display !== 'none'
  && !!document.querySelector('#tabbar #seg-cf') && document.querySelector('#seg-input').textContent.trim() === '入力');
check('入力中に入力欄以外へ触れると、下のタブ（入力・未来の表など）が戻る', stuck && back, `隠れる=${stuck} 戻る=${back}`);
await page.fill('#f-insurance-1-amt', '20');
await page.press('#f-insurance-1-amt', 'Tab');
await page.evaluate(() => document.activeElement.blur());
await page.waitForTimeout(250);

// 同じ年の行を追加すると「合算する」が出て、押すと1行になる
const addOther = page.locator('#content .card', { hasText: 'その他の経常支出' }).locator('.addbtn');
await addOther.tap();
await page.waitForTimeout(100);
await addOther.tap();
await page.waitForTimeout(100);
const otherIds = await page.$$eval('#content input[id^="f-otherFlow-"][id$="-year"]', (els) => els.map((e) => e.id));
await page.fill(`#${otherIds[0].replace('-year', '-amt')}`, '30');
await page.press(`#${otherIds[0].replace('-year', '-amt')}`, 'Tab');
await page.fill(`#${otherIds[1]}`, '2026');
await page.press(`#${otherIds[1]}`, 'Tab');
await page.fill(`#${otherIds[1].replace('-year', '-amt')}`, '20');
await page.press(`#${otherIds[1].replace('-year', '-amt')}`, 'Tab');
await page.waitForTimeout(150);
const dupShown = await page.locator('.dup').count();
await page.locator('.dup button').first().tap();
await page.waitForTimeout(150);
const merged = await page.$$eval('#content input[id^="f-otherFlow-"][id$="-amt"]', (els) => els.map((e) => e.value));
check('同じ年の行で「合算する」が出て、押すと1行にまとまる', dupShown === 1 && merged.length === 1 && merged[0] === '50', `dup=${dupShown} rows=${JSON.stringify(merged)}`);

// 削除しても「元に戻す」で戻せる。年額の支出には月あたりの額も出る
const livingBefore = await page.$$eval('#content input[id^="f-living-"][id$="-amt"]', (els) => els.length);
await page.locator('#content .rowline', { has: page.locator('#f-living-2-amt') }).locator('button.del').tap();
await page.waitForTimeout(150);
const livingAfter = await page.$$eval('#content input[id^="f-living-"][id$="-amt"]', (els) => els.length);
const toastText = await page.textContent('#toast');
await page.locator('#toast button').tap();
await page.waitForTimeout(150);
const livingUndone = await page.$$eval('#content input[id^="f-living-"][id$="-amt"]', (els) => els.length);
const insHint = await page.locator('#content .rowline', { has: page.locator('#f-insurance-1-amt') }).locator('.ageh').textContent();
check('行を削除しても「元に戻す」で戻せ、年額の支出に月あたりの額が出る',
  livingBefore === 2 && livingAfter === 1 && /削除しました/.test(toastText) && livingUndone === 2 && /月1\.7万円/.test(insHint),
  `${livingBefore}→${livingAfter}→${livingUndone} / ${toastText} / ${insHint}`);

// 教育費：段階を私立に変えると金額が単価表の値に変わる
const eduSel = page.locator('#content select[id^="f-edu-3-2-stage"]');
await eduSel.selectOption('小学校（私）');
await page.waitForTimeout(150);
const eduAmt = await page.inputValue('#f-edu-3-2-amt');
check('教育費の段階を変えると相場の金額が入る', eduAmt === '185', `小学校（私）=${eduAmt}`);

// 公的年金：自動で見込む（プランの給与を額面に直して）。「もっと正確に」で変えられ、自分で入力する行にも入れられる
await page.locator('#card-pubPension .penmode button', { hasText: '自動で見込む' }).tap();
await page.waitForSelector('#card-pubPension .ppres');
const ppAuto = await page.$$eval('#card-pubPension .ppres b', (els) => els.map((e) => e.textContent));
await page.locator('#card-pubPension .penp .toggle').first().tap();
await page.locator('#card-pubPension .ppset button', { hasText: '1年目の年収' }).tap();
await page.waitForSelector('#f-pp-state-1-firstIncome');
await page.fill('#f-pp-state-1-firstIncome', '300'); await page.press('#f-pp-state-1-firstIncome', 'Tab');
await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
const ppFirst = await page.$$eval('#card-pubPension .ppres b', (els) => els.map((e) => e.textContent));
await page.locator('#card-pubPension .penp').first().scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, '16-pension.png') });
await page.locator('#card-pubPension .penmode button', { hasText: '自分で入力する' }).tap(); await page.waitForTimeout(150);
await page.locator('#card-pubPension .btn', { hasText: '自動の見込額を行に入れる' }).tap(); await page.waitForTimeout(150);
const ppRows = await page.$$eval('[id^="f-pubPension-"][id$="-amt"]', (els) => els.map((e) => e.value));
const ppSum = Math.round((parseFloat(ppFirst[0]) + parseFloat(ppFirst[1])) * 10) / 10;
check('公的年金：給与から自動で見込み（記入例で夫194.7万円・妻141.5万円）、1年目の年収を入れると変わり、自分で入力する行にも入れられる',
  ppAuto[0] === '194.7' && ppAuto[1] === '141.5' && ppFirst[0] !== ppAuto[0] && ppRows.length === 1 && parseFloat(ppRows[0]) === ppSum,
  `${ppAuto.join('・')} → ${ppFirst.join('・')} / 行=${ppRows.join(',')}`);
await page.locator('#toast button').tap(); await page.waitForTimeout(150);   // 行は元に戻す（以降のテストのため）

// 住宅ローンの試算：サンプル（4500万円・35年・1%→2%）はExcelと同じ返済額。反映すると住宅費の行になる
await page.locator('.toggle', { hasText: '住宅ローンを試算する' }).tap();
await page.waitForSelector('#f-loan-amount');
const loanRes = await page.locator('.loanres').textContent();
const loanTotal = await page.locator('.calcresult', { hasText: '返済総額' }).textContent();
await page.locator('.toggle', { hasText: '年ごとの返済表' }).tap();
await page.waitForTimeout(100);
const loanTableRows = await page.$$eval('.loantable tbody tr', (els) => els.length);
await page.locator('.loanres').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, '17-loan.png') });
await page.locator('.btn', { hasText: '住宅費に反映する' }).tap();
await page.waitForTimeout(100);
const loanConfirm = await page.locator('.calcbox .plconfirm').textContent();
await page.locator('.calcbox .btn', { hasText: '置き換える' }).tap();
await page.waitForTimeout(150);
const housingRows = await page.$$eval('#content input[id^="f-housing-"][id$="-amt"]', (els) => els.map((e) => e.value));
check('住宅ローンの試算がExcelと同じ（年152.4→171.4万円、総額5,810万円）で、確認のうえ住宅費に反映できる',
  /返済 年152\.4万円/.test(loanRes) && /返済 年171\.4万円/.test(loanRes) && /5,810/.test(loanTotal) && loanTableRows === 36 &&
  /2027年以降の住宅費の行（3行）/.test(loanConfirm) && JSON.stringify(housingRows) === '["110","202.4","221.4","50"]',
  `${loanTotal.trim()} 表${loanTableRows}行 / ${loanConfirm.trim().slice(0, 30)} / 住宅費=${housingRows}`);

// 目次をタップすると該当セクションに移る
await go(page, '#tabs .tab[data-k="invest"]');
await page.waitForTimeout(200);
const investVisible = await page.evaluate(() => {
  const r = document.getElementById('sec-invest').getBoundingClientRect();
  return r.top > 0 && r.top < window.innerHeight / 2;
});
check('目次「投資」で投資セクションに移る', investVisible);
await page.screenshot({ path: join(shots, '2-input-invest.png') });

// CF表画面
await go(page, '#seg-cf');
await page.waitForSelector('#chart');
await page.waitForTimeout(200);
const cols = await page.$$eval('table.cf thead th', (ths) => ths.length - 1);
check('CF表に56年分の列がある', cols === 56, `${cols}列`);
const cfOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('CF表画面が横にはみ出さない（表は枠の中だけで横スクロール）', cfOverflow <= 0, `${cfOverflow}px`);
const box = await page.locator('#chart').boundingBox();
await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.4);
await page.waitForTimeout(100);
const tipVisible = await page.locator('#tip').isVisible();
const tipText = tipVisible ? await page.textContent('#tip') : '';
check('グラフをタップすると年と内訳が出る', tipVisible && /年（\d+歳）/.test(tipText), tipText.slice(0, 50));
await page.screenshot({ path: join(shots, '3-cf.png') });
await page.locator('.tablecard').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, '4-cf-table.png') });

// 再読み込みしても入力が残る
await page.reload();
await page.waitForSelector('#seg-input');
await go(page, '#seg-input');
await page.waitForSelector('#f-living-1-amt');
const persisted = await page.inputValue('#f-living-1-amt');
check('再読み込みしても入力が残っている', persisted === '520', `基本生活費=${persisted}`);

// 入力画面の一番下に、入力を消してしまう「記入例に戻す」ボタンは置かない（間違って押さないように）
const resetBtns = await page.locator('#inputview button', { hasText: '記入例' }).count();
check('入力画面に「記入例に戻す」ボタンが無い', resetBtns === 0, `${resetBtns}`);
// 以降の確認のため、表示中のプランを記入例の内容にしておく
await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); s.plans.find((p) => p.id === s.activeId).state = window.LifePlanSample.sample(); localStorage.setItem('lifeplan.v2', JSON.stringify(s)); });
await page.reload();
await go(page, '#seg-input');
await page.waitForSelector('#f-living-1-amt');

// iPhoneは16px未満の入力欄をタップすると画面を拡大してしまうので、全部16px以上にしておく
await go(page, '#tabs .tab[data-k="basic"]');
await page.locator('#content .member button.del').first().tap();
await page.waitForTimeout(150);
const small = await page.$$eval('#content input, #content select', (els) => els
  .filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.className));
check('入力欄・選択欄の文字がすべて16px以上（iPhoneで拡大されない）', small.length === 0, small.slice(0, 5).join(', '));

// 生年月日は数字で打てて（8桁でも）、横のカレンダーからも選べる
const birthVal = await page.inputValue('#f-fam-3-birth');
await page.fill('#f-fam-3-birth', '２０２２０４０１');
await page.press('#f-fam-3-birth', 'Tab');
await page.waitForTimeout(150);
const typed = await page.inputValue('#f-fam-3-birth');
const eduHead = await page.locator('#content .card', { hasText: '第一子の教育費' }).locator('.cnt').textContent();
await page.fill('#f-fam-3-birth-cal', '2022-01-01');
await page.locator('#f-fam-3-birth-cal').blur();
await page.waitForTimeout(150);
const picked = await page.inputValue('#f-fam-3-birth');
await page.locator('#f-fam-3-birth').scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, '7a-birth.png') });
check('生年月日は8桁の数字（全角も可）で打てて、カレンダーからも選べる',
  birthVal === '2022/01/01' && typed === '2022/04/01' && /2022\/04\/01・早生まれ/.test(eduHead) && picked === '2022/01/01',
  `${birthVal} → 打つ ${typed}（${eduHead}）→ カレンダー ${picked}`);

// 入力の確認：終了年齢を今の年齢より下にすると、欄の下とページ上部で知らせ、CF表も落ちない
await page.fill('#f-endage', '30');
await page.press('#f-endage', 'Tab');
await page.waitForTimeout(150);
const banner = await page.locator('.vbanner').textContent().catch(() => '');
const msg = await page.locator('#sec-basic + .card .vmsg').textContent().catch(() => '');
const sumBad = await page.textContent('#summary');
await go(page, '#seg-cf');
await page.waitForTimeout(150);
const cfMsg = await page.textContent('#cf');
await go(page, '#seg-input');
await page.waitForTimeout(150);
check('おかしな入力は欄の下とページ上部で知らせ、計算できなくても画面が落ちない',
  /1 件/.test(banner) && /終了年齢/.test(msg) && /計算できません/.test(sumBad) && /計算できる年がありません/.test(cfMsg),
  `${banner.trim()} / ${msg.trim().slice(0, 30)}`);
await page.screenshot({ path: join(shots, '7-validation.png') });
await page.fill('#f-endage', '90');
await page.press('#f-endage', 'Tab');
await page.waitForTimeout(150);
check('直すと知らせが消える', (await page.locator('.vbanner').count()) === 0);

// 年の欄を「年齢」で入れる
await go(page, '#tabs .tab[data-k="expense"]');
await page.locator('.mini button', { hasText: '年齢' }).tap();
await page.waitForTimeout(150);
const ageVal = await page.inputValue('#f-living-2-year');
const ageSuffix = await page.locator('#f-living-2-year + .u').textContent();
await page.fill('#f-living-2-year', '70');
await page.press('#f-living-2-year', 'Tab');
await page.waitForTimeout(150);
const ageHint = await page.locator('#content .rowline', { has: page.locator('#f-living-2-year') }).locator('.ageh').textContent();
await page.screenshot({ path: join(shots, '11-age-mode.png') });
await page.locator('.mini button', { hasText: '西暦' }).tap();
await page.waitForTimeout(150);
const backYear = await page.inputValue('#f-living-2-year');
check('「年齢」に切り替えると家族１の年齢で入れられ、西暦で保存される', ageVal === '65' && ageSuffix === '歳から' && /^2061年/.test(ageHint) && backYear === '2061', `${ageVal}${ageSuffix} → 70歳=${ageHint} / 西暦=${backYear}`);
await page.fill('#f-living-2-year', '2056');
await page.press('#f-living-2-year', 'Tab');

// はじめての人：表紙で家族のかたちと気になることを選び、参考値入りのかんたん入力で自分のプランを作る
const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', acceptDownloads: true });
const wp = await fresh.newPage();
wp.on('pageerror', (e) => errors.push(e.message));
await wp.goto(url);
await wp.waitForSelector('.cover');
await wp.locator('.opt', { hasText: '3人家族' }).tap();
for (const n of ['教育費', 'NISA', '節約']) { await wp.locator('.need', { hasText: n }).tap(); await wp.waitForTimeout(120); }
const coverPicked = await wp.$$eval('.need.on, .opt.on', (els) => els.map((e) => e.textContent.trim()));
const coverOverflow = await wp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await wp.locator('.cvcta .btn').scrollIntoViewIfNeeded();
await wp.screenshot({ path: join(shots, '0c-cover-picked.png') });
check('表紙で家族のかたち・住まい・気になることを選べる', coverPicked.length === 5 && coverOverflow <= 0, coverPicked.join(' / '));
await wp.locator('.cvcta .btn').tap();
await wp.waitForSelector('.wz');
await wp.fill('#w-name1', 'わたし'); await wp.press('#w-name1', 'Tab');
await wp.locator('.wzhead button').tap();
await wp.waitForTimeout(100);
const askClose = await wp.locator('.wz .plconfirm').textContent().catch(() => '');
await wp.locator('.wz .plconfirm .btn', { hasText: '続ける' }).tap();
await wp.waitForTimeout(100);
check('かんたん入力を途中で閉じるときは確かめる', /保存されません/.test(askClose) && (await wp.inputValue('#w-name1')) === 'わたし', askClose);
await wp.locator('.wznav .btn', { hasText: '次へ' }).tap();
await wp.waitForTimeout(100);
const making = await wp.evaluate(() => [document.getElementById('planname').textContent, document.getElementById('planbtn').disabled]);
check('かんたん入力の間は、上にプラン名ではなく「新しいプランを作成中」と出て、プランの切り替えは押せない', making[0] === '新しいプランを作成中' && making[1] === true, making.join(' '));
const needBirth = await wp.locator('.wz .vmsg').textContent().catch(() => '');
check('かんたん入力：生年月日が無いと先に進まず、理由が出る', /生年月日/.test(needBirth) && /家計の中心の人/.test(await wp.textContent('.wzt')), needBirth);
await wp.locator('.wzmore summary').tap();
await wp.fill('#w-startYear', '2026'); await wp.press('#w-startYear', 'Tab');
await wp.fill('#w-birth1', '1986-07-10'); await wp.locator('#w-birth1').blur();
await wp.screenshot({ path: join(shots, '8-wizard-1.png') });
const next = () => wp.locator('.wznav .btn', { hasText: /次へ|この内容で計算する/ }).tap().then(() => wp.waitForTimeout(100));
await next();
await wp.waitForSelector('.wz .check');
const famPreset = await wp.evaluate(() => [document.querySelector('.check').classList.contains('on'), document.querySelectorAll('.kid').length]);
await wp.fill('#w-birth2', '1988-02-03'); await wp.locator('#w-birth2').blur();
await wp.fill('#w-kid-0', '2020-05-05'); await wp.locator('#w-kid-0').blur();
await wp.waitForTimeout(100);
await wp.screenshot({ path: join(shots, '9-wizard-2.png') });
await next();
const refBefore = await wp.$$eval('.wz .refchip', (els) => els.length);
const depRef = await wp.inputValue('#w-deposit');
await wp.screenshot({ path: join(shots, '9b-wizard-ref.png') });
await wp.fill('#w-deposit', '400'); await wp.press('#w-deposit', 'Tab');
await wp.waitForTimeout(100);
const refAfter = await wp.$$eval('.wz .refchip', (els) => els.length);
check('表紙の選択がかんたん入力に反映され、参考値の印は書き換えると消える',
  famPreset[0] && famPreset[1] === 1 && refBefore === 1 && depRef === '350' && refAfter === 0, `家族２=${famPreset[0]} 子供=${famPreset[1]} 参考値 ${depRef} 印 ${refBefore}→${refAfter}`);
await next();
// 給与は「毎月の手取り＋ボーナス」で聞き、年額にする。円で入れてしまったら知らせる
await wp.fill('#w-sal1-m', '300000'); await wp.press('#w-sal1-m', 'Tab');
await wp.locator('.wznav .btn', { hasText: '次へ' }).tap(); await wp.waitForTimeout(100);
const yenErr = await wp.locator('.wz .vmsg').first().textContent().catch(() => '');
for (const [id, v] of [['#w-sal1-m', '30'], ['#w-sal1-b', '90'], ['#w-sal2-m', '15'], ['#w-sal2-b', '20']]) {
  await wp.fill(id, v); await wp.press(id, 'Tab'); await wp.waitForTimeout(120);
}
const salSum = await wp.$$eval('.wz .wzsum', (els) => els.map((e) => e.textContent.replace(/\s+/g, '')));
check('かんたん入力の給与は、毎月の手取り＋ボーナスから1年の額を出す。円で入れると「万円で」と知らせて先に進まない',
  /万円/.test(yenErr) && /収入/.test(await wp.textContent('.wzt')) && JSON.stringify(salSum) === '["1年で450万円","1年で200万円"]', `${yenErr} / ${salSum}`);
await next();
await wp.waitForSelector('.wz .ppres');
const wzPen = await wp.$$eval('.wz .ppres b', (els) => els.map((e) => parseFloat(e.textContent)));
const wzPension = await wp.inputValue('#w-pension');
await wp.screenshot({ path: join(shots, '9c-wizard-pension.png') });
check('かんたん入力の年金は、入れた給与から自動で見込み（2人分）、額を入れなくても先に進める',
  wzPen.length === 2 && wzPen.every((v) => v > 100 && v < 300) && wzPension === '', `${wzPen.join('・')} / 入力=${wzPension}`);
await next();
// 支出は1か月の額で聞く（1年分は12倍）
for (const [id, v] of [['#w-living-m', '23.5'], ['#w-housing-m', '11']]) {
  await wp.fill(id, v); await wp.press(id, 'Tab'); await wp.waitForTimeout(120);
}
const expSum = await wp.$$eval('.wz .wzsum', (els) => els.map((e) => e.textContent.replace(/\s+/g, '')));
check('かんたん入力の支出は1か月の額で入れ、1年の額（12倍）を添える', expSum[0] === '1年で282万円' && expSum[1] === '1年で132万円', `${expSum}`);
const wzOverflow = await wp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await wp.screenshot({ path: join(shots, '10-wizard-6.png') });
await next();
await wp.waitForSelector('#chart');
const wzCols = await wp.$$eval('table.cf thead th', (ths) => ths.length - 1);
const wzHero = await wp.textContent('.hero');
check('かんたん入力を終えると、そのプランのCF表が開く（2026〜1986+95年）', wzCols === 2081 - 2026 + 1 && /2081年/.test(wzHero) && wzOverflow <= 0, `${wzCols}列 ${wzHero.slice(0, 30)}`);
const guideItems = await wp.$$eval('#cf .guide:not(.fix) .gi .gt', (els) => els.map((e) => e.textContent));
await wp.screenshot({ path: join(shots, '10b-guide.png') });
check('CF表の上に、選んだ気になることに合わせた「次の一歩」が出る', JSON.stringify(guideItems) === '["教育費を確かめる","積立投資の効果を見る","節約の効果を見る"]', guideItems.join(' / '));
await wp.reload();
await wp.waitForSelector('#seg-input');
await go(wp, '#seg-input');
await wp.waitForSelector('#f-start');
const kept = await wp.inputValue('#f-asset-1-amt');
check('作ったプランは再読み込みしても残り、表紙はもう出ない', kept === '400' && (await wp.locator('.cover').count()) === 0, `普通預金等=${kept}`);

// プランの一覧：記入例とかんたん入力で作ったプランがあり、切り替え・名前の変更・複製・削除ができる
await go(wp, '#planbtn');
await wp.waitForSelector('.sheet');
const planNames = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
await wp.screenshot({ path: join(shots, '12-plans.png') });
await wp.fill('#f-planname', 'うちの家計');
await wp.press('#f-planname', 'Tab');
await wp.waitForTimeout(100);
await wp.locator('.sheet .btn', { hasText: '複製' }).tap();
await wp.waitForTimeout(100);
const afterDup = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
const topName = await wp.textContent('#planname');
check('かんたん入力でプランを作ると、書き換えていない記入例は一覧から外れる', JSON.stringify(planNames) === '["わが家"]', `${planNames}`);
check('プランの名前を変えて複製できる', JSON.stringify(afterDup) === '["うちの家計","うちの家計のコピー"]' && topName === 'うちの家計のコピー', `${planNames} → ${afterDup} / 表示中=${topName}`);
await wp.locator('.pl', { hasText: 'うちの家計のコピー' }).locator('button.del').tap();
await wp.waitForTimeout(50);
await wp.locator('.plconfirm .btn', { hasText: '削除する' }).tap();
await wp.waitForTimeout(100);
const afterDel = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
check('削除は確認してから行う', JSON.stringify(afterDel) === '["うちの家計"]', `${afterDel}`);
// 記入例は表紙から、今のプランを残したまま開ける
await wp.locator('.sheet .btn', { hasText: '表紙' }).tap();
await wp.waitForSelector('.cover');
await wp.locator('.cvtop .btn', { hasText: '保存したプランの続きから' }).waitFor();
await wp.locator('.cvalt .btn', { hasText: '記入例' }).tap();
await wp.waitForSelector('#f-start');
const withEx = await wp.evaluate(() => JSON.parse(localStorage.getItem('lifeplan.v2')).plans.map((p) => p.name));
check('表紙の「記入例を見てみる」で、記入例が別のプランとして開く', JSON.stringify(withEx) === '["うちの家計","記入例"]' && (await wp.textContent('#planname')) === '記入例', `${withEx}`);
await go(wp, '#planbtn');
await wp.waitForSelector('.sheet');
await wp.locator('.pl .pick', { hasText: 'うちの家計' }).tap();
await wp.waitForTimeout(150);
const sheetClosed = (await wp.locator('.sheet').count()) === 0;
const exampleEnd = await wp.textContent('#planname');
check('プランを選ぶと切り替わり、一覧が閉じる', sheetClosed && exampleEnd === 'うちの家計', exampleEnd);

// 比較：2つのプランの推移と主な数字を並べる
await go(wp, '#seg-cmp');
await wp.waitForSelector('#cmpchart');
const lines = await wp.$$eval('#cmpchart path', (els) => els.length);
const heads = await wp.$$eval('table.cmpt thead th', (els) => els.map((e) => e.textContent).filter(Boolean));
const diffs = await wp.$$eval('table.cmpt .df.up, table.cmpt .df.down', (els) => els.length);
const cmpOverflow = await wp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await wp.locator('#cmpchart').scrollIntoViewIfNeeded();
const cbox = await wp.locator('#cmpchart').boundingBox();
await wp.touchscreen.tap(cbox.x + cbox.width * 0.6, cbox.y + cbox.height * 0.5);
await wp.waitForTimeout(100);
const ctip = await wp.locator('#cmptip').textContent();
check('比較画面に2本の推移・差つきの表・タップで年ごとの値が出る', lines === 2 && JSON.stringify(heads) === '["うちの家計","記入例"]' && diffs >= 3 && cmpOverflow <= 0 && /年うちの家計[\d,−]+万記入例/.test(ctip), `lines=${lines} heads=${heads} diffs=${diffs} tip=${ctip}`);
await wp.screenshot({ path: join(shots, '13-compare.png'), fullPage: false });
await wp.locator('.tablecard').scrollIntoViewIfNeeded();
await wp.screenshot({ path: join(shots, '14-compare-table.png') });

// バックアップ：すべてのプランをファイルに保存し、そのファイルから読み込める
await go(wp, '#planbtn');
await wp.waitForSelector('.sheet');
const [dl] = await Promise.all([wp.waitForEvent('download'), wp.locator('.bk .btn', { hasText: 'ファイルに保存' }).tap()]);
const dlPath = join(shots, dl.suggestedFilename());
await dl.saveAs(dlPath);
const saved = JSON.parse(readFileSync(dlPath, 'utf8'));
check('バックアップのファイルにすべてのプランが入る', /^lifeplan-backup-\d{8}\.json$/.test(dl.suggestedFilename()) && saved.plans.length === 2 && saved.plans[0].name === 'うちの家計', `${dl.suggestedFilename()} plans=${saved.plans.map((p) => p.name)}`);
await wp.setInputFiles('#f-backup-file', dlPath);
await wp.waitForSelector('.bk .plconfirm');
await wp.screenshot({ path: join(shots, '15-backup.png') });
await wp.locator('.bk .btn', { hasText: '追加する' }).tap();
await wp.waitForTimeout(150);
const afterImport = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
check('バックアップを読み込むと、今のプランを残したまま追加される', JSON.stringify(afterImport) === '["うちの家計","記入例","うちの家計（2）","記入例（2）"]', `${afterImport}`);
const importedDansin = await wp.evaluate(() => JSON.parse(localStorage.getItem('lifeplan.v2')).plans.find((p) => p.name === '記入例（2）').state.housing.filter((r) => r.dansin === true).length);
check('バックアップを読み込んでも、住宅費の団信の印（true）が残る', importedDansin === 2, `団信=${importedDansin}`);

// 細工されたファイルを読み込んでも、文字として表示されるだけで画面に要素が入り込まない
const evil = JSON.parse(JSON.stringify(saved.plans.find((p) => p.name === '記入例')));
evil.name = '<img src=x id=pwn1>';
evil.state.living[1].year = '"><img src=x id=pwn2>';
evil.state.living[1].id = "1);document.title='pwn';(";
const evilPath = join(shots, 'evil.json');
writeFileSync(evilPath, JSON.stringify({ plans: [evil] }));
await wp.setInputFiles('#f-backup-file', evilPath);
await wp.waitForSelector('.bk .plconfirm');
await wp.locator('.bk .btn', { hasText: '追加する' }).tap();
await wp.waitForTimeout(150);
await wp.locator('.sheethead button').tap();
await wp.waitForTimeout(100);
await go(wp, '#seg-input');
await wp.waitForTimeout(150);
await go(wp, '#seg-cmp');
await wp.waitForTimeout(150);
const pwned = await wp.evaluate(() => !!document.getElementById('pwn1') || !!document.getElementById('pwn2') || document.title === 'pwn');
const shownName = await wp.textContent('#planname');
check('細工されたファイルでも要素が入り込まない', !pwned && shownName === '<img src=x id=pwn1>', `pwned=${pwned} name=${shownName}`);

// 次の一歩：ボタン1つで「積立なし」「1割節約」のプランを作って比較画面で並べる
await go(wp, '#seg-cf');
await wp.waitForSelector('#cf .guide');
await wp.locator('#cf .guide .btn', { hasText: '積立なしと比べる' }).tap();
await wp.waitForSelector('#cmpchart');
const g1 = await wp.$$eval('table.cmpt thead th', (els) => els.map((e) => e.textContent).filter(Boolean));
const g1End = await wp.$$eval('table.cmpt tbody tr:first-child td b', (els) => els.map((e) => e.textContent));
await go(wp, '#seg-cf');
await wp.waitForSelector('#cf .guide');
await wp.locator('#cf .guide .btn', { hasText: '1割節約したプランと比べる' }).tap();
await wp.waitForSelector('#cmpchart');
const g2 = await wp.$$eval('table.cmpt thead th', (els) => els.map((e) => e.textContent).filter(Boolean));
await wp.screenshot({ path: join(shots, '10c-guide-compare.png') });
await go(wp, '#seg-cf');
const doneMarks = await wp.$$eval('#cf .guide .gi.done', (els) => els.length);
check('次の一歩のボタンで、比べるプランができて比較画面に並ぶ',
  JSON.stringify(g1) === '["うちの家計","うちの家計（積立なし）"]' && g1End[0] !== g1End[1] &&
  JSON.stringify(g2) === '["うちの家計","うちの家計（1割節約）"]' && doneMarks === 2,
  `${g1} ${g1End} / ${g2} / 済み${doneMarks}`);
await fresh.close();

// 手取りの計算：年収・配偶者の扶養・子供の年齢（家族構成から自動）から、Excelの手取額計算シートと同じ式で出す
{
  await go(page, '#tabs .tab[data-k="income"]');
  await page.locator('.toggle', { hasText: '手取りを計算する' }).first().tap();
  await page.waitForSelector('#f-th-1-income');
  await page.fill('#f-th-1-income', '600'); await page.press('#f-th-1-income', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const base = await page.textContent('.calcbox.th .calcresult');
  const under16 = await page.locator('.calcbox.th .deprow.off').count();
  await page.locator('.thsp button', { hasText: '扶養している' }).tap(); await page.waitForTimeout(100);
  await page.fill('#f-th-1-spinc', '100'); await page.press('#f-th-1-spinc', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const withSpouse = await page.textContent('.calcbox.th .calcresult');
  // 第一子を17歳にすると、扶養控除（38万円）の対象として自動でチェックが付く
  await go(page, '#tabs .tab[data-k="basic"]');
  await page.fill('#f-fam-3-birth', '20090601'); await page.press('#f-fam-3-birth', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  await go(page, '#tabs .tab[data-k="income"]');
  await page.waitForTimeout(100);
  const kid17 = await page.locator('#f-th-1-dep-3').isChecked();
  const withKid = await page.textContent('.calcbox.th .calcresult');
  await page.locator('.calcbox.th').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, '18-takehome.png') });
  await page.locator('.calcbox.th .btn.block').tap(); await page.waitForTimeout(150);
  const row1 = await page.inputValue('#f-sal-1-1-amt');
  check('手取り：Excelと同じ式（600万→461.55万）、配偶者の扶養（年収100万）で469.15万、17歳の子を自動で扶養に入れて476.7万、1行目に入る',
    /461\.55/.test(base) && under16 === 2 && /469\.15/.test(withSpouse) && kid17 && /476\.7/.test(withKid) && row1 === '476.7',
    `${base.trim()} / 16歳未満${under16} / ${withSpouse.trim()} / 17歳=${kid17} ${withKid.trim()} / 1行目=${row1}`);
  await page.locator('#toast button').tap(); await page.waitForTimeout(100);
  await go(page, '#tabs .tab[data-k="basic"]');
  await page.fill('#f-fam-3-birth', '20220101'); await page.press('#f-fam-3-birth', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  check('手取りの反映も「元に戻す」で戻せる', (await page.inputValue('#f-sal-1-1-amt')) === '500');
  // 健康保険の種類・年齢で社会保険料率が変わり、去年の年収で住民税、実額の社会保険料も使える
  await go(page, '#tabs .tab[data-k="income"]');
  if (!(await page.locator('#f-th-1-last').count())) await page.locator('.toggle', { hasText: '手取りを計算する' }).first().tap();
  await page.waitForSelector('#f-th-1-last');
  const num = async () => parseFloat((await page.textContent('.calcbox.th .calcresult')).replace(/[^0-9.]/g, ''));
  const sec = async () => (await page.textContent('.calcbox.th .calcsec')).trim();
  const excel = await num(); const excelSec = await sec();
  await page.locator('.thsp button', { hasText: '協会けんぽ' }).tap(); await page.waitForTimeout(150);
  const kyokai = await num(); const kyokaiSec = await sec();
  const ageHint = await page.locator('.calcbox.th .hint', { hasText: '介護保険料' }).count();
  await page.fill('#f-th-1-last', '550'); await page.press('#f-th-1-last', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const withLast = await num();
  await page.fill('#f-th-1-social', '80'); await page.press('#f-th-1-social', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const withSocial = await num(); const socialSec = await sec();
  check('手取り：協会けんぽ・35歳で14.7％（Excelの15.5％より手取りが増える）、去年の年収が低いと住民税が下がり、実額の社会保険料を優先',
    /15\.5％/.test(excelSec) && /14\.7％/.test(kyokaiSec) && kyokai > excel && ageHint === 1 && withLast > kyokai && /実額/.test(socialSec) && withSocial !== withLast,
    `${excel}(${excelSec}) → ${kyokai}(${kyokaiSec}) → 去年550 ${withLast} → 実額80 ${withSocial}(${socialSec})`);
}

// 源泉徴収票から：欄の金額（円）をそのまま入れると、実際の金額で手取りが出る
{
  await page.locator('.thmode button', { hasText: '源泉徴収票から出す' }).tap();
  await page.waitForSelector('#f-th-1-gPay');
  for (const [k, v] of [['gPay', '8,000,000'], ['gAfter', '6100000'], ['gDeduct', '２００００００'], ['gTax', '350000'], ['gSocial', '1150000'], ['gSmall', '120000']]) {
    await page.fill('#f-th-1-' + k, v); await page.press('#f-th-1-' + k, 'Tab');
  }
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const est = await page.textContent('.calcbox.th .calcresult');
  const shown = await page.inputValue('#f-th-1-gPay');
  await page.fill('#f-th-1-gResident', '380000'); await page.press('#f-th-1-gResident', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const act = await page.textContent('.calcbox.th .calcresult');
  await page.fill('#f-th-1-commute', '20,000'); await page.press('#f-th-1-commute', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const withCommute = await page.textContent('.calcbox.th .calcresult');
  await page.locator('.thdeft').tap(); await page.waitForTimeout(100);
  const defRows = await page.locator('.thdef tbody tr').count();
  const defText = await page.textContent('.thdef');
  await page.locator('.calcbox.th').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, '18b-slip.png') });
  await page.locator('.calcbox.th .btn.block').tap(); await page.waitForTimeout(150);
  const row = await page.inputValue('#f-sal-1-1-amt');
  check('手取り：源泉徴収票の金額（円・カンマや全角も可）から、住民税を見積もって619.8万、住民税38万円で624万、通勤手当（月2万円）を足して648万、1行目に入る',
    /619\.8/.test(est) && shown === '8,000,000' && /624/.test(act) && /648/.test(withCommute) && row === '648', `${est.trim()} / ${shown} / ${act.trim()} / ${withCommute.trim()} / 1行目=${row}`);
  check('手取りの考え方（含めるもの・含めないもの）を表で見られる', defRows === 9 && /DCの会社拠出/.test(defText) && /退職金/.test(defText), `${defRows}行`);
  await page.locator('#toast button').tap(); await page.waitForTimeout(100);
}

// 家計簿：月ごとに入れ、残高と照らし合わせ、1年の表にまとまり、ライフプランに反映できる
{
  await go(page, '#seg-book');
  await page.waitForSelector('.bkempty');
  const emptyText = await page.textContent('.bkempty');
  await page.locator('.bkempty .btn.big').tap();
  await page.waitForSelector('.bksum');
  const thisMonth = new Date().getMonth();
  // 1か月目：食費（全角・カンマ付きでも可）と給与を入れる
  const food = await page.$$eval('.bkrow', (rows) => { const r = rows.find((x) => x.querySelector('.nm') && /食費/.test(x.querySelector('.nm').textContent)); return r && r.querySelector('input').id; });
  const sal = await page.$$eval('.bkrow', (rows) => { const r = rows.find((x) => x.querySelector('.nm') && /給与手取り（夫）/.test(x.querySelector('.nm').textContent)); return r && r.querySelector('input').id; });
  await page.fill(`#${food}`, '５２，０００'); await page.press(`#${food}`, 'Tab');
  await page.fill(`#${sal}`, '300000'); await page.press(`#${sal}`, 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const sumText = await page.textContent('.bksum');
  const foodShown = await page.inputValue(`#${food}`);
  check('家計簿：はじめ方の案内から始め、月の金額を入れると収支が出る（全角・カンマも可）',
    /データは端末の外に送りません/.test(emptyText) && /＋248,000/.test(sumText) && foodShown === '52,000', `${sumText.slice(0, 40)} / 食費=${foodShown}`);
  await page.screenshot({ path: join(shots, '20-book-month.png') });
  const pv = await page.textContent('.pvcard').catch(() => '');
  check('家計簿：月の収支を、表示中のプランの予定（1か月あたり・今年の進み具合）とくらべる', /「記入例」の予定とくらべると/.test(pv) && /予定より[\d,]+円(多く|少なめ)/.test(pv) && /今年の予定/.test(pv), pv.replace(/\s+/g, ' ').slice(0, 100));

  // 口座残高を入れると、記録との差額が0なら「一致」
  // 前年末の残高を編集で入れる（100万円）→ 今月末の残高に、前年末＋今月の収支を入れる
  await page.locator('.bkedit .btn').tap(); await page.waitForTimeout(100);
  const acs = await page.$eval('#bkg-accounts input[id^="f-bk-acs-"]', (e) => e.id);
  await page.fill(`#${acs}`, '1000000'); await page.press(`#${acs}`, 'Tab');
  await page.evaluate(() => document.activeElement.blur());
  await page.locator('.bkedit .btn').tap(); await page.waitForTimeout(100);
  const ac = await page.$eval('#bkg-accounts input[id^="f-bk-ac-"]', (e) => e.id);
  await page.fill(`#${ac}`, '1248000'); await page.press(`#${ac}`, 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const diffOk = await page.textContent('.diffline').catch(() => '');
  const chipOk = await page.locator(`#bkm-${thisMonth} .ok`).count();
  check('家計簿：口座残高が「前年末＋収支」と一致すると、そう知らせ、月にも印が付く', /一致しています/.test(diffOk) && chipOk === 1, diffOk);

  // 次の月：前の月と同じ金額を入れるボタン
  if (thisMonth < 11) {
    await page.locator(`#bkm-${thisMonth + 1}`).tap(); await page.waitForTimeout(150);
    await page.locator('.bkcopy').tap(); await page.waitForTimeout(150);
    const copied = await page.inputValue(`#${food}`);
    const review = await page.textContent('.bkreview').catch(() => '');
    check('家計簿：前の月と同じ金額を、空いている欄に入れられる。ふりかえりも出る', copied === '52,000' && /2か月続けて記録しています/.test(review), `${copied} / ${review.slice(0, 60)}`);
    await page.locator(`#bkm-${thisMonth}`).tap(); await page.waitForTimeout(100);
  }

  // 項目の編集：足して、外して、元に戻す
  await page.locator('.bkedit .btn').tap(); await page.waitForTimeout(100);
  const before = await page.$$eval('#bkg-1 .bkrow', (e) => e.length);
  await page.locator('#bkg-1 .addwrap .btn').tap(); await page.waitForTimeout(100);
  const added = await page.$$eval('#bkg-1 .bkrow', (e) => e.length);
  await page.locator('#bkg-1 .bkrow').last().locator('button.del').tap(); await page.waitForTimeout(100);
  const removed = await page.$$eval('#bkg-1 .bkrow', (e) => e.length);
  await page.locator('#toast button').tap(); await page.waitForTimeout(100);
  const undone = await page.$$eval('#bkg-1 .bkrow', (e) => e.length);
  await page.locator('.bkedit .btn').tap(); await page.waitForTimeout(100);
  check('家計簿：項目を足し・外し・元に戻せる', added === before + 1 && removed === before && undone === before + 1, `${before}→${added}→${removed}→${undone}`);

  // 家計簿の入力欄にもすべて読み上げ用の名前がある
  const unnamedBook = await page.$$eval('#bookview input, #bookview select', (els) => els.filter((e) => e.offsetParent && !e.getAttribute('aria-label') && !(e.id && document.querySelector(`label[for="${e.id}"]`))).map((e) => e.id));
  check('家計簿の入力欄すべてに読み上げ用の名前がある', unnamedBook.length === 0, unnamedBook.slice(0, 4).join(', '));

  // 1年の表とプランへの反映
  await page.locator('.bkmodes button', { hasText: '1年の表' }).tap(); await page.waitForTimeout(150);
  const totals = await page.textContent('.yeartotals');
  const bkOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await page.screenshot({ path: join(shots, '21-book-year.png') });
  await page.locator('.bkmodes button', { hasText: 'プランへ' }).tap(); await page.waitForTimeout(150);
  const rel = await page.textContent('.bkrel .lv');
  await page.screenshot({ path: join(shots, '22-book-plan.png') });
  const months = thisMonth < 11 ? 2 : 1;
  const living = await page.$eval('.maprow:has(#f-bkp-living) .vals b', (e) => e.textContent);
  await page.locator('.bkmap .btn.big').tap();
  await page.waitForSelector('#chart');
  const basis = await page.textContent('.basis').catch(() => '');
  await go(page, '#seg-input');
  const planLiving = await page.inputValue('#f-living-1-amt');
  const inc = (300000 * months).toLocaleString('ja-JP'), exp = (52000 * months).toLocaleString('ja-JP'), bal = (248000 * months).toLocaleString('ja-JP');
  check('家計簿：1年の表に月ごとの記録が集計される', totals.includes(inc) && totals.includes(exp) && totals.includes('＋' + bal), `${totals.replace(/\s+/g, ' ').trim()}`);
  check('家計簿からプランへ：基本生活費＝食費52,000円×12＝62.4万円、信頼度と根拠が出る',
    living === '62.4' && planLiving === '62.4' && /ひとまずの目安/.test(rel) && new RegExp(`${months}か月分`).test(basis) && bkOverflow <= 0,
    `反映=${living} プラン=${planLiving} 信頼度=${rel} ${basis.slice(0, 40)}`);
  await page.locator('#toast button').tap(); await page.waitForTimeout(150);   // 反映は元に戻して、以降のテストに影響させない
  const restored = await page.inputValue('#f-living-1-amt');
  check('プランへの反映も「元に戻す」で戻せる', restored === '360', restored);
}

// DC（会社拠出）の見込額：Excelの投資シミュレーションと同じ式で計算し、退職一時金の行に入れる
{
  await go(page, '#seg-input');
  await go(page, '#tabs .tab[data-k="pension"]');
  await page.locator('.toggle', { hasText: 'DC（会社拠出）' }).tap(); await page.waitForTimeout(150);
  for (const [id, v] of [['#f-dc-start', '100'], ['#f-dc-contrib', '36'], ['#f-dc-rate', '5'], ['#f-dc-until', '65'], ['#f-dc-receive', '65']]) { await page.fill(id, v); await page.press(id, 'Tab'); }
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const res = await page.textContent('.calcbox.dc .calcresult');
  await page.fill('#f-dc-target', '2000'); await page.press('#f-dc-target', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const needText = await page.textContent('.calcbox.dc');
  const before = await page.locator('[id^="f-lump-"][id$="-amt"]').count();
  await page.locator('.calcbox.dc .btn.block').tap(); await page.waitForTimeout(150);
  const amts = await page.$$eval('[id^="f-lump-"][id$="-amt"]', (els) => els.map((e) => e.value));
  check('DC（会社拠出）：Excelの記入例と同じ条件で65歳に2,893万円、目標からの逆算も出て、一時収入の行に入る',
    /2,893/.test(res) && /毎年 \d/.test(needText) && amts.length === before + 1 && amts.includes('2893'), `${res.trim()} / ${amts.join(',')}`);
  await page.locator('#toast button').tap(); await page.waitForTimeout(150);
  check('DCの反映も「元に戻す」で戻せる', (await page.locator('[id^="f-lump-"][id$="-amt"]').count()) === before);
}

// 給与明細：明細を入れると手取りが出て、前の月の内容を写せ、家計簿とプランに入れられる
{
  await go(page, '#seg-book');
  await page.locator('.bkmodes button', { hasText: '給与明細' }).tap(); await page.waitForTimeout(150);
  await page.locator('.bkempty .btn.big').tap(); await page.waitForTimeout(150);
  await page.locator('#bkm-0').tap(); await page.waitForTimeout(100);
  for (const [k, v] of [['base', '300000'], ['commute', '10,000'], ['health', '15000'], ['pension', '27450'], ['employ', '1800'], ['incomeTax', '7000'], ['resident', '15000'], ['voluntary', '10000']]) {
    await page.fill('#f-py-' + k, v); await page.press('#f-py-' + k, 'Tab');
  }
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const jan = await page.textContent('.bksum .v');
  const io = await page.textContent('.bksum .io');
  await page.locator('#bkm-1').tap(); await page.waitForTimeout(100);
  await page.locator('.bkcopy').tap(); await page.waitForTimeout(150);
  const copiedBase = await page.inputValue('#f-py-base');
  await page.fill('#f-py-resident', '16000'); await page.press('#f-py-resident', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(150);
  const tips = await page.textContent('.bkreview');
  await page.screenshot({ path: join(shots, '23-pay.png') });
  check('給与明細：手取り＝支給−社会保険料−税（通勤費・財形を含む）243,750円、振込233,750円。前の月を写せて、住民税の変化を説明する',
    /243,750/.test(jan) && /233,750/.test(io) && copiedBase === '300,000' && /住民税が 15,000円 → 16,000円/.test(tips), `${jan} / ${io.trim()} / ${copiedBase} / ${tips.trim().slice(0, 60)}`);
  await page.locator('.pybook .btn.block').tap(); await page.waitForTimeout(150);
  const inBook = await page.textContent('.pybook');
  await page.locator('.bkmodes button', { hasText: '月ごと' }).tap(); await page.waitForTimeout(150);
  await page.locator('#bkm-1').tap(); await page.waitForTimeout(150);
  const incVals = await page.$$eval('#bkg-income input', (els) => els.map((e) => e.value));
  const auto = await page.textContent('#bkg-income');
  const volVals = await page.$$eval('#bkg-6 input', (els) => els.map((e) => e.value));
  check('給与明細から家計簿へ：振込額を収入に、財形・DC等を「給与天引き」の支出に入れ、収入にも天引き分を足す',
    /入っています/.test(inBook) && incVals.includes('232,750') && volVals.includes('10,000') && /給与天引き/.test(auto) && /10,000/.test(auto), `${incVals.join(',')} / ${volVals.join(',')}`);
  await page.locator('.bkmodes button', { hasText: '給与明細' }).tap(); await page.waitForTimeout(150);
  await page.locator('.pyyear .btn.block').tap(); await page.waitForTimeout(150);
  await go(page, '#seg-input');
  await go(page, '#tabs .tab[data-k="income"]');
  const planSal = await page.inputValue('#f-sal-1-1-amt');
  check('給与明細からプランへ：記録した2か月の平均×12で、手取り291.9万円を給与に入れる', planSal === '291.9', planSal);
  await page.locator('#toast button').tap(); await page.waitForTimeout(150);
}

// 現金化の自動調整：オンにすると、老後の普通預金等が保ちたい額に保たれ、毎年の額は未来の表に出る
{
  await go(page, '#seg-input');
  await go(page, '#tabs .tab[data-k="invest"]');
  await page.locator('#card-autoDraw button', { hasText: '自動で調整する' }).tap(); await page.waitForTimeout(200);
  await page.waitForSelector('#f-ad-target');
  const saved = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); return s.plans.find((p) => p.id === s.activeId).state.autoDraw; });
  await page.fill('#f-ad-target', '1000'); await page.press('#f-ad-target', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const st1 = await page.textContent('#card-autoDraw .vmsg');
  const buckets = await page.$$eval('#card-autoDraw .ddseg', (els) => els.length);
  await page.locator('#card-autoDraw').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, '26-autodraw.png') });
  await page.fill('#f-ad-target', '3000'); await page.press('#f-ad-target', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const st2 = await page.textContent('#card-autoDraw .vmsg');
  check('現金化の自動調整：オンにすると保てる年齢と10年ごとの額が出て、保ちたい額が高すぎれば使い切る年を知らせる',
    /保てます/.test(st1) && buckets >= 2 && /使い切り/.test(st2) && saved.target === 1500 && saved.startAge > 0, `${st1.trim()} / ${buckets} / ${st2.trim()} / ${JSON.stringify(saved)}`);
  await page.locator('#card-autoDraw button', { hasText: '自分で決める' }).tap(); await page.waitForTimeout(150);
}

// Excelに書き出す：CF表とグラフ入りの .xlsx が保存される
{
  await go(page, '#seg-cf');
  await page.waitForSelector('#cfview .xlcard');
  const [xl] = await Promise.all([page.waitForEvent('download'), page.locator('#cfview .xlcard .btn').tap()]);
  const xlPath = join(shots, 'export.xlsx');
  await xl.saveAs(xlPath);
  const buf = readFileSync(xlPath);
  const msg = await page.textContent('#cfview .xlcard .vmsg');
  const text = buf.toString('latin1');
  check('Excelに書き出す：グラフ入りの.xlsx（サマリー・CF表）が保存される', /^lifeplan_\d{8}\.xlsx$/.test(xl.suggestedFilename()) && buf.slice(0, 2).toString() === 'PK' &&
    text.includes('xl/charts/chart2.xml') && text.includes('xl/worksheets/sheet2.xml') && /ダウンロード/.test(msg), `${xl.suggestedFilename()} ${buf.length}B ${msg}`);
}

// 保障と家計簿もExcelに書き出せる
{
  await go(page, '#seg-risk');
  await page.waitForSelector('#riskview .xlcard');
  const [rx] = await Promise.all([page.waitForEvent('download'), page.locator('#riskview .xlcard .btn').tap()]);
  const rPath = join(shots, 'export-risk.xlsx'); await rx.saveAs(rPath);
  const rt = readFileSync(rPath).toString('latin1');
  await go(page, '#seg-book');
  await page.locator('.bkmodes button', { hasText: '1年の表' }).tap(); await page.waitForTimeout(200);
  const [bx] = await Promise.all([page.waitForEvent('download'), page.locator('#bookview .xlcard .btn').tap()]);
  const bPath = join(shots, 'export-book.xlsx'); await bx.saveAs(bPath);
  const bt = readFileSync(bPath).toString('latin1');
  await page.locator('.bkmodes button', { hasText: '月ごと' }).tap(); await page.waitForTimeout(150);
  check('保障（もしもの場合）と家計簿（1年の表）も、グラフ入りのExcelに書き出せる',
    /^lifeplan_hosho_\d{8}\.xlsx$/.test(rx.suggestedFilename()) && rt.startsWith('PK') && rt.includes('xl/worksheets/sheet3.xml') && rt.includes('xl/charts/chart1.xml') &&
    /^kakeibo_\d{4}_\d{8}\.xlsx$/.test(bx.suggestedFilename()) && bt.startsWith('PK') && bt.includes('xl/charts/chart1.xml'),
    `${rx.suggestedFilename()} ${bx.suggestedFilename()}`);
}

// 保障：もしもの場合の必要保障額（CF表で計算・かんたん計算）。団信の印、保険金で足りるか、プランとして保存
{
  await go(page, '#seg-input');
  await go(page, '#tabs .tab[data-k="expense"]');
  const dansinBoxes = await page.locator('#card-housing .dansin input[type=checkbox]').count();
  const dansinOn = await page.locator('#card-housing .dansin input[type=checkbox]:checked').count();
  await go(page, '#seg-risk');
  await page.waitForSelector('.rkres');
  const need0 = parseInt((await page.textContent('.rkres .row b')).replace(/[^0-9]/g, ''), 10);
  const steps = await page.locator('.rksteps span').count();
  await page.fill('#f-rk-insurance', String(need0)); await page.press('#f-rk-insurance', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const enough = await page.textContent('.rkres');
  await page.fill('#f-rk-insurance', String(Math.max(0, need0 - 500))); await page.press('#f-rk-insurance', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const rest = await page.textContent('.rkres');
  await page.screenshot({ path: join(shots, '24-risk.png') });
  check('保障（CF表で計算）：団信の印があり、必要保障額と遺族年金の移り変わりが出て、保険金を入れると足りるか・あといくらかがわかる',
    dansinBoxes >= 2 && dansinOn >= 2 && need0 > 0 && steps >= 3 && /足りています/.test(enough) && /あと 500/.test(rest),
    `団信=${dansinOn}/${dansinBoxes} 必要=${need0} 段階=${steps} / ${enough.replace(/\s+/g, ' ').slice(0, 60)} / ${rest.replace(/\s+/g, ' ').slice(0, 80)}`);
  await page.locator('.rkmode button', { hasText: 'かんたん計算' }).tap(); await page.waitForTimeout(200);
  const simple0 = parseInt((await page.textContent('.rkres .row b')).replace(/[^0-9]/g, ''), 10);
  await page.fill('#f-rks-retirement', '1000'); await page.press('#f-rks-retirement', 'Tab');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
  const simple1 = parseInt((await page.textContent('.rkres .row b')).replace(/[^0-9]/g, ''), 10);
  const edited = await page.locator('.rkcard .calcrow.edited').count();
  await page.screenshot({ path: join(shots, '25-risk-simple.png') });
  check('保障（かんたん計算）：プランから入れた値で必要保障額が出て、死亡退職金1,000万円を入れると1,000万円減り、書き換えた欄に印が付く',
    simple0 > 0 && simple0 - simple1 === Math.min(1000, simple0) && edited === 1, `${simple0} → ${simple1} 印=${edited}`);
  await page.locator('.rkcard .btn.ghost', { hasText: 'プランから入れた値に戻す' }).tap(); await page.waitForTimeout(150);
  await page.locator('.rkmode button', { hasText: 'プランで計算' }).tap(); await page.waitForTimeout(200);
  const plansBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('lifeplan.v2')).plans.length);
  await page.locator('.rkcard .btn.block', { hasText: 'プランとして保存' }).tap();
  await page.waitForSelector('#chart');
  const saved = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); return [s.plans.length, s.plans.find((p) => p.id === s.activeId).name]; });
  check('保障：もしもの場合をプランとして保存すると、未来の表で見られる', saved[0] === plansBefore + 1 && /もしも/.test(saved[1]), saved.join(' '));
  // 元のプランに戻す（以降のテストのため）
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); A.planSwitch(s.plans.find((p) => p.name === '記入例').id); });
  await page.waitForTimeout(150);
  await go(page, '#seg-input');
}

// 品質テストで見つけた点の再発防止
{
  // 入力欄にはすべて読み上げ用の名前がある
  const unnamed = await page.$$eval('#content input, #content select, #content textarea', (els) => els
    .filter((e) => e.offsetParent && e.type !== 'file' && !e.getAttribute('aria-label') && !(e.id && document.querySelector(`label[for="${e.id}"]`)))
    .map((e) => e.id));
  check('入力欄・選択欄すべてに読み上げ用の名前がある', unnamed.length === 0, unnamed.slice(0, 5).join(', '));
  // 家族１の続柄は変えられない
  await page.locator('#content .member button.del').first().tap();
  await page.waitForTimeout(100);
  const relSelect = await page.locator('#f-fam-1-rel').count();
  await page.locator('#content .member button.del').first().tap();
  check('家族１の続柄は変えられない（家計の中心のまま）', relSelect === 0);
  // CF表と比較に、試算であることの注意書きがある
  await go(page, '#seg-cf');
  await page.waitForSelector('#chart');
  const disc = await page.locator('#cf .disclaimer').textContent().catch(() => '');
  const tableFocusable = await page.getAttribute('.tablewrap', 'tabindex');
  await go(page, '#seg-input');
  check('CF表に試算の注意書きがあり、表はキーボードでも横に動かせる', /試算/.test(disc) && tableFocusable === '0', disc.slice(0, 30));
}
for (const [label, init, expect] of [
  ['保存できない設定', () => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); }, /保存できません/],
  ['読めない保存データ', () => { if (!sessionStorage.getItem('t')) { localStorage.setItem('lifeplan.v2', '{broken'); sessionStorage.setItem('t', '1'); } }, /読み込めなかった/],
]) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await c.addInitScript(init);
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url);
  await p.waitForSelector('.cover');
  const note = await p.locator('.vbanner.notice').textContent().catch(() => '');
  const kept = label === '読めない保存データ' ? await p.evaluate(() => localStorage.getItem('lifeplan.v2.broken')) : '{broken';
  check(`${label}でも開き、その旨を知らせる（読めないデータは消さずに取っておく）`, expect.test(note) && kept === '{broken' && !errs.length, `${note.slice(0, 30)} ${errs.join('/')}`);
  await c.close();
}

// ダークモード
const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const dp = await dark.newPage();
await dp.goto(url + '#cf');
await dp.waitForSelector('#chart');
await dp.waitForTimeout(300);
await dp.screenshot({ path: join(shots, '5-cf-dark.png') });
await dp.goto(url);
await dp.waitForSelector('.cover');
await dp.screenshot({ path: join(shots, '6a-cover-dark.png') });
await dp.locator('.cvalt .btn', { hasText: '記入例' }).tap();
await dp.waitForSelector('#f-start');
await dp.waitForTimeout(300);
await dp.screenshot({ path: join(shots, '6-input-dark.png') });

// 足りなくなるプラン：未来の表で「足りなくならないためには」を計算して示し、ボタンで試せる。保障では、もともと足りない分を分けて示す
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  const fp = await c.newPage();
  fp.on('pageerror', (e) => errors.push(e.message));
  await fp.goto(url);
  await fp.waitForSelector('.cover');
  // 記入例の基本生活費を年20万円ずつ増やす（77歳で足りなくなり、そのとき投資資産がある）
  await fp.evaluate(() => {
    const st = window.LifePlanSample.sample(); st.living.forEach((r) => { r.amount += 20; });
    localStorage.setItem('lifeplan.v2', JSON.stringify({ version: 2, activeId: 1, nextPlanId: 2, plans: [{ id: 1, name: 'うち', state: st }], prefs: { yearMode: 'year', welcomed: true }, book: { years: {}, nextId: 1 } }));
  });
  await fp.reload();
  await go(fp, '#seg-cf');
  await fp.waitForSelector('#fix');
  const fixItems = await fp.$$eval('#fix .gi .gt', (els) => els.map((e) => e.textContent));
  const fixText = await fp.textContent('#fix');
  const sumHead = await fp.textContent('#summary .worst');
  await fp.locator('.alert .alink').tap(); await fp.waitForTimeout(600);
  await fp.screenshot({ path: join(shots, '27-fix.png') });
  check('足りなくなるとき、未来の表に「投資資産を現金化する」「基本生活費を月◯万円減らす」が計算して出る（上のバーは「最大◯万円不足」）',
    JSON.stringify(fixItems) === '["投資資産を現金化する","基本生活費を見直す","ほかに見直せること"]' && /月[\d.]+万円/.test(fixText) && /万円不足/.test(sumHead), `${fixItems} / ${sumHead}`);
  // 生活費を減らしたプランを作って比べると、そのプランは足りなくならない
  await go(fp, '#seg-cf');
  await fp.waitForSelector('#fix');
  await fp.locator('#fix .btn', { hasText: '減らしたプランを作って比べる' }).tap();
  await fp.waitForSelector('#cmpchart');
  const cmpHeads = await fp.$$eval('table.cmpt thead th', (els) => els.map((e) => e.textContent).filter(Boolean));
  const shortRow = await fp.locator('table.cmpt tr', { hasText: '預金が不足する年齢' }).textContent();
  check('「減らしたプランを作って比べる」で、生活費を減らしたプランと並べて比べられ、そのプランは不足しない',
    cmpHeads.length === 2 && /生活費 月[\d.]+万円減/.test(cmpHeads[1]) && /なし/.test(shortRow), `${cmpHeads} / ${shortRow.trim()}`);
  // 自動で現金化すると、足りなくならない
  await go(fp, '#planbtn'); await fp.waitForSelector('.sheet');
  await fp.locator('.pl .nm', { hasText: /^うち$/ }).tap(); await fp.waitForTimeout(150);
  await go(fp, '#seg-cf');
  await fp.waitForSelector('#fix');
  await fp.locator('#fix .btn', { hasText: '自動で現金化する' }).tap(); await fp.waitForTimeout(200);
  const fixedAlert = await fp.locator('#cf .alert').count();
  const ad = await fp.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); return s.plans.find((p) => p.id === s.activeId).state.autoDraw; });
  check('「自動で現金化する」で投資からの現金化がオンになり、足りなくならない（元に戻せる）', fixedAlert === 0 && ad.on === true && /元に戻す/.test(await fp.textContent('#toast')), JSON.stringify(ad));
  // 入力の最後から、未来の表・保障へ進める
  await go(fp, '#seg-input');
  const endBtns = await fp.$$eval('footer.done .btn', (els) => els.map((e) => e.textContent));
  check('入力画面の最後に「未来の表を見る」「もしもの保障を見る」がある', JSON.stringify(endBtns) === '["未来の表を見る","もしもの保障を見る"]', `${endBtns}`);
  // 保障：いつものプランでも足りない分を分けて示す（基本生活費を年60万円ずつ増やしたプラン）
  await fp.evaluate(() => {
    const st = window.LifePlanSample.sample(); st.living.forEach((r) => { r.amount += 60; });
    localStorage.setItem('lifeplan.v2', JSON.stringify({ version: 2, activeId: 1, nextPlanId: 2, plans: [{ id: 1, name: 'うち', state: st }], prefs: { yearMode: 'year', welcomed: true }, book: { years: {}, nextId: 1 } }));
  });
  await fp.reload();
  await go(fp, '#seg-risk');
  await fp.waitForSelector('.rkres');
  const rkText = await fp.textContent('.rkres');
  check('保障：もともと足りないプランでは、必要保障額のうち「万一がなくても足りない分」と「保険で備える目安」を分けて示す', /万一のことがなくても足りない分/.test(rkText) && /保険で備える目安/.test(rkText), rkText.replace(/\s+/g, ' ').slice(0, 120));
  await c.close();
}

// 最後のプランも削除でき、表紙に戻る。「すべて消して最初から」は家計簿も消し、元に戻せる
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  const xp = await c.newPage();
  xp.on('pageerror', (e) => errors.push(e.message));
  await xp.goto(url);
  await xp.evaluate(() => {
    const st = window.LifePlanSample.sample();
    const book = { years: {}, nextId: 1 }; book.years['2026'] = window.LifePlanBook.sampleYear(book);
    localStorage.setItem('lifeplan.v2', JSON.stringify({ version: 2, activeId: 1, nextPlanId: 2, plans: [{ id: 1, name: 'プラン1', state: st }], prefs: { yearMode: 'year', welcomed: true }, book }));
  });
  await xp.reload();
  await go(xp, '#planbtn'); await xp.waitForSelector('.sheet');
  await xp.locator('.pl', { hasText: 'プラン1' }).locator('button.del').tap(); await xp.waitForTimeout(80);
  const ask = await xp.textContent('.plconfirm');
  await xp.locator('.plconfirm .btn', { hasText: '削除する' }).tap();
  await xp.waitForSelector('.cover');
  const st1 = await xp.evaluate(() => JSON.parse(localStorage.getItem('lifeplan.v2')));
  check('最後のプランも削除でき、はじめて開いたときと同じ表紙に戻る（家計簿は残る）',
    /最後のプラン/.test(ask) && JSON.stringify(st1.plans.map((p) => p.name)) === '["記入例"]' && st1.prefs.welcomed === false && Object.keys(st1.book.years).length === 1, `${st1.plans.map((p) => p.name)} / ${ask.trim()}`);
  await xp.locator('#toast button').tap(); await xp.waitForTimeout(150);
  const back = await xp.evaluate(() => JSON.parse(localStorage.getItem('lifeplan.v2')).plans.map((p) => p.name));
  check('最後のプランの削除も「元に戻す」で戻せ、入力画面に戻る', JSON.stringify(back) === '["プラン1"]' && !(await xp.locator('#coverview').isVisible()), `${back}`);
  await go(xp, '#planbtn'); await xp.waitForSelector('.sheet');
  await xp.locator('.wipe .btn', { hasText: 'すべて消して最初から' }).tap(); await xp.waitForTimeout(80);
  await xp.locator('.wipe .btn', { hasText: 'すべて消す' }).tap();
  await xp.waitForSelector('.cover');
  const st2 = await xp.evaluate(() => JSON.parse(localStorage.getItem('lifeplan.v2')));
  check('「すべて消して最初から」で、プランも家計簿も消えて表紙に戻る', JSON.stringify(st2.plans.map((p) => p.name)) === '["記入例"]' && Object.keys(st2.book.years).length === 0 && st2.prefs.welcomed === false, JSON.stringify(st2.book));
  await c.close();
}

// 家を買うか考えている人の流れ：結果がひとことで出て、家を買ったプランと比べ、家の値段は家を買ったプランで変える（今の住まいのプランは変えない）
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  const hp = await c.newPage();
  hp.on('pageerror', (e) => errors.push(e.message));
  await hp.goto(url);
  await hp.waitForSelector('.cover');
  await hp.locator('.cover .opt', { hasText: '4人家族' }).tap();
  await hp.locator('.cover .need', { hasText: '家を買う' }).tap();
  await hp.locator('.cvcta .btn').tap();
  await hp.waitForSelector('.wz');
  const births = { 0: ['#w-birth1'], 1: ['#w-birth2', '#w-kid-0', '#w-kid-1'] };
  const vals = { '#w-birth1': '19920610', '#w-birth2': '19940305', '#w-kid-0': '20210415', '#w-kid-1': '20240901' };
  for (let st = 0; st < 7; st++) {
    for (const id of births[st] || []) { await hp.fill(id, vals[id]); await hp.locator(id).blur(); await hp.waitForTimeout(120); }
    if (st === 6) {
      // 家を買うなら：値段・頭金・買う年。借りる額と月の返済がその場で出る
      await hp.fill('#w-housePrice', '4500'); await hp.press('#w-housePrice', 'Tab'); await hp.waitForTimeout(120);
      await hp.fill('#w-houseDown', '500'); await hp.press('#w-houseDown', 'Tab'); await hp.waitForTimeout(120);
      const wzHouse = (await hp.textContent('.wz .wzsum')).replace(/\s+/g, '');
      check('かんたん入力：家を買うかを選んだ人には「家を買うなら」を聞き、借りる額と月の返済を出す', /7 \/ 7/.test(await hp.textContent('.wzhead')) && /借りる額4,000万円/.test(wzHouse) && /返済は月11.3万円/.test(wzHouse), wzHouse);
    }
    await hp.locator('.wznav .btn', { hasText: /次へ|この内容で計算する/ }).tap(); await hp.waitForTimeout(150);
  }
  // 終わると、今の住まいのままと家を買った場合を並べた比較が開き、住宅購入チェックが出る
  await hp.waitForSelector('.cmpsay');
  const say = await hp.textContent('.cmpsay');
  const hcItems = await hp.$$eval('.hcheck .hc .t', (els) => els.map((e) => e.textContent));
  const st0 = await hp.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); return s.plans.map((p) => ({ name: p.name, loan: p.state.loanCalc || null, lump: p.state.housingLump })); });
  await hp.locator('.hcheck').scrollIntoViewIfNeeded();
  await hp.screenshot({ path: join(shots, '28-house-check.png') });
  check('かんたん入力を終えると、「今の住まいのまま」と「家を買った場合」の比較が開く（頭金と諸費用は買う年に）',
    /「わが家（家を買う）」/.test(say) && (await hp.locator('.cmpsay .btn').count()) === 2 && st0.length === 2 && st0[0].loan === null &&
    st0[1].loan.amount === 4000 && st0[1].loan.costs === 270 && st0[1].lump.some((r) => r.amount === 770 && r.year === 2028), JSON.stringify(st0.map((p) => [p.name, p.loan && p.loan.amount, p.lump])));
  check('住宅購入チェック：返済の割合・返し終わるとき・返済中に貯金がいちばん少ない年・団信', hcItems.length === 4 && /返済の割合\d+%/.test(hcItems[0]) && /返し終わるとき2062年/.test(hcItems[1]) && /団信/.test(hcItems[3]), hcItems.join(' / '));
  // 結果をひとことで・教育費は大学まで（今の住まいのプラン）
  await go(hp, '#seg-cf');
  await hp.waitForSelector('#chart');
  const verdict = await hp.textContent('.verdict');
  check('未来の表のいちばん上に、結果がひとことで出る（だれが何歳のときか）', /このままだと|足りる見込み/.test(verdict) && /家族１が\d+歳/.test(verdict), verdict.trim().slice(0, 60));
  const eduStage = await hp.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); const p = s.plans.find((x) => x.id === s.activeId).state; return p.edu[10]; });
  check('かんたん入力の教育費は大学まで（大学院は「進学しない」）', eduStage[5] === '大学（私文）' && eduStage[6] === '進学しない', `${eduStage}`);
  // 家の値段を変える：家を買ったプランのローン欄で、値段と頭金から借入額を出し、反映すると比較に戻れる
  await hp.locator('#cf .guide .btn', { hasText: '家の値段・ローンを変える' }).tap(); await hp.waitForTimeout(400);
  const st1 = await hp.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); return { active: s.plans.find((p) => p.id === s.activeId).name, baseLoan: s.plans[0].state.loanCalc || null }; });
  check('「家の値段・ローンを変える」で、家を買ったプランの住宅ローンの欄が開く（今の住まいのプランにはローンを入れない）',
    st1.active === 'わが家（家を買う）' && st1.baseLoan === null && (await hp.locator('#f-loan-price').isVisible()) && (await hp.inputValue('#f-loan-price')) === '4500', JSON.stringify(st1));
  await hp.fill('#f-loan-price', '3800'); await hp.press('#f-loan-price', 'Tab'); await hp.waitForTimeout(150);
  const amt = await hp.textContent('#f-loan-amount-v');
  await hp.locator('#loanbox .btn', { hasText: '住宅費に反映する' }).tap(); await hp.waitForTimeout(150);
  if (await hp.locator('.plconfirm .btn', { hasText: '置き換える' }).count()) { await hp.locator('.plconfirm .btn', { hasText: '置き換える' }).tap(); await hp.waitForTimeout(150); }
  const toastMsg = await hp.textContent('#toast');
  const lump = await hp.evaluate(() => { const s = JSON.parse(localStorage.getItem('lifeplan.v2')); return s.plans.find((p) => p.id === s.activeId).state.housingLump; });
  check('ローン欄：家の値段−頭金で借入額を出し、反映すると頭金・諸費用の一時金は1行のまま置き換わり、比較へ案内する',
    amt === '3,300' && lump.filter((r) => /頭金・諸費用/.test(r.memo)).length === 1 && /比較/.test(toastMsg), `${amt} / ${JSON.stringify(lump)}`);
  await go(hp, '#seg-cmp');
  await hp.waitForSelector('.cmpsay');
  await hp.locator('.cmpsay .btn', { hasText: 'わが家（家を買う）の中身' }).tap(); await hp.waitForTimeout(400);
  check('比較から家を買ったプランを開くと、住宅ローンの欄（3,800万円）が出る', (await hp.locator('#f-loan-price').isVisible()) && (await hp.inputValue('#f-loan-price')) === '3800', await hp.textContent('#planname'));
  await c.close();
}

check('コンソールエラーが無い', errors.length === 0, errors.slice(0, 3).join(' / '));

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed. screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
