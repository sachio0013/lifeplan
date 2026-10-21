// 計算エンジンのテスト。node --test で実行する。
//
// 期待値はすべてExcel「ライフプラン表 ver.1.79」のサンプル入力に対する計算済みの値。
// 入力シートの年ごとの集計行（教育費・住宅費・車・年金等）は既に取り出せているので、ここで照合する。
// CF表シートの全行の値は test/fixtures/excel-cf.json があれば照合する（無ければスキップ）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

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

// CF表シートの全行との照合（フィクスチャがある場合のみ）
const fixturePath = new URL('./fixtures/excel-cf.json', import.meta.url);
test('CF表の全項目がExcelと一致する', { skip: !existsSync(fixturePath) && 'Excelの計算済みの値（test/fixtures/excel-cf.json）がまだ無い' }, () => {
  const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const pick = {
    salary1: (r) => r.income.salaries[0],
    salary2: (r) => r.income.salaries[1] ?? 0,
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
  const mismatches = [];
  for (const row of fx.years) {
    const mine = byYear[row.year];
    if (!mine) { mismatches.push(`${row.year}: 年が無い`); continue; }
    for (const [key, get] of Object.entries(pick)) {
      if (row[key] == null) continue;
      const a = get(mine), b = row[key];
      if (Math.abs(a - b) > 0.005) mismatches.push(`${row.year} ${key}: アプリ ${a.toFixed(3)} / Excel ${b.toFixed(3)}`);
    }
  }
  assert.deepEqual(mismatches.slice(0, 40), [], `${mismatches.length}件の不一致`);
});
