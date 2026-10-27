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

test('手取額の計算が手取額計算シートの記入例と一致する（年収600万円、扶養なし）', () => {
  const th = E.takeHome({ income: 600, spouse: 'なし', spouseIncome: 300 });
  assert.equal(th.social, 93);
  assert.equal(th.incomeTax, 17.25);
  assert.equal(th.residentTax, 28.2);
  assert.equal(th.net, 461.55);
  assert.equal(E.takeHome(600, false, 0).net, 461.55);   // 以前の呼び方でも同じ
});

// 手取額計算シートにいろいろな入力を入れ、LibreOfficeで再計算した値（test/fixtures/excel-takehome.json）
{
  const fx = JSON.parse(readFileSync(new URL('./fixtures/excel-takehome.json', import.meta.url), 'utf8'));
  for (const c of fx.cases) {
    test(`手取額：「${c.input.name}」がExcelと一致する`, () => {
      const th = E.takeHome(c.input);
      const near = (a, b, k) => assert.ok(Math.abs(a - b) < 0.006, `${k}: アプリ ${a} / Excel ${b}`);
      near(th.deductions.spouse, c.excel.spouseDed, '配偶者控除');
      near(th.deductions.dependents, c.excel.depDed, '扶養控除');
      near(th.taxable, c.excel.taxable, '課税所得');
      near(th.incomeTax, c.excel.incomeTax, '所得税');
      near(th.residentTax, c.excel.residentTax, '住民税');
      near(th.social, c.excel.social, '社会保険料');
      near(th.net, c.excel.net, '手取り');
    });
  }
}

test('手取額：社会保険料は健康保険の種類と年齢で変えられ、何も選ばなければExcelと同じ15.5％', () => {
  const base = { income: 800, spouse: 'あり', ideco: 24 };
  assert.equal(E.takeHome(base).social, 124);                                        // Excelと同じ
  assert.equal(E.takeHome({ ...base, health: 'kyokai', age: 45 }).socialRate, 15.5);     // 協会けんぽ・40歳以上＝Excelと同じ水準
  assert.equal(E.takeHome({ ...base, health: 'kyokai', age: 35 }).socialRate, 14.7);     // 40歳未満は介護保険料なし
  assert.equal(E.takeHome({ ...base, health: 'kumiai', age: 45 }).socialRate, 14.7);
  assert.equal(E.takeHome({ ...base, health: 'kumiai', age: 35 }).socialRate, 13.9);
  // 厚生年金の上限：年収1,500万円でも厚生年金は1,080万円分まで
  const hi = E.takeHome({ income: 1500, health: 'kyokai', age: 35 });
  assert.ok(Math.abs(hi.social - (1500 * 0.0555 + 1080 * 0.0915)) < 0.01);
  // 実額を入れればそれを使う
  assert.equal(E.takeHome({ ...base, social: 110 }).social, 110);
});

test('手取額：源泉徴収票の金額（円）から出す。iDeCoなどの掛金は手取りに含め、住民税は無ければ見積もる', () => {
  const slip = { pay: 8000000, after: 6100000, deductions: 2000000, tax: 350000, social: 1150000, small: 120000 };
  const est = E.takeHomeFromSlip(slip);
  assert.equal(est.social, 103);                 // 115万円のうちiDeCoなど12万円は貯蓄なので除く
  assert.equal(est.incomeTax, 35);
  assert.equal(est.residentTax, 42.2);           // (610−200)×10％＋1＋0.2（Excelの手取額計算シートと同じ見積もり）
  assert.ok(est.residentEstimated);
  assert.equal(est.net, 619.8);
  const act = E.takeHomeFromSlip({ ...slip, resident: 380000 });
  assert.equal(act.net, 624);
  assert.ok(!act.residentEstimated);
  // 給与所得控除後の金額・所得控除の合計が無くても計算できる
  assert.ok(E.takeHomeFromSlip({ pay: 8000000, tax: 350000, social: 1150000 }).net > 0);
  assert.equal(E.takeHomeFromSlip({}).net, 0);
});

test('手取額：住民税は去年の年収で計算できる（年収800万円・去年740万円の例）', () => {
  const base = { income: 800, spouse: 'あり', ideco: 24 };
  const now = E.takeHome(base), lag = E.takeHome({ ...base, lastIncome: 740 });
  assert.equal(lag.incomeTax, now.incomeTax);                 // 所得税と社会保険料は今年の年収のまま
  assert.equal(lag.social, now.social);
  assert.equal(lag.residentTax, E.takeHome({ ...base, income: 740 }).residentTax);   // 住民税は去年の年収で計算したものと同じ
  assert.ok(lag.residentTax < now.residentTax && lag.residentFromLast);
  // 両方を指定：健康保険組合・38歳・去年740万円 → Excelの式（610.75）より約13.5万円多い
  assert.equal(now.net, 610.75);
  assert.equal(E.takeHome({ ...base, lastIncome: 740, health: 'kumiai', age: 38 }).net, 624.28);
});

test('扶養控除の区分は12月31日の年齢で決まる（16歳未満は対象外、19〜22歳は特定扶養、70歳以上は老人扶養）', () => {
  assert.deepEqual([0, 15, 16, 18, 19, 22, 23, 69, 70].map(E.dependentGroup), ['under16', 'under16', 'g16', 'g16', 'g19', 'g19', 'g16', 'g16', 'elder']);
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

test('ありえない率でも計算があふれず、100％を超える率はエラーとして知らせる', () => {
  const s = sample();
  s.inflation = 1e9;
  s.salaries[0].rows[0].growth = 1e9;
  s.assets[1].rate = -1e9;
  const r = E.compute(s);
  for (const y of r.years) assert.ok(Number.isFinite(y.assets.total) && Number.isFinite(y.balance), `${y.year}年`);
  const v = E.validate(s).filter((i) => i.level === 'error').map((i) => i.field).sort();
  assert.deepEqual(v, ['growth', 'inflation', 'rate']);
});

test('1人目の続柄が家族１でなければ知らせる', () => {
  const s = sample();
  s.family[0].relation = '子供１';
  assert.ok(E.validate(s).some((i) => i.at === 'fam:1' && i.field === 'relation' && i.level === 'error'));
});

// 乱数で作ったさまざまな入力（ありえない値も含む）で、計算が落ちず、∞やNaNが出ず、収支と残高のつじつまが合う
test('どんな入力でも計算が落ちず、つじつまが合う（乱数で800通り）', () => {
  const S = require('../app/sample.js');
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const odd = [0, -50, 1e9, 0.5, '', '12', 'abc', null, undefined, 99999];
  for (let n = 0; n < 800; n++) {
    const d = S.templateAnswers(pick(S.FAMILIES).key, pick(S.HOMES).key, 2026);
    d.birth1 = `${1940 + Math.floor(rnd() * 70)}/05/15`;
    if (d.has2) d.birth2 = '1990/02/02';
    d.kids.forEach((k) => { k.birth = `${2000 + Math.floor(rnd() * 40)}/04/01`; });
    const st = S.applyNeeds(S.fromAnswers(d), S.NEEDS.map((x) => x.key));
    st.inflation = pick(odd); st.assets[1].rate = pick(odd); st.assets[0].amount = pick(odd);
    st.salaries[0].rows[0].growth = pick(odd); st.endAge = pick([60, 90, 120, '', 150]);
    st.living.push({ id: 99, year: pick([2030, '', 3000]), amount: pick(odd) });
    const r = E.compute(st);
    E.validate(st);
    for (const y of r.years) {
      for (const v of [y.balance, y.income.total, y.expense.total, y.assets.deposit, y.assets.total]) assert.ok(Number.isFinite(v), `${n}: ${y.year}年`);
      const tol = 1e-9 * Math.max(1, Math.abs(y.income.total) + Math.abs(y.expense.total));
      assert.ok(Math.abs(y.balance - (y.income.total - y.expense.total)) <= tol, `${n}: 収支 ${y.year}年`);
      assert.ok(Math.abs(y.assets.total - y.assets.deposit - y.assets.investTotal) <= 1e-9 * Math.max(1, Math.abs(y.assets.total)), `${n}: 残高 ${y.year}年`);
    }
  }
});

test('投資シミュレーション：Excelの投資シミュレーションシート（記入例）と50年後まで一致', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/excel-investsim.json', import.meta.url), 'utf8'));
  const i = fx.input;
  const r = E.investSim({ start: i.start, contrib: i.contrib, rate: i.rate, cost: i.cost, age: i.age, until: i.until, to: i.age + 50 });
  assert.equal(r.rows.length, fx.rows.length);
  r.rows.forEach((row, k) => {
    const e = fx.rows[k];
    assert.equal(row.age, e.age);
    assert.equal(row.contrib, e.contrib, `${e.age}歳の積立`);
    assert.equal(row.cumulative, e.cumulative, `${e.age}歳の累積`);
    assert.ok(Math.abs(row.value - e.value) < 1e-6, `${e.age}歳 ${row.value} ≠ ${e.value}`);
    assert.ok(Math.abs(row.ret - e.ret) < 1e-6);
  });
  // 何歳まで計算するか（to）を省くと、積立の終わりの年まで
  const u = E.investSim({ ...i, contrib: i.contrib });
  assert.equal(u.rows[u.rows.length - 1].age, 65);
  assert.ok(Math.abs(u.value - 2893.009711) < 1e-5);
  assert.equal(u.cumulative, 1216);
});

test('投資シミュレーション：目標額から毎年の積立額を逆算できる', () => {
  const o = { start: 100, rate: 5, cost: 0.2, age: 35, until: 65 };
  const need = E.investNeed(o, 2893.009711);
  assert.ok(Math.abs(need - 36) < 1e-6, String(need));
  assert.equal(E.investNeed(o, 0), 0);                       // 残高だけで届くなら0
});

// ---- 公的年金の見込み（額面基準・プランの給与から） ----
function penState(over = {}) {
  const st = {
    startYear: 2026, endAge: 95, inflation: 0, depositRate: 0,
    family: [{ id: 1, relation: '家族１', birth: '1991/06/01' }],
    assets: [{ id: 1, name: '普通預金等', fixed: true, amount: 0 }],
    salaries: [{ id: 1, memberId: 1, retireAge: 65, rows: [{ id: 1, year: 2026, amount: E.takeHome({ income: 600 }).net, growth: 0 }] }],
    pubPension: [], lump: [], corpPension: [], privPension: [], living: [], housing: [], insurance: [], carCost: [], otherFlow: [], otherLump: [],
    housingLump: [], carBuy: {}, carBuyOverride: {}, invest: {}, edu: {}, eduAmount: {}, eduSpan: {},
    penAuto: true, penPlan: { adjust: 90, people: {} }
  };
  return Object.assign(st, over);
}

test('公的年金：厚生年金の上限は今の年収1,080万円から、2027〜2029年の引き上げを経て2030年から1,200万円（月75万円）', () => {
  assert.equal(E.pensionCap(2026), 1080);
  assert.equal(E.pensionCap(2027), 1092);
  assert.equal(E.pensionCap(2028), 1128);
  assert.equal(E.pensionCap(2029), 1168);
  assert.equal(E.pensionCap(2030), 1200);
  assert.equal(E.pensionCap(2050), 1200);
  assert.ok(Math.abs(E.grossFromNet(E.takeHome({ income: 600 }).net) - 600) < 0.01);   // 手取りから額面へ
  assert.ok(Math.abs(E.grossFromNet(E.takeHome({ income: 2000 }).net) - 2000) < 0.01);
});

test('公的年金：プランの給与（額面に直す）× 5.481/1000 を働く年ごとに足し、これまでの分は1年目の年収から直線で推測', () => {
  const st = penState({ penPlan: { adjust: 90, people: { 1: { mode: 'first', firstAge: 22, firstIncome: 300 } } } });
  const p = E.pensionPlan(st).people[0];
  // これから：2026〜2055年（35〜64歳）の30年×600万円
  assert.equal(p.futureYears, 30);
  assert.ok(Math.abs(p.future - Math.round(30 * 600 * 0.005481 * 10) / 10) < 0.11, String(p.future));
  // これまで：22〜34歳の13年、300万円から600万円へ直線（合計5,700万円）
  assert.equal(p.pastYears, 13);
  assert.ok(Math.abs(p.past - 5700 * 0.005481) < 0.06, String(p.past));
  assert.equal(p.basic, 83.2);
  const gross = 30 * 600 * 0.005481 + 5700 * 0.005481 + 83.2;
  assert.ok(Math.abs(p.gross - gross) < 0.2, `${p.gross} ≠ ${gross}`);
  assert.equal(p.amount, Math.round(E.pensionNet(p.gross).net * 0.9 * 10) / 10);
  // CF表：65歳（2056年）からその額
  const r = E.compute(st);
  assert.equal(r.years.find((y) => y.year === 2056).income.pension, p.amount);
  assert.equal(r.years.find((y) => y.year === 2055).income.pension, 0);
});

test('公的年金：年収2,000万円でも上限（2030年からは1,200万円）で計算する', () => {
  const st = penState();
  st.salaries[0].rows[0].amount = E.takeHome({ income: 2000 }).net;
  const p = E.pensionPlan(st).people[0];
  let expect = 0;
  for (let y = 2026; y <= 2055; y++) expect += E.pensionCap(y) * 0.005481;
  assert.equal(p.cappedYears, 30);
  assert.ok(Math.abs(p.future - expect) < 0.11, `${p.future} ≠ ${expect}`);
});

test('公的年金：役職定年（55歳で減額）や再雇用（60〜65歳）の給与がそのまま反映される', () => {
  const base = E.pensionPlan(penState()).people[0];
  const st = penState();
  st.salaries[0].retireAge = 66;
  st.salaries[0].rows.push({ id: 2, year: 2046, amount: E.takeHome({ income: 450 }).net, growth: 0 });   // 55歳で役職定年
  st.salaries[0].rows.push({ id: 3, year: 2051, amount: E.takeHome({ income: 300 }).net, growth: 0 });   // 60歳から嘱託、65歳まで
  const p = E.pensionPlan(st).people[0];
  const expect = (20 * 600 + 5 * 450 + 6 * 300) * 0.005481;
  assert.equal(p.futureYears, 31);
  assert.ok(Math.abs(p.future - expect) < 0.11, `${p.future} ≠ ${expect}`);
  assert.ok(p.future < base.future);
});

test('公的年金：ねんきん定期便（50歳未満は実績＋これから、50歳以上は60歳までの見込みを給与の変化で直す）', () => {
  const young = E.pensionPlan(penState({ penPlan: { people: { 1: { mode: 'teiki', teikiEarn: 25 } } } })).people[0];
  assert.ok(Math.abs(young.earn - (25 + young.future)) < 0.11);
  // 52歳（1974年生まれ）：定期便の見込額100万円は60歳まで今の600万円が続く前提。55歳から450万円に下がるなら、その分を引く
  const st = penState({ family: [{ id: 1, relation: '家族１', birth: '1974/06/01' }], penPlan: { people: { 1: { mode: 'teiki', teikiEarn: 100, teikiBasic: 80 } } } });
  st.salaries[0].retireAge = 65;
  st.salaries[0].rows.push({ id: 2, year: 2029, amount: E.takeHome({ income: 450 }).net, growth: 0 });
  const old = E.pensionPlan(st).people[0];
  assert.ok(old.over50);
  const expect = 100 - 5 * 150 * 0.005481 + 5 * 450 * 0.005481;   // 55〜59歳の5年は150万円下がる、60〜64歳の5年は450万円で上乗せ
  assert.ok(Math.abs(old.earn - expect) < 0.2, `${old.earn} ≠ ${expect}`);
  assert.equal(old.basic, 80);
});

test('公的年金：繰下げ（70歳で42％増）・繰上げ（60歳で24％減）、給与の無い人は会社員だった年数から、基礎年金は納めた年数で', () => {
  const at = (startAge) => E.pensionPlan(penState({ penPlan: { people: { 1: { startAge } } } })).people[0];
  const p65 = at(65), p70 = at(70), p60 = at(60);
  assert.ok(Math.abs(p70.gross - p65.gross * 1.42) < 0.2);
  assert.ok(Math.abs(p60.gross - p65.gross * 0.76) < 0.2);
  assert.equal(p70.startYear, 1991 + 70);
  const st = penState({ salaries: [], penPlan: { people: { 1: { pastYears: 8, pastIncome: 350, basicYears: 30 } } } });
  const h = E.pensionPlan(st).people[0];
  assert.ok(Math.abs(h.earn - 8 * 350 * 0.005481) < 0.06);
  assert.equal(h.basic, 62.4);
});

test('公的年金：受け取りはじめる年が違う夫婦は、CF表の行を年ごとの合計にする', () => {
  const st = penState({
    family: [{ id: 1, relation: '家族１', birth: '1991/06/01' }, { id: 2, relation: '家族２', birth: '1994/06/01' }],
    penPlan: { people: {} }
  });
  const plan = E.pensionPlan(st);
  const [a, b] = plan.people;
  assert.deepEqual(plan.rows.map((r) => r.year), [2056, 2059]);
  assert.equal(plan.rows[0].amount, a.amount);
  assert.ok(Math.abs(plan.rows[1].amount - (a.amount + b.amount)) < 0.11);
  assert.equal(b.future, 0);            // 給与の無い家族２は基礎年金だけ
  assert.equal(b.basic, 83.2);
});

test('手取額：健康保険は年収2,241万円で頭打ち（雇用保険は上限なし）', () => {
  const a = E.takeHome({ income: 2500, health: 'kyokai', age: 45 }).social;
  assert.ok(Math.abs(a - (2241 * 0.058 + 2500 * 0.0055 + 1080 * 0.0915)) < 0.01, String(a));
});

// ---- 必要保障額 ----
test('必要保障額（簡易版）：Excelの必要保障額シート（2028年度改正版）の記入例と同じ式（子がいる間の遺族厚生年金だけ3/4にしたので3,317万円）', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/excel-need.json', import.meta.url), 'utf8'));
  const r = E.needSimple(fx.input);
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);
  close(r.emp, fx.out.O10, '夫の報酬比例（25年みなし）');
  close(r.own, fx.out.Y10, '妻の報酬比例×0.75');
  assert.equal(r.survivorTable.length, fx.survivor.length);
  // シートは子がいる間も遺族厚生年金を報酬比例の全額にしている。アプリは法律どおり3/4なので、その年は全額の1/4だけ少ない
  const less = fx.out.O10 * 0.25;
  let lessTotal = 0;
  r.survivorTable.forEach((row, i) => {
    const d = row.kids > 0 ? less : 0;
    lessTotal += d;
    close(row.total, fx.survivor[i] - d, `妻${row.age}歳の遺族年金等`);
  });
  assert.equal(r.survivorTable.filter((x) => x.kids > 0).length, 15);
  close(r.income.assets, fx.out.G9, '金融資産');
  close(r.income.survivor, fx.out.G19 - lessTotal, '遺族年金等');
  close(r.income.company, fx.out.G24, '会社からの保障');
  close(r.income.spouse, fx.out.G26, '配偶者収入');
  close(r.income.total, fx.out.G34 - lessTotal, '収入合計');
  close(r.expense.living, fx.out.G42, '生活費');
  close(r.expense.housing, fx.out.G48, '住居費');
  close(r.expense.insurance, fx.out.G58, '保険料');
  close(r.expense.car, fx.out.G62, '自動車');
  close(r.expense.total, fx.out.G69, '支出計');
  assert.equal(r.need, Math.round(fx.out.G69 - (fx.out.G34 - lessTotal)));
  assert.equal(r.need, 3317);
});

test('必要保障額（簡易版）：平均年収の上限は公的年金の見込みと同じ（今は1,080万円、2030年からは1,200万円）', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/excel-need.json', import.meta.url), 'utf8'));
  const hi = { ...fx.input, avgIncome: 1500, spouseAvg: 1500 };
  assert.ok(Math.abs(E.needSimple({ ...hi, year: 2026 }).emp - 1080 * 0.005481 * 25) < 1e-9);
  assert.ok(Math.abs(E.needSimple({ ...hi, year: 2031 }).emp - 1200 * 0.005481 * 25) < 1e-9);
  assert.ok(Math.abs(E.needSimple({ ...hi, year: 2026 }).own - 1080 * 0.005481 * 38 * 0.75) < 1e-9);
  assert.equal(E.needFromPlan(require('../app/sample.js').sample(), {}).year, 2026);
});

test('もしもの場合（CF表）：亡くなる年から給与が0、生活費は末子独立まで8割・その後6割、団信で返済が消え、遺族年金が入り、不足資金を出す', () => {
  const S = require('../app/sample.js');
  const st = S.sample();
  st.housing.forEach((r) => { r.dansin = true; });
  const rs = E.riskState(st, { year: 2030 });
  const base = E.compute(st), risk = E.compute(rs.state);
  const y = (r, yr) => r.years.find((x) => x.year === yr);
  assert.ok(y(risk, 2029).income.salaries[0] > 0);
  assert.equal(y(risk, 2030).income.salaries[0], 0);                                  // 夫の給与は2030年から0
  assert.ok(Math.abs(y(risk, 2030).expense.living - y(base, 2030).expense.living * 0.8) < 0.01);   // 生活費は8割
  assert.equal(rs.info.indepYear, 2024 + 22);                                                         // 下の子（2024年生まれ）が22歳
  assert.ok(Math.abs(y(risk, 2045).expense.living - y(base, 2045).expense.living * 0.8) < 0.01);
  assert.ok(Math.abs(y(risk, 2046).expense.living - y(base, 2046).expense.living * 0.6) < 0.01);   // 独立してからは6割
  assert.ok(Math.abs(y(risk, 2060).expense.living - y(base, 2060).expense.living * 0.6) < 0.01);
  assert.ok(y(risk, 2030).expense.housing < y(base, 2030).expense.housing);           // 団信
  const sv = rs.info.survivor[0];
  assert.ok(sv.basic > 0 && sv.child > 0 && sv.emp > 0, JSON.stringify(sv));          // 子がいる間は遺族基礎＋子の加算＋遺族厚生
  assert.ok(y(risk, 2030).income.pension > 0);
  const sf = E.riskShortfall(st, { year: 2030 });
  assert.ok(sf.need >= 0);
  // 不足資金をその年に入れれば、最後まで預金がマイナスにならない
  const covered = E.riskShortfall(st, { year: 2030, insurance: sf.need });
  assert.equal(covered.need, 0);
  if (sf.need > 1) assert.ok(E.riskShortfall(st, { year: 2030, insurance: sf.need - 2 }).need > 0);
});

test('もしもの場合：子が18歳を過ぎて5年で遺族厚生年金が終わり、65歳から本人の年金（遺族の3/4のほうが多ければ差を上乗せ）', () => {
  const S = require('../app/sample.js');
  const st = S.sample();
  const rs = E.riskState(st, { year: 2026 });
  const sv = rs.info.survivor;
  const last18 = Math.max(...st.family.filter((m) => m.relation.startsWith('子供')).map((m) => parseInt(m.birth) + 18));
  const at = (yr) => sv.find((x) => x.year === yr);
  assert.ok(at(last18).child > 0);
  assert.ok(Math.abs(at(last18).emp - at(last18 + 1).emp * 0.75) < 0.11);   // 子がいる間は3/4、いなくなってから5年は全額（有期給付加算）
  assert.equal(at(last18 + 1).child, 0);
  assert.ok(at(last18 + 5).emp > 0);
  assert.equal(at(last18 + 6).emp, 0);                    // 有期給付は5年
  assert.equal(at(last18 + 6).basic, 0);                  // 子がいなくなると遺族基礎年金も無い
  const wife65 = 1991 + 65;
  assert.ok(at(wife65).own > 0);
});
