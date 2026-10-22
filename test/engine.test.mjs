// 計算エンジンのテスト。node --test で実行する。
//
// 期待値はすべてExcel「ライフプラン表 ver.1.79」のサンプル入力に対する計算済みの値。
// 入力シートの年ごとの集計行（教育費・住宅費・車・年金等）は既に取り出せているので、ここで照合する。
// CF表シートの全行の値は test/fixtures/excel-cf.json があれば照合する（無ければスキップ）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const E = require('../app/engine.js');
const { sample } = require('../app/sample.js');

const result = E.compute(sample());
const byYear = Object.fromEntries(result.years.map((r) => [r.year, r]));
const yearsFrom = (start, values) => values.map((v, i) => [start + i, v]);

test('期間は開始年から家族１が終了年齢になる年まで（2026〜2081、56年）', () => {
  assert.equal(result.years[0].year, 2026);
  assert.equal(result.years[0].age, 35);
  assert.equal(result.years.at(-1).year, 2081);
  assert.equal(result.years.at(-1).age, 90);
  assert.equal(result.years.length, 56);
});

test('教育費の年合計がExcel（入力シート 180行）と一致する', () => {
  const excel = yearsFrom(2026, [80, 60, 65, 65, 70, 70, 70, 70, 90, 90, 110, 115, 115, 120, 165, 165, 210]);
  for (const [y, v] of excel) assert.equal(byYear[y].expense.education, v, `${y}年`);
});

test('住宅費（一時金を含む）がExcel（入力シート 132行）と一致する', () => {
  const excel = yearsFrom(2026, [100, 702, 202, 202, 202, 202, 202, 202, 202, 202, 202, 221, 221, 221, 221, 221, 221]);
  for (const [y, v] of excel) assert.equal(byYear[y].expense.housing, v, `${y}年`);
  for (let y = 2043; y <= 2054; y++) assert.equal(byYear[y].expense.housing, 221, `${y}年`);
});

test('自動車関連費がExcel（入力シート 227行）と一致する', () => {
  for (let y = 2026; y <= 2042; y++) {
    const expected = y === 2030 || y === 2040 ? 315 : 15;
    assert.equal(byYear[y].expense.car, expected, `${y}年`);
  }
});

test('退職金・年金がExcel（入力シート 101行）と一致する', () => {
  for (let y = 2026; y <= 2050; y++) assert.equal(byYear[y].income.pension, 0, `${y}年`);
  assert.equal(byYear[2051].income.pension, 1500);
  for (let y = 2052; y <= 2055; y++) assert.equal(byYear[y].income.pension, 0, `${y}年`);
  for (let y = 2056; y <= 2081; y++) assert.equal(byYear[y].income.pension, 290, `${y}年`);
});

test('手取額の計算が手取額計算シートと一致する（年収600万円、扶養なし）', () => {
  const th = E.takeHome(600, false, 0);
  assert.equal(th.social, 93);
  assert.equal(th.tax, 45.45);
  assert.equal(th.net, 462); // シートでは 461.55
});

test('早生まれは就学が1年早い', () => {
  const s = sample();
  s.family[2].birth = '2022/04/01'; // 4/1生まれ＝早生まれ
  const early = E.eduPlan(s, s.family[2]).find((x) => x.stage.startsWith('小学校'));
  s.family[2].birth = '2022/04/02';
  const late = E.eduPlan(s, s.family[2]).find((x) => x.stage.startsWith('小学校'));
  assert.equal(early.from, 2028);
  assert.equal(late.from, 2029);
});

test('給与は退職年齢の年から0、それまでは上昇率で複利成長', () => {
  assert.equal(byYear[2026].income.salaries[0], 500);
  assert.ok(Math.abs(byYear[2027].income.salaries[0] - 507.5) < 1e-9);
  assert.equal(byYear[2051].income.salaries[0], 300);
  assert.equal(byYear[2055].income.salaries[0], 300); // 上昇率0%
  assert.equal(byYear[2056].income.salaries[0], 0); // 65歳
  assert.equal(byYear[2050].income.salaries[1] > 300, true);
  assert.equal(byYear[2051].income.salaries[1], 0); // 家族２は60歳
});

test('基本生活費：変更年の金額は開始年からの物価上昇で膨らむ', () => {
  assert.equal(byYear[2026].expense.living, 360);
  assert.ok(Math.abs(byYear[2027].expense.living - 361.8) < 1e-9);
  assert.ok(Math.abs(byYear[2056].expense.living - 300 * 1.005 ** 30) < 1e-9);
});

test('積立は前年の預金が足りない年は0になる', () => {
  const s = sample();
  s.assets[0].amount = 0;
  s.salaries = [];
  const r = E.compute(s);
  assert.equal(r.years[0].expense.contributions[0], 0);
});

test('同じ年の変更行は合算する（Excelは先頭の1行だけを拾う）', () => {
  const rows = [{ year: 2030, amount: 30 }, { year: 2030, amount: 20 }];
  assert.equal(E.changeAt(rows, 2030), 50);
  assert.equal(E.changeAt(rows, 2031), 50);
  assert.equal(E.changeAt(rows, 2029), 0);
});

// CF表シートの全行との照合
const PICK = {
  salary1: (r) => r.income.salaries[0] ?? 0,
  salary2: (r) => r.income.salaries[1] ?? 0,
  salary3: (r) => r.income.salaries[2] ?? 0,
  pension: (r) => r.income.pension,
  nisaOut: (r) => r.income.withdrawals[0],
  idecoOut: (r) => r.income.withdrawals[1],
  incomeTotal: (r) => r.income.total,
  living: (r) => r.expense.living,
  housing: (r) => r.expense.housing,
  education: (r) => r.expense.education,
  insurance: (r) => r.expense.insurance,
  car: (r) => r.expense.car,
  other: (r) => r.expense.other,
  nisaIn: (r) => r.expense.contributions[0],
  idecoIn: (r) => r.expense.contributions[1],
  expenseTotal: (r) => r.expense.total,
  balance: (r) => r.balance,
  deposit: (r) => r.assets.deposit,
  nisa: (r) => r.assets.investments[0],
  ideco: (r) => r.assets.investments[1],
  total: (r) => r.assets.total,
};

function compareWithExcel(state, excelYears) {
  const mine = Object.fromEntries(E.compute(state).years.map((r) => [r.year, r]));
  const out = [];
  if (Object.keys(mine).length !== excelYears.length) out.push(`年数: アプリ ${Object.keys(mine).length} / Excel ${excelYears.length}`);
  for (const row of excelYears) {
    const m = mine[row.year];
    if (!m) { out.push(`${row.year}: 年が無い`); continue; }
    for (const [key, get] of Object.entries(PICK)) {
      if (row[key] == null) continue;
      const a = get(m), b = row[key];
      // 万円単位で0.005（＝50円）を超える差は不一致とみなす
      if (Math.abs(a - b) > 0.005) out.push(`${row.year} ${key}: アプリ ${a.toFixed(3)} / Excel ${b.toFixed(3)}`);
    }
  }
  return out;
}

const fixtureDir = new URL('./fixtures/', import.meta.url);
const samplePath = new URL('excel-cf.json', fixtureDir);
test('サンプル入力でCF表の全項目がExcelと一致する', { skip: !existsSync(samplePath) && 'Excelの計算済みの値（test/fixtures/excel-cf.json）がまだ無い' }, () => {
  const fx = JSON.parse(readFileSync(samplePath, 'utf8'));
  const bad = compareWithExcel(sample(), fx.years);
  assert.deepEqual(bad.slice(0, 40), [], `${bad.length}件の不一致`);
});

// 別の入力をExcelに流し込んで再計算した結果（tools/excel_scenarios.py が作る）
const scenarioFiles = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((f) => f.startsWith('scenario-')) : [];
for (const file of scenarioFiles) {
  const fx = JSON.parse(readFileSync(new URL(file, fixtureDir), 'utf8'));
  test(`シナリオ「${fx.name}」でCF表の全項目がExcelと一致する`, () => {
    const bad = compareWithExcel(fx.state, fx.years);
    assert.deepEqual(bad.slice(0, 40), [], `${bad.length}件の不一致`);
  });
}

// 入力の確認
const at = (list) => list.map((i) => `${i.at}/${i.field}/${i.level}`);

test('サンプル入力には確認が必要な箇所が無い', () => {
  assert.deepEqual(E.validate(sample()), []);
});

test('生年月日は「/」でも「-」でも読め、ありえない日付は知らせる', () => {
  assert.deepEqual(E.parseDate('1990-04-01'), { y: 1990, m: 4, d: 1 });
  assert.equal(E.isDate('1990/4/1'), true);
  assert.equal(E.isDate('1990-02-30'), false);
  const s = sample();
  s.family[0].birth = '';
  assert.deepEqual(at(E.validate(s)), ['fam:1/birth/error']);
  s.family[0].birth = '1991/13/01';
  assert.deepEqual(at(E.validate(s)), ['fam:1/birth/error']);
});

test('終了年齢が今の年齢以下なら知らせ、計算する年が無くても落ちない', () => {
  const s = sample();
  s.endAge = 30;
  assert.deepEqual(at(E.validate(s)), ['start/endAge/error']);
  const r = E.compute(s);
  assert.equal(r.years.length, 0);
  assert.equal(r.endTotal, 0);
});

test('期間の逆転・期間外・使われない行・大きすぎる率を知らせる', () => {
  const s = sample();
  s.invest[2].add[0].toYear = 2020;          // まで ＜ から
  s.lump[0].year = 2100;                      // 計算期間（〜2081年）の外
  s.living[1].year = 2026;                    // 2行目が開始年ちょうど → 使われない
  s.salaries[0].rows[0].growth = 15;          // 15％
  s.salaries[1].retireAge = 30;               // 開始年にはもう35歳
  s.carBuy.untilAge = 30;                     // 一度も買わない
  assert.deepEqual(at(E.validate(s)).sort(), [
    'car/untilAge/warn',
    'inv:2:add:1/toYear/error',
    'row:living:2/year/warn',
    'row:lump:1/year/warn',
    'sal:2/retire/warn',
    'salrow:1:1/growth/warn',
  ]);
});

test('かんたん入力の答えから作ったプランは、確認箇所なしで計算できる', () => {
  const { fromAnswers } = require('../app/sample.js');
  const s = fromAnswers({
    startYear: 2026, endAge: 90, name1: '', birth1: '1988/06/15',
    has2: true, name2: 'B', birth2: '1990/02/01', kids: [{ name: '', birth: '2023/03/31' }],
    deposit: 300, nisa: 50, ideco: 0, rate: 3,
    sal1: 420, retire1: 65, growth: 1, sal2: 0, retire2: 60, retireLump: 1000,
    pension: 250, pensionAge: 65, living: 300, housing: 120, insurance: 24, inflation: 0.5,
  });
  assert.deepEqual(E.validate(s), []);
  assert.equal(s.salaries.length, 1);                 // 家族２の収入0円は行を作らない
  assert.equal(s.lump[0].year, 1988 + 65);
  assert.equal(s.pubPension[0].year, 1988 + 65);
  const r = E.compute(s);
  assert.equal(r.years[0].year, 2026);
  assert.equal(r.years.at(-1).age, 90);
  assert.ok(r.years[0].expense.education > 0);        // 子供の教育費が自動で入る
});

test('公的年金の試算がExcel（入力シート AK87・AK89・AK91）と一致する', () => {
  // サンプル：家族１・家族２とも1991年生まれ → 入社2013年、最終退職2051年
  const d = E.pensionDefaults(1991);
  assert.equal(d.from, 2013);
  assert.equal(d.to, 2051);
  const p1 = E.pensionEstimate({ ...d, payFrom: 300, payTo: 700 }, 90);
  const p2 = E.pensionEstimate({ ...d, payFrom: 300, payTo: 400 }, 90);
  assert.deepEqual(p1, { years: 39, earn: 107, basic: 70, total: 159.3 });
  assert.deepEqual(p2, { years: 39, earn: 75, basic: 70, total: 130.5 });
  assert.equal(Math.round((p1.total + p2.total) * 10) / 10, 289.8);
  // 会社員の期間が無い人（手取額0）は基礎年金だけ
  assert.equal(E.pensionEstimate({ ...d, payFrom: 0, payTo: 0 }, 90).total, 63);
  // 期間が逆なら報酬比例は0
  assert.equal(E.pensionEstimate({ ...d, from: 2051, to: 2013, payFrom: 300, payTo: 700 }, 90).earn, 0);
});

test('住宅ローンの試算がExcel（入力シート X118・AB118・AE119、住宅ローン返済表シート）と一致する', () => {
  // サンプル：4500万円、35年、当初1%を10年、その後2%を25年
  const r = E.loanSchedule({ amount: 4500, years: 35, phases: [{ rate: 1, years: 10 }, { rate: 2, years: 25 }] });
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} / ${b}`);
  near(r.phases[0].annual, 152.43427742581025, '当初の年間返済額');
  near(r.phases[1].annual, 171.4371244693776, '見直し後の年間返済額');
  near(r.total, 5810.270885992542, '返済総額');
  near(r.yearly[9].balance, 3370.5982778936840, '10年後の残高（返済表 E126）');
  assert.equal(r.yearly.length, 35);
  near(r.yearly[34].balance, 0, '完済');
  // 最後の段階の年数は残り全部（入れた年数は使わない）。0%は均等割り
  const z = E.loanSchedule({ amount: 1200, years: 10, phases: [{ rate: 0, years: 99 }] });
  near(z.phases[0].annual, 120, '金利0%');
  assert.equal(z.phases[0].years, 10);
});

test('表紙で選んだ家族のかたちの参考値から、確認箇所なしのプランができる', () => {
  const S = require('../app/sample.js');
  for (const f of S.FAMILIES) {
    for (const h of S.HOMES) {
      const d = S.templateAnswers(f.key, h.key, 2026);
      d.birth1 = '1990/05/05';
      if (d.has2) d.birth2 = '1991/06/06';
      d.kids.forEach((k, i) => { k.birth = `${2020 + i}/07/07`; });
      const s = S.applyNeeds(S.fromAnswers(d), S.NEEDS.map((n) => n.key));
      assert.deepEqual(E.validate(s), [], `${f.key}/${h.key}`);
      assert.equal(s.family.length, f.adults + f.kids);
      const r = E.compute(s);
      assert.equal(r.years.at(-1).age, 95);
      assert.equal(r.years[0].expense.contributions[0], 36);   // 積立投資：NISAに年36万円
      assert.equal(s.loanCalc.amount, 4000);                    // 住宅購入：ローンの試算に参考値
    }
  }
});
