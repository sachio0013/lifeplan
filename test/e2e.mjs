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
await page.waitForSelector('#f-start');
await page.waitForTimeout(400);

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
check('変えた直後に、終了時点の金融資産の増減が出る', /今の変更で−[\d,]+万円/.test(deltaText), deltaText);
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

// 教育費：段階を私立に変えると金額が単価表の値に変わる
const eduSel = page.locator('#content select[id^="f-edu-3-2-stage"]');
await eduSel.selectOption('小学校（私）');
await page.waitForTimeout(150);
const eduAmt = await page.inputValue('#f-edu-3-2-amt');
check('教育費の段階を変えると相場の金額が入る', eduAmt === '185', `小学校（私）=${eduAmt}`);

// 公的年金の試算：サンプルはExcelと同じ289.8万円。変えると再計算し、1行目に反映できる
await page.locator('#content .card', { hasText: '公的年金' }).locator('.toggle').tap();
await page.waitForSelector('#f-pen-state-1-payTo');
const penTotal0 = await page.locator('.calcresult', { hasText: '受け取る年金' }).textContent();
await page.fill('#f-pen-state-1-payTo', '800');
await page.press('#f-pen-state-1-payTo', 'Tab');
await page.waitForTimeout(150);
const penTotal1 = await page.locator('.calcresult', { hasText: '受け取る年金' }).textContent();
await page.locator('#content .card', { hasText: '公的年金' }).locator('.penp').first().scrollIntoViewIfNeeded();
await page.screenshot({ path: join(shots, '16-pension.png') });
await page.locator('.btn', { hasText: '公的年金の1行目に反映する' }).tap();
await page.waitForTimeout(150);
const penRow = await page.inputValue('#f-pubPension-1-amt');
check('公的年金の試算がExcelと同じ289.8万円で、変えると再計算し1行目に反映できる',
  /289\.8万円/.test(penTotal0) && /299\.7万円/.test(penTotal1) && penRow === '299.7', `${penTotal0.trim()} → ${penTotal1.trim()} / 1行目=${penRow}`);

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
await page.tap('#tabs .tab[data-k="invest"]');
await page.waitForTimeout(200);
const investVisible = await page.evaluate(() => {
  const r = document.getElementById('sec-invest').getBoundingClientRect();
  return r.top > 0 && r.top < window.innerHeight / 2;
});
check('目次「投資」で投資セクションに移る', investVisible);
await page.screenshot({ path: join(shots, '2-input-invest.png') });

// CF表画面
await page.tap('#seg-cf');
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
await page.tap('#seg-input');
await page.waitForSelector('#f-living-1-amt');
const persisted = await page.inputValue('#f-living-1-amt');
check('再読み込みしても入力が残っている', persisted === '520', `基本生活費=${persisted}`);

// サンプルに戻す（確認つき）
await page.locator('.reset button').tap();
await page.waitForTimeout(100);
await page.locator('.reset button', { hasText: '記入例に戻す' }).tap();
await page.waitForTimeout(150);
const resetVal = await page.inputValue('#f-living-1-amt');
check('「記入例の内容に戻す」で初期値に戻る', resetVal === '360', `基本生活費=${resetVal}`);

// iPhoneは16px未満の入力欄をタップすると画面を拡大してしまうので、全部16px以上にしておく
await page.tap('#tabs .tab[data-k="basic"]');
await page.locator('#content .member button.del').first().tap();
await page.waitForTimeout(150);
const small = await page.$$eval('#content input, #content select', (els) => els
  .filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.className));
check('入力欄・選択欄の文字がすべて16px以上（iPhoneで拡大されない）', small.length === 0, small.slice(0, 5).join(', '));

// 生年月日は日付の選択欄。選び終えて欄を離れたら反映される
const birthType = await page.getAttribute('#f-fam-3-birth', 'type');
const birthVal = await page.inputValue('#f-fam-3-birth');
await page.fill('#f-fam-3-birth', '2022-04-01');
await page.locator('#f-fam-3-birth').blur();
await page.waitForTimeout(150);
const eduHead = await page.locator('#content .card', { hasText: '第一子の教育費' }).locator('.cnt').textContent();
check('生年月日は日付の選択欄で、変えると教育費（早生まれ）に反映される', birthType === 'date' && birthVal === '2022-01-01' && /2022\/04\/01・早生まれ/.test(eduHead), `type=${birthType} value=${birthVal} → ${eduHead}`);

// 入力の確認：終了年齢を今の年齢より下にすると、欄の下とページ上部で知らせ、CF表も落ちない
await page.fill('#f-endage', '30');
await page.press('#f-endage', 'Tab');
await page.waitForTimeout(150);
const banner = await page.locator('.vbanner').textContent().catch(() => '');
const msg = await page.locator('#sec-basic + .card .vmsg').textContent().catch(() => '');
const sumBad = await page.textContent('#summary');
await page.tap('#seg-cf');
await page.waitForTimeout(150);
const cfMsg = await page.textContent('#cf');
await page.tap('#seg-input');
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
await page.tap('#tabs .tab[data-k="expense"]');
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
check('「年齢」に切り替えると家族１の年齢で入れられ、西暦で保存される', ageVal === '65' && ageSuffix === '歳から' && ageHint === '2061年' && backYear === '2061', `${ageVal}${ageSuffix} → 70歳=${ageHint} / 西暦=${backYear}`);
await page.fill('#f-living-2-year', '2056');
await page.press('#f-living-2-year', 'Tab');

// はじめての人：案内から「かんたん入力」で自分のプランを作る
const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ja-JP', acceptDownloads: true });
const wp = await fresh.newPage();
wp.on('pageerror', (e) => errors.push(e.message));
await wp.goto(url);
await wp.waitForSelector('.welcome');
check('はじめて開くと記入例の案内が出る', /記入例/.test(await wp.textContent('.welcome')));
await wp.locator('.welcome .btn', { hasText: 'かんたん入力' }).tap();
await wp.waitForSelector('.wz');
await wp.locator('.wznav .btn', { hasText: '次へ' }).tap();
await wp.waitForTimeout(100);
const needBirth = await wp.locator('.wz .vmsg').textContent().catch(() => '');
check('かんたん入力：生年月日が無いと先に進まず、理由が出る', /生年月日/.test(needBirth) && /期間と家族１/.test(await wp.textContent('.wzt')), needBirth);
await wp.fill('#w-startYear', '2026'); await wp.press('#w-startYear', 'Tab');
await wp.fill('#w-birth1', '1986-07-10'); await wp.locator('#w-birth1').blur();
await wp.screenshot({ path: join(shots, '8-wizard-1.png') });
const next = () => wp.locator('.wznav .btn', { hasText: /次へ|この内容で計算する/ }).tap().then(() => wp.waitForTimeout(100));
await next();
await wp.locator('.check').tap();
await wp.fill('#w-birth2', '1988-02-03'); await wp.locator('#w-birth2').blur();
await wp.locator('.btn', { hasText: '子供を追加' }).tap();
await wp.fill('#w-kid-0', '2020-05-05'); await wp.locator('#w-kid-0').blur();
await wp.waitForTimeout(100);
await wp.screenshot({ path: join(shots, '9-wizard-2.png') });
await next();
await wp.fill('#w-deposit', '400'); await wp.press('#w-deposit', 'Tab');
await next();
await wp.fill('#w-sal1', '450'); await wp.press('#w-sal1', 'Tab');
await wp.fill('#w-sal2', '200'); await wp.press('#w-sal2', 'Tab');
await next();
await wp.locator('.wz .toggle').tap();
await wp.waitForSelector('#f-pen-wz-1-payFrom');
for (const [id, v] of [['1-payFrom', '350'], ['1-payTo', '500'], ['2-payFrom', '250'], ['2-payTo', '300']]) {
  await wp.fill(`#f-pen-wz-${id}`, v); await wp.press(`#f-pen-wz-${id}`, 'Tab');
}
await wp.locator('.wz .btn', { hasText: 'この金額を使う' }).tap();
await wp.waitForTimeout(100);
// 家族１：1986+22〜+60年（39年）、(350+500)/2×39×0.55%=91.2→91、(91+70)×0.9=144.9
// 家族２：1988+22〜+60年（39年）、(250+300)/2×39×0.55%=59.0→59、(59+70)×0.9=116.1
const wzPension = await wp.inputValue('#w-pension');
check('かんたん入力の年金も試算から入れられる', wzPension === '261', `公的年金=${wzPension}`);
await next();
await wp.fill('#w-living', '280'); await wp.press('#w-living', 'Tab');
await wp.fill('#w-housing', '130'); await wp.press('#w-housing', 'Tab');
const wzOverflow = await wp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await wp.screenshot({ path: join(shots, '10-wizard-6.png') });
await next();
await wp.waitForSelector('#chart');
const wzCols = await wp.$$eval('table.cf thead th', (ths) => ths.length - 1);
const wzHero = await wp.textContent('.hero');
check('かんたん入力を終えると、そのプランのCF表が開く（2026〜1986+90年）', wzCols === 2076 - 2026 + 1 && /2076年/.test(wzHero) && wzOverflow <= 0, `${wzCols}列 ${wzHero.slice(0, 30)}`);
await wp.reload();
await wp.waitForSelector('#seg-input');
await wp.tap('#seg-input');
await wp.waitForSelector('#f-start');
const kept = await wp.inputValue('#f-asset-1-amt');
check('作ったプランは再読み込みしても残り、案内はもう出ない', kept === '400' && (await wp.locator('.welcome').count()) === 0, `普通預金等=${kept}`);

// プランの一覧：記入例とかんたん入力で作ったプランがあり、切り替え・名前の変更・複製・削除ができる
await wp.tap('#planbtn');
await wp.waitForSelector('.sheet');
const planNames = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
await wp.screenshot({ path: join(shots, '12-plans.png') });
await wp.fill('#f-planname', 'わが家');
await wp.press('#f-planname', 'Tab');
await wp.waitForTimeout(100);
await wp.locator('.sheet .btn', { hasText: '複製' }).tap();
await wp.waitForTimeout(100);
const afterDup = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
const topName = await wp.textContent('#planname');
check('プランの名前を変えて複製できる', JSON.stringify(planNames) === '["記入例","プラン2"]' && JSON.stringify(afterDup) === '["記入例","わが家","わが家のコピー"]' && topName === 'わが家のコピー', `${planNames} → ${afterDup} / 表示中=${topName}`);
await wp.locator('.pl', { hasText: 'わが家のコピー' }).locator('button.del').tap();
await wp.waitForTimeout(50);
await wp.locator('.plconfirm .btn', { hasText: '削除する' }).tap();
await wp.waitForTimeout(100);
const afterDel = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
check('削除は確認してから行う', JSON.stringify(afterDel) === '["記入例","わが家"]', `${afterDel}`);
await wp.locator('.pl .pick', { hasText: '記入例' }).tap();
await wp.waitForTimeout(150);
const sheetClosed = (await wp.locator('.sheet').count()) === 0;
const exampleEnd = await wp.textContent('#planname');
check('プランを選ぶと切り替わり、一覧が閉じる', sheetClosed && exampleEnd === '記入例', exampleEnd);

// 比較：2つのプランの推移と主な数字を並べる
await wp.tap('#seg-cmp');
await wp.waitForSelector('#cmpchart');
const lines = await wp.$$eval('#cmpchart path', (els) => els.length);
const heads = await wp.$$eval('table.cmpt thead th', (els) => els.map((e) => e.textContent).filter(Boolean));
const diffs = await wp.$$eval('table.cmpt .df.up, table.cmpt .df.down', (els) => els.length);
const cmpOverflow = await wp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const cbox = await wp.locator('#cmpchart').boundingBox();
await wp.touchscreen.tap(cbox.x + cbox.width * 0.6, cbox.y + cbox.height * 0.5);
await wp.waitForTimeout(100);
const ctip = await wp.locator('#cmptip').textContent();
check('比較画面に2本の推移・差つきの表・タップで年ごとの値が出る', lines === 2 && JSON.stringify(heads) === '["記入例","わが家"]' && diffs >= 3 && cmpOverflow <= 0 && /年記入例[\d,−]+万わが家/.test(ctip), `lines=${lines} heads=${heads} diffs=${diffs} tip=${ctip}`);
await wp.screenshot({ path: join(shots, '13-compare.png'), fullPage: false });
await wp.locator('.tablecard').scrollIntoViewIfNeeded();
await wp.screenshot({ path: join(shots, '14-compare-table.png') });

// バックアップ：すべてのプランをファイルに保存し、そのファイルから読み込める
await wp.tap('#planbtn');
await wp.waitForSelector('.sheet');
const [dl] = await Promise.all([wp.waitForEvent('download'), wp.locator('.bk .btn', { hasText: 'ファイルに保存' }).tap()]);
const dlPath = join(shots, dl.suggestedFilename());
await dl.saveAs(dlPath);
const saved = JSON.parse(readFileSync(dlPath, 'utf8'));
check('バックアップのファイルにすべてのプランが入る', /^lifeplan-backup-\d{8}\.json$/.test(dl.suggestedFilename()) && saved.plans.length === 2 && saved.plans[1].name === 'わが家', `${dl.suggestedFilename()} plans=${saved.plans.map((p) => p.name)}`);
await wp.setInputFiles('#f-backup-file', dlPath);
await wp.waitForSelector('.bk .plconfirm');
await wp.screenshot({ path: join(shots, '15-backup.png') });
await wp.locator('.bk .btn', { hasText: '追加する' }).tap();
await wp.waitForTimeout(150);
const afterImport = await wp.$$eval('.pl .nm', (els) => els.map((e) => e.textContent));
check('バックアップを読み込むと、今のプランを残したまま追加される', JSON.stringify(afterImport) === '["記入例","わが家","記入例（2）","わが家（2）"]', `${afterImport}`);

// 細工されたファイルを読み込んでも、文字として表示されるだけで画面に要素が入り込まない
const evil = JSON.parse(JSON.stringify(saved.plans[0]));
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
await wp.tap('#seg-input');
await wp.waitForTimeout(150);
await wp.tap('#seg-cmp');
await wp.waitForTimeout(150);
const pwned = await wp.evaluate(() => !!document.getElementById('pwn1') || !!document.getElementById('pwn2') || document.title === 'pwn');
const shownName = await wp.textContent('#planname');
check('細工されたファイルでも要素が入り込まない', !pwned && shownName === '<img src=x id=pwn1>', `pwned=${pwned} name=${shownName}`);
await fresh.close();

// ダークモード
const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
const dp = await dark.newPage();
await dp.goto(url + '#cf');
await dp.waitForSelector('#chart');
await dp.waitForTimeout(300);
await dp.screenshot({ path: join(shots, '5-cf-dark.png') });
await dp.goto(url);
await dp.waitForSelector('#f-start');
await dp.waitForTimeout(300);
await dp.screenshot({ path: join(shots, '6-input-dark.png') });

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
