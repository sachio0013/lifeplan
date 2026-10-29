/*
 * 家計簿（年間収支）
 *
 * Excel「ライフプラン表」の「家計簿（年間収支）」シートと同じ考え方で、1年を1枚にまとめる。
 *   1. 支出：項目ごとに区分（1〜6）・決済手段・引落日と、1〜12月の金額
 *   2. 決済手段別の合計（カードの明細や口座の引落と照らし合わせる）
 *   3. 区分別の合計（区分はライフプランの入力項目に対応する）
 *   4. 手取収入（給与・ボーナス・その他）と月ごとの備考
 *   5. 収支＝収入−支出（積立投資も支出に含む）、残高＝前年末の口座残高＋収支の累計
 *   6. 口座残高を入れると「記録と残高の差額」を出す（0なら記録に漏れがない）
 *   7. 投資資産の前年末と今年末（予想）
 * 決済手段が「給与天引き」の支出（生命保険料・財形・持株会・DCの個人の上乗せなど）は、口座を通らない。
 * 収入（振込額）に同じ額を足して、手取り＝振込額＋任意の天引き としてそろえる（残高の照合はずれない）。
 * 金額の単位は円。ライフプランへ渡すときに万円にする。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifePlanBook = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 区分（Excelの番号と同じ）。plan はライフプランのどの入力に当たるか
  var CATS = [
    { no: 1, label: '基本生活費', plan: '基本生活費' },
    { no: 2, label: '住宅費', plan: '住宅費' },
    { no: 3, label: '教育費', plan: '教育費' },
    { no: 4, label: '保険', plan: '保険料' },
    { no: 5, label: '車関連', plan: '自動車の維持費' },
    { no: 6, label: '積立投資', plan: '投資の積立' }
  ];
  var INCOME_KINDS = [
    { key: 'sal1', label: '給与（家族１）' },
    { key: 'bonus1', label: 'ボーナス（家族１）' },
    { key: 'sal2', label: '給与（家族２）' },
    { key: 'bonus2', label: 'ボーナス（家族２）' },
    { key: 'other', label: 'その他' }
  ];

  function num(v) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[,，\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function filled(v) { return v !== '' && v != null && isFinite(num(v)) && String(v).trim() !== ''; }
  function blank12() { var a = []; for (var i = 0; i < 12; i++) a.push(''); return a; }
  function sum(a) { return a.reduce(function (s, v) { return s + num(v); }, 0); }

  // ---- 1年分のひな形 ----

  // はじめて家計簿をつける人向けの項目（Excelの記入例を、よくある形にまとめたもの）
  var STARTER = [
    ['食費・日用品', 1, 'カード'], ['おこづかい', 1, '現金'], ['通信・携帯', 1, 'カード'], ['電気・ガス・水道', 1, 'カード'],
    ['娯楽・レジャー', 1, 'カード'], ['被服費', 1, 'カード'], ['医療費', 1, '現金'], ['その他', 1, '現金'],
    ['家賃・住宅ローン', 2, '口座振替'], ['管理費・固定資産税', 2, '口座振替'],
    ['学費・習い事', 3, '口座振替'], ['保険料', 4, '口座振替'], ['ガソリン・車関連', 5, 'カード'], ['NISA・iDeCoの積立', 6, '口座振替']
  ];
  var STARTER_INCOME = [['給与手取り（家族１）', 'sal1'], ['ボーナス手取り（家族１）', 'bonus1'], ['給与手取り（家族２）', 'sal2'], ['ボーナス手取り（家族２）', 'bonus2'], ['児童手当', 'other'], ['その他', 'other']];

  // 新しい年を作る。前の年があれば、項目・口座の名前を引き継ぎ、口座と投資の「前年末」に前の年の12月（年末）の値を入れる
  function newYear(book, prev) {
    var id = function () { return book.nextId++; };
    if (prev) {
      return {
        // 予算は前の年の予算を引き継ぐ（なければ空）
        items: prev.items.map(function (it) { return { id: id(), name: it.name, cat: it.cat, pay: it.pay, day: it.day, m: blank12(), b: it.b ? it.b.slice() : blank12() }; }),
        incomes: prev.incomes.map(function (r) { return { id: id(), name: r.name, kind: r.kind, m: blank12(), b: r.b ? r.b.slice() : blank12() }; }),
        notes: blank12(),
        accounts: prev.accounts.map(function (a) {
          var last = ''; for (var i = 11; i >= 0; i--) if (filled(a.m[i])) { last = a.m[i]; break; }
          return { id: id(), name: a.name, start: last !== '' ? num(last) : a.start, m: blank12() };
        }),
        invests: prev.invests.map(function (v) { return { id: id(), name: v.name, start: filled(v.end) ? num(v.end) : v.start, end: '' }; })
      };
    }
    return {
      items: STARTER.map(function (s) { return { id: id(), name: s[0], cat: s[1], pay: s[2], day: '', m: blank12(), b: blank12() }; }),
      incomes: STARTER_INCOME.map(function (s) { return { id: id(), name: s[0], kind: s[1], m: blank12(), b: blank12() }; }),
      notes: blank12(),
      accounts: [{ id: id(), name: '●●銀行①', start: '', m: blank12() }, { id: id(), name: '●●銀行②', start: '', m: blank12() }, { id: id(), name: '●●証券', start: '', m: blank12() }],
      invests: [{ id: id(), name: 'NISA', start: '', end: '' }, { id: id(), name: 'iDeCo', start: '', end: '' }]
    };
  }

  // Excelの記入例（家計簿（年間収支）シートの入力そのもの）
  var SAMPLE = {
    items: [
      ['食費・日用品等', 1, '現金', '', [60000]], ['夫婦こづかい', 1, '現金', '', [50000]], ['食費・日用品等', 1, 'カード', '', [30000]],
      ['家具家電', 1, 'カード', '', [15000]], ['娯楽レジャー', 1, 'カード', '', [20000]], ['被服費', 1, 'カード', '', [10000]],
      ['習い事', 3, 'カード', '', [10000]], ['通信・携帯', 1, 'カード', '', [10000]],
      ['ガス', 1, 'カード', '', [7000, 10000, 10000, 10000, 10000, 10000, 10000, 5000, 5000, 5000, 5000, 5000]],
      ['電気', 1, 'カード', '', [7000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000]],
      ['上下水道', 1, 'カード', '', [20000, '', 20000, '', 20000, '', 20000, '', 20000, '', 20000, '']],
      ['新聞', 1, 'カード', '', [4000]], ['ガソリン', 1, 'カード', '', [5000]],
      ['車関連', 5, 'カード', '', ['', '', '', '', '', '', 35000, '', 50000, '', '', '']],
      ['通勤定期', 1, 'カード', '', ['', '', '', '', '', 80000, '', '', '', '', 80000, '']],
      ['保険１', 4, 'カード', '', [4000]], ['その他', 1, 'カード', '', ['']],
      ['住宅ローン', 2, '口振(XX銀行)', '26日', [50000, 50000, 50000, 50000, 50000, 250000, 50000, 50000, 50000, 50000, 50000, 250000]],
      ['管理修繕等', 2, '口振(YY銀行)', '26日', [25000]],
      ['固定資産税', 2, '口振(AA銀行)', '2.4.7.12末', [0, 25000, 0, 25000, 0, 0, 25000, 0, 0, 0, 0, 25000]],
      ['学費', 3, '口振(YY銀行)', '5日', [35000]], ['保険２', 4, '口振(YY銀行)', '27日', [2000]],
      ['保険３', 4, '口振(AA銀行)', '5日', [4000]], ['医療費', 1, '現金', '', [5000]], ['その他', 1, '現金', '', ['']],
      ['NISA', 6, '口振(XX銀行)', '', [30000]]
    ],
    incomes: [
      ['給与手取り（夫）', 'sal1', [250000, 250000, 330000, 250000, 250000, 250000, 250000, 250000, 330000, 250000, 250000, 250000]],
      ['ボーナス手取り（夫）', 'bonus1', [0, 0, 0, 0, 0, 400000, 0, 0, 0, 0, 0, 600000]],
      ['児童手当', 'other', [0, 40000, 0, 0, 0, 40000, 0, 0, 0, 40000, 0, 0]],
      ['給与手取り（妻）', 'sal2', [200000]],
      ['ボーナス手取り（妻）', 'bonus2', [0]],
      ['その他１', 'other', [0]],
      ['その他２', 'other', [0, 40000, 0, 0, 0, 40000, 0, 0, 0, 40000, 0, 200000]]
    ],
    notes: ['', '児童手当', '定期代', '', '', '児童手当', '', '', '定期代', '児童手当', '', '所得税還付'],
    accounts: [['XX銀行', 2000000], ['AA銀行', 200000], ['ZZ銀行', 300000], ['AA銀行', 100000], ['BB銀行', 1500000]],
    invests: [['NISA', 300000, 600000], ['iDeCo', 300000, 600000], ['株', 0, 0]]
  };
  // 1つだけの値は12か月同じ金額
  function expand(a) { return a.length === 1 ? blank12().map(function () { return a[0]; }) : a.slice(); }

  function sampleYear(book) {
    var id = function () { return book.nextId++; };
    return {
      sample: true,
      items: SAMPLE.items.map(function (s) { return { id: id(), name: s[0], cat: s[1], pay: s[2], day: s[3], m: expand(s[4]) }; }),
      incomes: SAMPLE.incomes.map(function (s) { return { id: id(), name: s[0], kind: s[1], m: expand(s[2]) }; }),
      notes: SAMPLE.notes.slice(),
      accounts: SAMPLE.accounts.map(function (a) { return { id: id(), name: a[0], start: a[1], m: blank12() }; }),
      invests: SAMPLE.invests.map(function (v) { return { id: id(), name: v[0], start: v[1], end: v[2] }; })
    };
  }

  // ---- 集計 ----

  function expenseAt(y, i) { return y.items.reduce(function (s, it) { return s + num(it.m[i]); }, 0); }
  var DEDUCTED = '給与天引き';
  function deductedAt(y, i) { return y.items.reduce(function (s, it) { return s + (it.pay === DEDUCTED ? num(it.m[i]) : 0); }, 0); }
  function incomeAt(y, i) { return y.incomes.reduce(function (s, r) { return s + num(r.m[i]); }, 0) + deductedAt(y, i); }
  function catAt(y, i, no) { return y.items.reduce(function (s, it) { return s + (it.cat === no ? num(it.m[i]) : 0); }, 0); }
  function startTotal(y) { return y.accounts.reduce(function (s, a) { return s + num(a.start); }, 0); }

  // その月に何か記録があるか（支出か収入に、0以外の金額が1つでも入っている）
  function recordedAt(y, i) {
    return y.items.some(function (it) { return num(it.m[i]) !== 0; }) || y.incomes.some(function (r) { return num(r.m[i]) !== 0; });
  }

  // 月ごと・年間の集計（Excelの 31行・34〜40行・45〜50行・62行・66〜67行に当たる）
  function summarize(y) {
    var months = [];
    var running = startTotal(y);
    for (var i = 0; i < 12; i++) {
      var exp = expenseAt(y, i), inc = incomeAt(y, i);
      var bal = inc - exp;
      running += bal;
      var cats = {};
      CATS.forEach(function (c) { cats[c.no] = catAt(y, i, c.no); });
      // 口座残高がすべて入っている月だけ、記録との差額を出す
      var actual = y.accounts.length && y.accounts.every(function (a) { return filled(a.m[i]); })
        ? y.accounts.reduce(function (s, a) { return s + num(a.m[i]); }, 0) : null;
      var bExp = bExpenseAt(y, i), bInc = bIncomeAt(y, i), bCats = {};
      CATS.forEach(function (c) { bCats[c.no] = bCatAt(y, i, c.no); });
      var rec = recordedAt(y, i), closed = !!(y.closed && y.closed[i]);
      months.push({
        index: i, expense: exp, income: inc, deducted: deductedAt(y, i), balance: bal, running: running, cats: cats,
        recorded: rec, actual: actual, diff: actual == null ? null : running - actual,
        bExpense: bExp, bIncome: bInc, bBalance: bInc - bExp, bCats: bCats, closed: closed,
        // 見込み：確定した月か記録のある月は実績、それ以外は予算
        fBalance: closed || rec ? bal : bInc - bExp
      });
    }
    var byPay = {};
    y.items.forEach(function (it) {
      var k = it.pay || 'その他';
      if (!byPay[k]) byPay[k] = blank12().map(function () { return 0; });
      for (var i = 0; i < 12; i++) byPay[k][i] += num(it.m[i]);
    });
    var catTotals = {};
    CATS.forEach(function (c) { catTotals[c.no] = sum(months.map(function (m) { return m.cats[c.no]; })); });
    return {
      months: months,
      expense: sum(months.map(function (m) { return m.expense; })),
      income: sum(months.map(function (m) { return m.income; })),
      deducted: sum(months.map(function (m) { return m.deducted; })),
      balance: sum(months.map(function (m) { return m.balance; })),
      catTotals: catTotals,
      byPay: byPay,
      startTotal: startTotal(y),
      recorded: months.filter(function (m) { return m.recorded; }).length,
      matched: months.filter(function (m) { return m.diff != null && Math.abs(m.diff) < 1; }).length,
      bExpense: sum(months.map(function (m) { return m.bExpense; })),
      bIncome: sum(months.map(function (m) { return m.bIncome; })),
      bBalance: sum(months.map(function (m) { return m.bBalance; })),
      fBalance: sum(months.map(function (m) { return m.fBalance; })),
      closed: months.filter(function (m) { return m.closed; }).length,
      hasBudget: hasBudget(y)
    };
  }

  // ---- 予算（予算→実績） ----
  //
  // 年のはじめに、項目ごとに12か月分の予算（b、円）を入れ、毎月の実績（m）とくらべる。
  // 月の記録が終わったら確定する（y.closed[月]、会社の月締めと同じ。取り消せる）。

  function bAt(row, i) { return row.b ? num(row.b[i]) : 0; }
  function bExpenseAt(y, i) { return y.items.reduce(function (s, it) { return s + bAt(it, i); }, 0); }
  function bDeductedAt(y, i) { return y.items.reduce(function (s, it) { return s + (it.pay === DEDUCTED ? bAt(it, i) : 0); }, 0); }
  function bIncomeAt(y, i) { return y.incomes.reduce(function (s, r) { return s + bAt(r, i); }, 0) + bDeductedAt(y, i); }
  function bCatAt(y, i, no) { return y.items.reduce(function (s, it) { return s + (it.cat === no ? bAt(it, i) : 0); }, 0); }
  function hasBudget(y) {
    var any = function (r) { return !!r.b && r.b.some(function (v) { return num(v) !== 0; }); };
    return y.items.some(any) || y.incomes.some(any);
  }

  // 基本生活費を項目に分ける割合。総務省「家計調査」（2024年・二人以上の世帯）の費目の構成をもとにした目安
  // （食料と家具・家事用品→食費・日用品、光熱・水道、通信、教養娯楽、被服及び履物、保健医療、こづかい、その他）
  var BASIC_SHARES = [
    [/食|日用/, 0.41], [/こづかい|小遣/, 0.06], [/通信|携帯|スマホ|ネット/, 0.05], [/電気|ガス|水道|光熱/, 0.09],
    [/娯楽|レジャー|趣味|旅行/, 0.12], [/被服|衣|服/, 0.04], [/医療|病院|薬/, 0.06], [/その他/, 0.17]
  ];
  var r100 = function (v) { return Math.round(v / 100) * 100; };
  function setEven(row, yen) { row.b = blank12().map(function () { return r100(yen / 12); }); }

  // ライフプランのその年の金額（万円）から予算を作る。
  // p = { living, housing, housingLoan, edu, insurance, car, carBuy, invest, sal1, sal2 }
  // 区分の中の項目には、基本生活費は上の割合で、住宅費は返済と管理費等に、ほかは区分の最初の項目に入れる。
  // 給与は家族１が月の手取り×12＋ボーナス（6月と12月に1か月分ずつ）＝年の手取り、家族２は12等分。入れられなかった区分を返す
  function budgetFromPlan(y, p) {
    var yen = function (man) { return num(man) * 10000; };
    var missed = [];
    y.items.forEach(function (it) { it.b = blank12(); });
    CATS.forEach(function (c) {
      var rows = y.items.filter(function (it) { return it.cat === c.no; });
      var total = yen({ 1: p.living, 2: p.housing, 3: p.edu, 4: p.insurance, 5: num(p.car) - num(p.carBuy), 6: p.invest }[c.no]);
      if (!rows.length) { if (total > 0) missed.push(c.label); return; }
      if (c.no === 1) {
        var w = rows.map(function (it) {
          for (var k = 0; k < BASIC_SHARES.length; k++) if (BASIC_SHARES[k][0].test(it.name)) return { k: k, w: BASIC_SHARES[k][1] };
          return { k: -1, w: 0.03 };
        });
        // 同じ費目に当たる項目が複数あれば（現金とカードなど）、割合を分け合う
        w.forEach(function (x) { if (x.k >= 0) x.w /= w.filter(function (z) { return z.k === x.k; }).length; });
        var tw = w.reduce(function (a, x) { return a + x.w; }, 0);
        rows.forEach(function (it, k) { setEven(it, total * w[k].w / tw); });
      } else if (c.no === 2) {
        var up = rows.filter(function (it) { return /管理|固定資産|修繕/.test(it.name); });
        var main = rows.filter(function (it) { return up.indexOf(it) < 0; });
        var loan = num(p.housingLoan) > 0 ? yen(p.housingLoan) : total;
        if (main.length) setEven(main[0], up.length ? loan : total);
        if (up.length) setEven(up[0], main.length ? Math.max(0, total - loan) : total);
      } else {
        setEven(rows[0], total);
      }
    });
    // 車の買い替えは4月にまとめて
    if (num(p.carBuy) > 0) {
      var car = y.items.filter(function (it) { return it.cat === 5; })[0];
      if (car) car.b[3] = num(car.b[3]) + yen(p.carBuy); else missed.push('車の買い替え');
    }
    y.incomes.forEach(function (r) { if (r.kind !== 'other') r.b = blank12(); else if (!r.b) r.b = blank12(); });
    var first = function (kind) { return y.incomes.filter(function (r) { return r.kind === kind; })[0]; };
    var s1 = yen(p.sal1), s2 = yen(p.sal2);
    if (s1 > 0) {
      var b1 = first('bonus1'), m1 = first('sal1');
      var per = b1 ? s1 / 14 : s1 / 12;
      if (m1) m1.b = blank12().map(function () { return r100(per); }); else missed.push('家族１の給与');
      if (b1) { b1.b[5] = r100(per); b1.b[11] = r100(per); }
    }
    if (s2 > 0) { var m2 = first('sal2'); if (m2) m2.b = blank12().map(function () { return r100(s2 / 12); }); else missed.push('家族２の給与'); }
    return missed;
  }

  // ある月の予算を、ほかの11か月にも入れる
  function copyBudget(row, from) {
    if (!row.b) row.b = blank12();
    var v = row.b[from];
    row.b = blank12().map(function () { return v; });
  }

  // 月を確定したときのひとこと：収支・収入・支出の予算との差と、予算をいちばん超えた項目・いちばん下回った項目
  function monthReview(y, i) {
    var s = summarize(y), m = s.months[i];
    var byName = function (f) {
      var o = {};
      y.items.forEach(function (it) { if (it.cat !== 6) o[it.name] = (o[it.name] || 0) + f(it); });
      return o;
    };
    var act = byName(function (it) { return num(it.m[i]); }), bud = byName(function (it) { return bAt(it, i); });
    var d = Object.keys(act).map(function (n) { return { name: n, d: act[n] - (bud[n] || 0) }; });
    d.sort(function (a, b) { return b.d - a.d; });
    var over = d[0] && d[0].d >= 1000 ? d[0] : null;
    var under = d.length && d[d.length - 1].d <= -1000 ? d[d.length - 1] : null;
    return { balance: m.balance - m.bBalance, income: m.income - m.bIncome, expense: m.expense - m.bExpense, over: over, under: under, hasBudget: s.hasBudget, diff: m.diff };
  }

  // 基本生活費などの平均（年・万円）。excelcf.net「年齢層別2人・3人・4人・5人以上家族の生活費と世帯年収別生活費」の表。
  // もとは総務省「家計調査」2024年12月（二人以上の世帯。a313 世帯人員・世帯主の年齢階級別、a203 年間収入階級別）を、
  // ライフプラン表の区分（1 基本生活費・2 住居費・3 教育費・4 保険料・5 自動車）に編集したもの。保険料は「生命保険に関する全国実態調査」（2024年度）。
  // 値は [基本生活費, 住居費, 教育費, 保険料, 自動車]
  var KAKEI = {
    source: '総務省「家計調査」2024年12月（二人以上の世帯）をもとに編集',
    all: { 2: [336, 33, 0, 33, 34], 3: [345, 24, 11, 33, 36], 4: [366, 25, 42, 33, 28], 5: [394, 15, 29, 33, 41] },
    byAge: [
      { max: 34, label: '34歳以下', v: { 2: [246, 68, 0, 31, 20], 3: [283, 36, 3, 31, 51], 4: [300, 19, 6, 31, 21], 5: [340, 10, 12, 31, 128] } },
      { max: 44, label: '35〜44歳', v: { 2: [290, 50, 1, 34, 24], 3: [297, 26, 9, 34, 46], 4: [339, 12, 16, 34, 25], 5: [362, 14, 19, 34, 37] } },
      { max: 54, label: '45〜54歳', v: { 2: [355, 68, 0, 38, 69], 3: [343, 21, 22, 38, 37], 4: [394, 38, 62, 38, 35], 5: [386, 15, 48, 38, 32] } },
      { max: 64, label: '55〜64歳', v: { 2: [374, 29, 0, 38, 38], 3: [378, 26, 18, 38, 45], 4: [399, 12, 82, 38, 27], 5: [443, 22, 54, 38, 39] } },
      { max: 999, label: '65歳以上', v: { 2: [328, 28, 0, 31, 29], 3: [352, 24, 0, 31, 23], 4: [339, 36, 7, 31, 16], 5: [488, 15, 7, 31, 27] } }
    ],
    // 世帯年収（税込・万円）の階級：[上限, 表示, 値]
    byIncome: [
      [200, '200万円未満', [213, 33, 0, 25, 8]], [250, '200〜250万円', [233, 12, 1, 24, 14]], [300, '250〜300万円', [243, 15, 0, 24, 17]],
      [350, '300〜350万円', [283, 24, 0, 25, 15]], [400, '350〜400万円', [327, 34, 3, 25, 34]], [450, '400〜450万円', [322, 19, 2, 25, 20]],
      [500, '450〜500万円', [325, 15, 2, 25, 64]], [550, '500〜550万円', [334, 42, 3, 32, 21]], [600, '550〜600万円', [323, 28, 4, 32, 26]],
      [650, '600〜650万円', [346, 32, 7, 34, 49]], [700, '650〜700万円', [334, 33, 8, 34, 45]], [750, '700〜750万円', [337, 24, 18, 40, 31]],
      [800, '750〜800万円', [354, 62, 14, 40, 28]], [900, '800〜900万円', [380, 24, 13, 40, 45]], [1000, '900〜1,000万円', [412, 42, 38, 40, 39]],
      [1250, '1,000〜1,250万円', [430, 22, 46, 55, 40]], [1500, '1,250〜1,500万円', [497, 27, 53, 55, 68]], [Infinity, '1,500万円以上', [624, 27, 30, 55, 46]]
    ]
  };
  // 世帯主の年齢と家族の人数（2人以上。5人以上は5）から
  function refByAge(age, size) {
    if (!(size >= 2)) return null;
    var n = Math.min(5, Math.round(size));
    for (var k = 0; k < KAKEI.byAge.length; k++) {
      var g = KAKEI.byAge[k];
      if (age <= g.max) { var v = g.v[n]; return { label: '世帯主' + g.label + '・' + (n === 5 ? '5人以上' : n + '人') + 'の世帯', basic: v[0], housing: v[1], edu: v[2], insurance: v[3], car: v[4] }; }
    }
    return null;
  }
  // 世帯年収（税込・万円）から
  function refByIncome(gross) {
    if (!(gross > 0)) return null;
    for (var k = 0; k < KAKEI.byIncome.length; k++) {
      var r = KAKEI.byIncome[k];
      if (gross < r[0]) return { label: '世帯年収' + r[1] + 'の世帯', basic: r[2][0], housing: r[2][1], edu: r[2][2], insurance: r[2][3], car: r[2][4] };
    }
    return null;
  }
  // 基本生活費の予算だけを、年の額（万円）で入れ直す（項目へは家計調査の費目の割合で分ける）
  function setBasicBudget(y, man) {
    var rows = y.items.filter(function (it) { return it.cat === 1; });
    if (!rows.length) return false;
    var w = rows.map(function (it) {
      for (var k = 0; k < BASIC_SHARES.length; k++) if (BASIC_SHARES[k][0].test(it.name)) return { k: k, w: BASIC_SHARES[k][1] };
      return { k: -1, w: 0.03 };
    });
    w.forEach(function (x) { if (x.k >= 0) x.w /= w.filter(function (z) { return z.k === x.k; }).length; });
    var tw = w.reduce(function (a, x) { return a + x.w; }, 0);
    rows.forEach(function (it, k) { setEven(it, num(man) * 10000 * w[k].w / tw); });
    return true;
  }

  // 記録と口座残高の差額を0にする：記録の方が多ければ「使途不明金」（支出）、少なければ「不明収入」（収入）として、その月に入れる
  function settleDiff(y, i, id) {
    var m = summarize(y).months[i];
    if (m.diff == null || Math.abs(m.diff) < 1) return null;
    var amt = Math.round(Math.abs(m.diff));
    if (m.diff > 0) {
      var it = y.items.filter(function (x) { return x.name === '使途不明金'; })[0];
      if (!it) { it = { id: id(), name: '使途不明金', cat: 1, pay: '現金', day: '', m: blank12(), b: blank12() }; y.items.push(it); }
      it.m[i] = num(it.m[i]) + amt;
      return { kind: 'item', name: it.name, amount: amt };
    }
    var r = y.incomes.filter(function (x) { return x.name === '不明収入'; })[0];
    if (!r) { r = { id: id(), name: '不明収入', kind: 'other', m: blank12(), b: blank12() }; y.incomes.push(r); }
    r.m[i] = num(r.m[i]) + amt;
    return { kind: 'income', name: r.name, amount: amt };
  }

  // ---- ライフプランへ ----

  // 記録した月の平均×12で、1年分の金額にする（12か月そろっていれば、その合計そのもの）。単位は万円
  function toPlan(y) {
    var s = summarize(y);
    var n = s.recorded;
    if (!n) return null;
    var f = 12 / n;
    var man = function (yen) { return Math.round(yen * f / 1000) / 10; };
    var inc = {};
    INCOME_KINDS.forEach(function (k) { inc[k.key] = 0; });
    y.incomes.forEach(function (r) { inc[r.kind] = (inc[r.kind] || 0) + sum(r.m); });
    inc.sal1 += s.deducted;     // 給与天引きは、ふつう家計の中心になる家族１の給与から
    return {
      months: n, matched: s.matched,
      living: man(s.catTotals[1]), housing: man(s.catTotals[2]), edu: man(s.catTotals[3]),
      insurance: man(s.catTotals[4]), car: man(s.catTotals[5]), invest: man(s.catTotals[6]),
      sal1: man(inc.sal1 + inc.bonus1), sal2: man(inc.sal2 + inc.bonus2), other: man(inc.other),
      cash: Math.round(s.startTotal / 1000) / 10,
      invests: y.invests.filter(function (v) { return filled(v.start); }).map(function (v) { return { name: v.name, start: Math.round(num(v.start) / 1000) / 10 }; })
    };
  }

  // 記録の月数（と口座残高と一致した月数）から、プランの裏付けの強さを言葉にする
  function reliability(months, matched) {
    var lv = months >= 12 ? 4 : months >= 6 ? 3 : months >= 3 ? 2 : months >= 1 ? 1 : 0;
    var label = ['まだ記録がありません', 'ひとまずの目安', 'まずまず', '高い', 'とても高い'][lv];
    var text = [
      '1か月でも記録すると、実績にもとづいた金額でプランを作れます。',
      '記録が少ないので、季節の出費やボーナスはまだ入っていません。',
      '季節ごとの出費が見えてきました。半年続けると、さらに確かになります。',
      '半年以上の実績です。ボーナスや年に1度の支払いが入ると、もっと確かになります。',
      '1年分の実績です。季節の出費もボーナスも入った、確かな金額です。'
    ][lv];
    if (matched) text += '（うち' + matched + 'か月は、記録が口座の残高と一致しています）';
    return { level: lv, label: label, text: text };
  }

  // ---- 給与明細（Excel ver.1.80「給与シート」） ----
  //
  // 毎月の給与明細と賞与明細（夏・冬）の数字を入れて、1年分の手取りを積み上げる。家族１・家族２の2人分。
  // y.pay = { '1': 明細, '2': 明細 }。明細 = { rows: 14行（0〜11が1〜12月、12が夏の賞与、13が冬の賞与）, bonusMonths: [夏, 冬]（支給月 1〜12） }
  // 1行 = 支給と控除の各項目（円）。
  // このアプリの手取り＝支給合計−社会保険料−所得税−住民税（＝振込額＋任意の天引き）。通勤費は含む。
  // Excelの「年間手取り（振込額ベース）」は任意の天引き（財形・DC等）も引くので、そこだけ違う。
  var PAY_ITEMS = [
    { key: 'base', label: '基本給' }, { key: 'position', label: '役職手当' }, { key: 'skill', label: '資格・職能手当' },
    { key: 'overtime', label: '残業手当' }, { key: 'allowance', label: 'その他手当' }, { key: 'otherPay', label: 'その他支給' },
    { key: 'commute', label: '通勤費' }
  ];
  var DEDUCT_ITEMS = [
    { key: 'health', label: '健康保険', social: true }, { key: 'care', label: '介護保険', social: true },
    { key: 'pension', label: '厚生年金', social: true }, { key: 'employ', label: '雇用保険', social: true },
    { key: 'incomeTax', label: '所得税', tax: true }, { key: 'resident', label: '住民税', tax: true },
    { key: 'voluntary', label: '財形・DC等' }
  ];
  var SLIP_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '夏の賞与', '冬の賞与'];

  function blankSlip() { var o = {}; PAY_ITEMS.concat(DEDUCT_ITEMS).forEach(function (f) { o[f.key] = ''; }); return o; }
  function newPay() { var rows = []; for (var i = 0; i < 14; i++) rows.push(blankSlip()); return { rows: rows, bonusMonths: [6, 12] }; }
  function slipFilled(r) { return !!r && PAY_ITEMS.concat(DEDUCT_ITEMS).some(function (f) { return num(r[f.key]) !== 0; }); }

  // 1枚の明細の合計
  function slipTotals(r) {
    var t = { pay: 0, deduct: 0, social: 0, tax: 0, voluntary: 0, commute: 0 };
    PAY_ITEMS.forEach(function (f) { t.pay += num(r[f.key]); });
    DEDUCT_ITEMS.forEach(function (f) {
      var v = num(r[f.key]);
      t.deduct += v;
      if (f.social) t.social += v; else if (f.tax) t.tax += v; else t.voluntary += v;
    });
    t.commute = num(r.commute);
    t.gross = t.pay - t.commute;                     // 額面（通勤費を除く）
    t.transfer = t.pay - t.deduct;                   // 差引支給額（振込額）
    t.takeHome = t.pay - t.social - t.tax;           // 手取り（振込額＋任意の天引き）
    return t;
  }

  // 1年分の集計。記録が12か月に満たないときは、記録した月の平均×12＋記録した賞与で1年分を見積もる
  function paySummary(p) {
    var keys = ['pay', 'deduct', 'social', 'tax', 'voluntary', 'commute', 'gross', 'transfer', 'takeHome'];
    var zero = function () { var o = {}; keys.forEach(function (k) { o[k] = 0; }); return o; };
    var total = zero(), monthly = zero(), bonus = zero(), items = {};
    PAY_ITEMS.concat(DEDUCT_ITEMS).forEach(function (f) { items[f.key] = 0; });
    var slips = p.rows.map(function (r) { return slipFilled(r) ? slipTotals(r) : null; });
    var months = 0, bonuses = 0;
    p.rows.forEach(function (r, i) {
      var t = slips[i]; if (!t) return;
      PAY_ITEMS.concat(DEDUCT_ITEMS).forEach(function (f) { items[f.key] += num(r[f.key]); });
      keys.forEach(function (k) { total[k] += t[k]; (i < 12 ? monthly : bonus)[k] += t[k]; });
      if (i < 12) months++; else bonuses++;
    });
    var est = {};
    keys.forEach(function (k) { est[k] = months ? monthly[k] / months * 12 + bonus[k] : bonus[k]; });
    return {
      slips: slips, months: months, bonuses: bonuses, items: items, total: total, estimate: est,
      full: months === 12,
      ratio: est.gross > 0 ? Math.round((est.takeHome - est.commute) / est.gross * 1000) / 10 : 0,   // 手取り率（額面に対する。通勤費を除く）
      planMan: Math.round(est.takeHome / 1000) / 10                                                 // ライフプランに入れる万円
    };
  }

  // 明細のふりかえり：前の明細（同じ年の前の月、1月なら前年の12月）と比べて、変わったところとその理由
  function payInsights(p, i, prevPay) {
    var r = p.rows[i];
    if (!slipFilled(r)) return [];
    var out = [], t = slipTotals(r);
    if (i >= 12) {
      out.push({ kind: 'info', text: '賞与からも、社会保険料 ' + fmt(t.social) + '円と所得税 ' + fmt(num(r.incomeTax)) + '円が引かれます。住民税は賞与からは引かれません。' });
      return out;
    }
    var prev = null, prevLabel = '';
    for (var k = i - 1; k >= 0; k--) if (slipFilled(p.rows[k])) { prev = p.rows[k]; prevLabel = SLIP_LABELS[k]; break; }
    if (!prev && prevPay && slipFilled(prevPay.rows[11])) { prev = prevPay.rows[11]; prevLabel = '去年の12月'; }
    if (t.gross > 0) out.push({ kind: 'good', text: '額面 ' + fmt(t.gross) + '円のうち、手取りは ' + fmt(t.takeHome - t.commute) + '円（' + Math.round((t.takeHome - t.commute) / t.gross * 100) + '％）でした' });
    if (!prev) return out;
    var d = function (key) { return num(r[key]) - num(prev[key]); };
    var dRes = d('resident');
    if (dRes !== 0) {
      out.push({ kind: 'info', text: '住民税が ' + fmt(num(prev.resident)) + '円 → ' + fmt(num(r.resident)) + '円 に変わりました。' +
        (i === 5 ? '住民税は去年の所得で決まり、毎年6月に切り替わります（6月だけ端数で少し違う額のこともあります）。' : i === 6 ? '6月は端数の調整で額が違うことがあり、7月からが1年間の額です。' : '') });
    }
    var dSoc = d('health') + d('care') + d('pension');
    if (num(prev.care) === 0 && num(r.care) > 0) out.push({ kind: 'info', text: '介護保険料が引かれはじめました（40歳になった月から、64歳まで）。' });
    else if (dSoc !== 0) {
      out.push({ kind: 'info', text: '社会保険料（健康保険・介護保険・厚生年金）が月 ' + (dSoc > 0 ? '＋' : '−') + fmt(Math.abs(dSoc)) + '円 変わりました。' +
        (i === 8 ? '4〜6月の給与で決まる「標準報酬月額」が、毎年9月に見直されます。' : '昇給などで固定給が大きく変わると、3か月後に見直されることがあります（随時改定）。') });
    }
    var dOver = d('overtime');
    if (dOver !== 0 && (num(r.overtime) || num(prev.overtime))) out.push({ kind: dOver > 0 ? 'good' : 'info', text: '残業手当は' + prevLabel + 'より ' + (dOver > 0 ? '＋' : '−') + fmt(Math.abs(dOver)) + '円 でした。' });
    var dBase = d('base');
    if (dBase > 0) out.push({ kind: 'good', text: '基本給が ' + fmt(dBase) + '円 上がりました。社会保険料は、4〜6月の給与をもとに9月から見直されます。' });
    return out;
  }
  function fmt(v) { return Math.round(v).toLocaleString('ja-JP'); }

  // Excel「給与シート」の記入例（家族１・家族２）
  function samplePay(k) {
    var p = newPay();
    var mon = k === 1
      ? { base: 280000, position: 20000, skill: 15000, overtime: 25000, commute: 12000, health: 17300, pension: 31110, employ: 2100, incomeTax: 6700, resident: 14500 }
      : { base: 180000, skill: 5000, overtime: 8000, commute: 8000, health: 10300, pension: 18300, employ: 1300, incomeTax: 2200, resident: 5000 };
    var bon = k === 1
      ? { base: 600000, health: 29500, pension: 54900, employ: 3600, incomeTax: 30000 }
      : { base: 300000, health: 14800, pension: 27450, employ: 1800, incomeTax: 12000 };
    p.rows.forEach(function (r, i) { var src = i < 12 ? mon : bon; Object.keys(src).forEach(function (key) { r[key] = src[key]; }); });
    return p;
  }

  // ---- 今月のふりかえり ----

  // その月を、それより前の記録した月（最大3か月）の平均と比べる。項目は名前でまとめる（同じ名前は合算）
  function insights(y, i, prevYear) {
    var s = summarize(y), m = s.months[i];
    if (!m.recorded) return [];
    var out = [];
    var hist = [];
    for (var k = i - 1; k >= 0 && hist.length < 3; k--) if (s.months[k].recorded) hist.push({ y: y, i: k });
    if (prevYear) {
      var ps = summarize(prevYear);
      for (var j = 11; j >= 0 && hist.length < 3; j--) if (ps.months[j].recorded) hist.push({ y: prevYear, i: j });
    }
    if (m.income > 0) {
      var rate = Math.round((m.income - m.expense + catAt(y, i, 6)) / m.income * 100);
      out.push({ kind: rate >= 0 ? 'good' : 'bad', text: rate >= 0 ? '収入の' + rate + '％を、貯蓄や投資に回せました' : '支出が収入を上回りました（' + Math.round((m.expense - m.income) / 1000) / 10 + '万円）' });
    }
    if (hist.length) {
      var byName = function (yy, ii) {
        var o = {};
        yy.items.forEach(function (it) { if (it.cat !== 6) o[it.name] = (o[it.name] || 0) + num(it.m[ii]); });
        return o;
      };
      var now = byName(y, i), avg = {};
      hist.forEach(function (h) { var b = byName(h.y, h.i); Object.keys(b).forEach(function (n) { avg[n] = (avg[n] || 0) + b[n] / hist.length; }); });
      var diffs = Object.keys(now).concat(Object.keys(avg)).filter(function (n, k, a) { return a.indexOf(n) === k; }).map(function (n) {
        var a = avg[n] || 0, v = now[n] || 0;
        return { name: n, d: v - a, r: a ? (v - a) / a : null };
      }).filter(function (x) { return Math.abs(x.d) >= 3000 && (x.r == null || Math.abs(x.r) >= 0.15); });
      diffs.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
      diffs.slice(0, 2).forEach(function (x) {
        var yen = Math.round(Math.abs(x.d)).toLocaleString('ja-JP');
        out.push({ kind: x.d > 0 ? 'up' : 'down', text: x.name + 'が、いつもより' + (x.d > 0 ? '＋' : '−') + yen + '円' + (x.r != null ? '（' + (x.d > 0 ? '＋' : '−') + Math.round(Math.abs(x.r) * 100) + '％）' : '') });
      });
    } else {
      out.push({ kind: 'info', text: '記録1か月目です。3か月続けると、いつもとの違いがわかるようになります' });
    }
    if (m.diff != null) {
      out.push(Math.abs(m.diff) < 1
        ? { kind: 'good', text: '記録が口座の残高とぴったり一致しました' }
        : { kind: 'bad', text: '記録と口座の残高が' + Math.round(Math.abs(m.diff)).toLocaleString('ja-JP') + '円ずれています（記録の漏れがないか見てみましょう）' });
    }
    var streak = 0;
    for (var t = i; t >= 0 && s.months[t].recorded; t--) streak++;
    if (streak >= 2) out.push({ kind: 'good', text: streak + 'か月続けて記録しています' });
    return out;
  }

  return {
    CATS: CATS, INCOME_KINDS: INCOME_KINDS, DEDUCTED: DEDUCTED,
    PAY_ITEMS: PAY_ITEMS, DEDUCT_ITEMS: DEDUCT_ITEMS, SLIP_LABELS: SLIP_LABELS,
    newPay: newPay, blankSlip: blankSlip, slipFilled: slipFilled, slipTotals: slipTotals, paySummary: paySummary, payInsights: payInsights, samplePay: samplePay,
    num: num, filled: filled, newYear: newYear, sampleYear: sampleYear,
    summarize: summarize, toPlan: toPlan, reliability: reliability, insights: insights,
    budgetFromPlan: budgetFromPlan, copyBudget: copyBudget, monthReview: monthReview, hasBudget: hasBudget, BASIC_SHARES: BASIC_SHARES,
    KAKEI: KAKEI, refByAge: refByAge, refByIncome: refByIncome, setBasicBudget: setBasicBudget, settleDiff: settleDiff
  };
}));
