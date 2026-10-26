// 家計簿（年間収支）のテスト。node --test で実行する。
// 期待値は Excel「ライフプラン表」家計簿（年間収支）シートの記入例と、Excelが保存した計算済みの値（test/fixtures/excel-kakeibo.json）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const B = require('../app/book.js');
const fx = JSON.parse(readFileSync(new URL('./fixtures/excel-kakeibo.json', import.meta.url), 'utf8'));

const book = { nextId: 1 };
const y = B.sampleYear(book);
const s = B.summarize(y);
const col = (f) => s.months.map(f);

test('記入例の入力がExcelのシートと同じ', () => {
  assert.equal(y.items.length, fx.items.length);
  y.items.forEach((it, k) => {
    assert.equal(it.name, fx.items[k].name);
    assert.equal(it.cat, fx.items[k].cat);
    assert.deepEqual(it.m.map(B.num), fx.items[k].m, it.name);
  });
  y.incomes.forEach((r, k) => assert.deepEqual(r.m.map(B.num), fx.incomes[k].m, r.name));
});

test('支出・収入・収支の月ごとと年間の合計がExcelと一致する（31行・62行・66行）', () => {
  assert.deepEqual([...col((m) => m.expense), s.expense], fx.expected.expenseTotal);
  assert.deepEqual([...col((m) => m.income), s.income], fx.expected.incomeTotal);
  assert.deepEqual([...col((m) => m.balance), s.balance], fx.expected.balance);
});

test('区分別の合計がExcelと一致する（45〜50行）', () => {
  for (const c of B.CATS) assert.deepEqual([...col((m) => m.cats[c.no]), s.catTotals[c.no]], fx.expected.byCat[c.no], c.label);
});

test('決済手段別の合計がExcelと一致する（34〜40行）', () => {
  for (const [pay, vals] of Object.entries(fx.expected.byPay)) {
    const mine = s.byPay[pay] || Array(12).fill(0);
    assert.deepEqual([...mine, mine.reduce((a, b) => a + b, 0)], vals, pay);
  }
});

test('残高（前年末の口座残高＋収支の累計）がExcelと一致する（67行）', () => {
  assert.equal(s.startTotal, fx.expected.startTotal);
  assert.deepEqual(col((m) => m.running), fx.expected.running);
});

test('口座残高を入れると記録との差額が出て、一致した月を数える', () => {
  const yy = B.sampleYear({ nextId: 1 });
  // 1月：記録どおりの残高（前年末4,100,000＋1月の収支）に合わせる
  const jan = B.summarize(yy).months[0].running;
  yy.accounts.forEach((a, k) => { a.m[0] = k === 0 ? jan - 2100000 : B.num(a.start); });
  yy.accounts.forEach((a, k) => { a.m[1] = k === 0 ? B.num(a.m[0]) : B.num(a.start); });  // 2月：動きを入れ忘れ
  const t = B.summarize(yy);
  assert.equal(t.months[0].diff, 0);
  assert.equal(t.months[1].diff, t.months[1].balance);
  assert.equal(t.matched, 1);
});

test('ライフプランへの金額：12か月そろえば合計、足りなければ月平均×12（万円）', () => {
  const p = B.toPlan(y);
  assert.equal(p.months, 12);
  assert.equal(p.living, 299.7);
  assert.equal(p.housing, 140);
  assert.equal(p.insurance, 12);
  assert.equal(p.car, 8.5);
  assert.equal(p.invest, 36);
  assert.equal(p.sal1, 416);     // 給与316万＋ボーナス100万（手取り）
  assert.equal(p.sal2, 240);
  assert.equal(p.cash, 410);
  // 3か月だけ記録 → 平均×12
  const q = B.sampleYear({ nextId: 1 });
  [...q.items, ...q.incomes].forEach((r) => { for (let i = 3; i < 12; i++) r.m[i] = ''; });
  const p3 = B.toPlan(q);
  assert.equal(p3.months, 3);
  assert.equal(p3.housing, Math.round((75000 + 100000 + 75000) * 4 / 1000) / 10);
  assert.equal(B.reliability(p3.months, 0).label, 'まずまず');
  assert.equal(B.reliability(12, 2).label, 'とても高い');
  assert.equal(B.toPlan(B.newYear({ nextId: 1 })), null);
});

test('新しい年は、項目と口座の名前を引き継ぎ、前の年の年末の残高から始まる', () => {
  const bk = { nextId: 1 };
  const prev = B.sampleYear(bk);
  prev.accounts[0].m[11] = 2345678;
  prev.accounts.slice(1).forEach((a) => { a.m[11] = ''; });
  const next = B.newYear(bk, prev);
  assert.deepEqual(next.items.map((i) => i.name), prev.items.map((i) => i.name));
  assert.ok(next.items.every((i) => i.m.every((v) => v === '')));
  assert.equal(next.accounts[0].start, 2345678);
  assert.equal(next.accounts[1].start, 200000);   // 年末を入れていない口座は前の年の前年末のまま
  assert.equal(next.invests[0].start, 600000);    // 投資は前の年の「今年末（予想）」から
});

test('ふりかえり：いつもとの違い・貯蓄に回せた割合・続けた月数', () => {
  const yy = B.sampleYear({ nextId: 1 });
  const out = B.insights(yy, 5, null).map((x) => x.text);   // 6月：住宅ローンのボーナス払い、通勤定期
  assert.ok(out.some((t) => /住宅ローンが、いつもより＋200,000円/.test(t)), out.join(' / '));
  assert.ok(out.some((t) => /収入の\d+％を、貯蓄や投資に回せました/.test(t)));
  assert.ok(out.some((t) => /6か月続けて記録しています/.test(t)));
});

test('給与天引きの支出は、収入（振込額）にも足して、手取り＝振込額＋任意の天引きにそろえる', () => {
  const bk = { nextId: 1 };
  const yr = B.newYear(bk);
  yr.items.forEach((it) => { it.m = it.m.map(() => ''); });
  yr.incomes.forEach((r) => { r.m = r.m.map(() => ''); });
  yr.accounts.forEach((a) => { a.start = 1000000; a.m = a.m.map(() => ''); });
  yr.items[0].m[0] = 100000;                                            // 口座から払う支出
  yr.items.push({ id: 99, name: '財形貯蓄', cat: 6, pay: B.DEDUCTED, day: '', m: [20000, '', '', '', '', '', '', '', '', '', '', ''] });
  yr.incomes[0].m[0] = 300000;                                          // 振込額
  const sm = B.summarize(yr), m = sm.months[0];
  assert.equal(m.deducted, 20000);
  assert.equal(m.income, 320000);                                       // 振込額＋天引き
  assert.equal(m.expense, 120000);
  assert.equal(m.running - sm.startTotal, 200000);                      // 口座の増え方は 振込額−口座から払った支出 のまま
  const p = B.toPlan(yr);
  assert.equal(p.sal1, Math.round(320000 * 12 / 1000) / 10);
});
