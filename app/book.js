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
        items: prev.items.map(function (it) { return { id: id(), name: it.name, cat: it.cat, pay: it.pay, day: it.day, m: blank12() }; }),
        incomes: prev.incomes.map(function (r) { return { id: id(), name: r.name, kind: r.kind, m: blank12() }; }),
        notes: blank12(),
        accounts: prev.accounts.map(function (a) {
          var last = ''; for (var i = 11; i >= 0; i--) if (filled(a.m[i])) { last = a.m[i]; break; }
          return { id: id(), name: a.name, start: last !== '' ? num(last) : a.start, m: blank12() };
        }),
        invests: prev.invests.map(function (v) { return { id: id(), name: v.name, start: filled(v.end) ? num(v.end) : v.start, end: '' }; })
      };
    }
    return {
      items: STARTER.map(function (s) { return { id: id(), name: s[0], cat: s[1], pay: s[2], day: '', m: blank12() }; }),
      incomes: STARTER_INCOME.map(function (s) { return { id: id(), name: s[0], kind: s[1], m: blank12() }; }),
      notes: blank12(),
      accounts: [{ id: id(), name: '普通預金', start: '', m: blank12() }],
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
  function incomeAt(y, i) { return y.incomes.reduce(function (s, r) { return s + num(r.m[i]); }, 0); }
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
      months.push({
        index: i, expense: exp, income: inc, balance: bal, running: running, cats: cats,
        recorded: recordedAt(y, i), actual: actual, diff: actual == null ? null : running - actual
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
      balance: sum(months.map(function (m) { return m.balance; })),
      catTotals: catTotals,
      byPay: byPay,
      startTotal: startTotal(y),
      recorded: months.filter(function (m) { return m.recorded; }).length,
      matched: months.filter(function (m) { return m.diff != null && Math.abs(m.diff) < 1; }).length
    };
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
    CATS: CATS, INCOME_KINDS: INCOME_KINDS,
    num: num, filled: filled, newYear: newYear, sampleYear: sampleYear,
    summarize: summarize, toPlan: toPlan, reliability: reliability, insights: insights
  };
}));
