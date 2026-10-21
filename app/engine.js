/*
 * ライフプラン計算エンジン
 *
 * 入力（アプリの state）から、年ごとのキャッシュフロー表を作る。
 * 計算の各ステップはExcel「ライフプラン表」のCF表シートの数式に対応させている。
 * 対応関係とExcelから外した箇所は docs/ENGINE.md にまとめてある。
 *
 * 金額の単位はすべて万円。率は画面と同じく％で受け取り、ここで小数に直す。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifePlanEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 教育費の単価（入力シート T138:V153）
  var EDU_UNIT = {
    '保育園0～3歳': 50, '保育園4～6歳': 30, '幼稚園（私）': 35, '幼稚園（公）': 20,
    '小学校（公）': 35, '小学校（私）': 185, '中学校（公）': 55, '中学校（私）': 160,
    '高校（公）': 60, '高校（私）': 105,
    '大学（国公）': 65, '大学（私文）': 105, '大学（理）': 140, '大学（薬）': 180, '大学（医歯）': 400,
    '大学院': 100
  };

  // 各段の選択肢と、生年からの在学年オフセット [早生まれ, それ以外]（入力シート D138:H144 の数式）
  var EDU_STAGES = [
    { options: ['保育園0～3歳'], from: [0, 0], to: [2, 3] },
    { options: ['保育園4～6歳', '幼稚園（私）', '幼稚園（公）'], from: [3, 4], to: [5, 6] },
    { options: ['小学校（公）', '小学校（私）'], from: [6, 7], to: [11, 12] },
    { options: ['中学校（公）', '中学校（私）'], from: [12, 13], to: [14, 15] },
    { options: ['高校（公）', '高校（私）'], from: [15, 16], to: [17, 18] },
    { options: ['大学（国公）', '大学（私文）', '大学（理）', '大学（薬）', '大学（医歯）'], from: [18, 19], to: [21, 22] },
    { options: ['大学院'], from: [22, 23], to: [23, 24] }
  ];

  function num(v) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function pct(v) { return num(String(v).replace('%', '')) / 100; }

  function parseDate(s) {
    // 「1990/04/01」（Excelと同じ）と「1990-04-01」（日付入力欄の値）のどちらも受け付ける
    var p = String(s == null ? '' : s).split(/[\/-]/);
    var y = parseInt(p[0], 10), m = parseInt(p[1], 10), d = parseInt(p[2], 10);
    return { y: isFinite(y) ? y : 0, m: isFinite(m) ? m : 1, d: isFinite(d) ? d : 1 };
  }

  // 4/1以前生まれは学年が一つ上（Excel: MONTH<4 OR (MONTH=4 AND DAY=1)）
  function isEarlyBorn(d) { return d.m < 4 || (d.m === 4 && d.d === 1); }

  function birthYearOf(state, memberId) {
    var fam = state.family || [];
    for (var i = 0; i < fam.length; i++) if (fam[i].id === memberId) return parseDate(fam[i].birth).y;
    return 0;
  }

  function baseBirthYear(state) {
    var f = (state.family || [])[0];
    return (f && parseDate(f.birth).y) || 1991;
  }

  // ---- 行の型ごとの「その年の金額」 ----

  // 変更型：その年以前で最も新しい行の金額。同じ年に複数行あれば合算する。
  function changeAt(rows, y) {
    var best = -Infinity, sum = 0;
    (rows || []).forEach(function (r) {
      var ry = num(r.year);
      if (!ry || ry > y) return;
      if (ry > best) { best = ry; sum = num(r.amount); }
      else if (ry === best) sum += num(r.amount);
    });
    return best === -Infinity ? 0 : sum;
  }

  // 一時型：その年の行の合計
  function lumpAt(rows, y) {
    var s = 0;
    (rows || []).forEach(function (r) { if (num(r.year) === y) s += num(r.amount); });
    return s;
  }

  // 期間型：from〜to にその年が入る行の年額の合計
  function rangeAt(rows, y) {
    var s = 0;
    (rows || []).forEach(function (r) {
      var a = num(r.year), b = num(r.toYear);
      if (a && b && a <= y && y <= b) s += num(r.amount);
    });
    return s;
  }

  // ---- 教育費 ----

  // 子供1人分の在学計画。開始年より前に終わる段は含めない。
  function eduPlan(state, child) {
    var sy = num(state.startYear);
    var d = parseDate(child.birth);
    if (!d.y) return [];
    var k = isEarlyBorn(d) ? 0 : 1;
    var picks = (state.edu && state.edu[child.id]) || [];
    var over = (state.eduAmount && state.eduAmount[child.id]) || {};
    var spans = (state.eduSpan && state.eduSpan[child.id]) || {};
    var out = [];
    EDU_STAGES.forEach(function (st, i) {
      var autoTo = d.y + st.to[k];
      if (autoTo < sy) return;
      var autoFrom = Math.max(d.y + st.from[k], sy);
      var span = spans[i] || {};
      var from = span.from != null ? num(span.from) : autoFrom;
      var to = span.to != null ? num(span.to) : autoTo;
      var stage = st.options.indexOf(picks[i]) >= 0 ? picks[i] : st.options[0];
      var amount = over[i] != null ? num(over[i]) : EDU_UNIT[stage];
      out.push({
        index: i, stage: stage, options: st.options,
        from: from, to: to, autoFrom: autoFrom, autoTo: autoTo,
        amount: amount, years: Math.max(0, to - from + 1)
      });
    });
    return out;
  }

  function children(state) {
    return (state.family || []).filter(function (m) { return String(m.relation).indexOf('子供') === 0; });
  }

  // ---- 自動車の買い替え ----

  // 開始年から N 年ごと、家族１が指定年齢になるまで。回ごとの金額の上書きを反映する。
  function carOccurrences(state) {
    var c = state.carBuy || {};
    var from = num(c.fromYear), every = Math.max(1, num(c.every)), until = num(c.untilAge);
    if (!from || !until) return [];
    var endYear = baseBirthYear(state) + until;
    var over = state.carBuyOverride || {};
    var out = [];
    for (var y = from; y <= endYear && out.length < 30; y += every) {
      out.push({ year: y, amount: over[y] != null ? num(over[y]) : num(c.amount) });
    }
    return out;
  }

  // 給与・基本生活費・住宅費の1行目は、入力した年にかかわらず開始年から使う
  // （Excel: CF表の初年度の列が1行目の金額を直接参照している）。
  function anchored(rows, sy) {
    return (rows || []).map(function (r, i) { return i === 0 ? { year: sy, amount: r.amount, growth: r.growth, toYear: r.toYear } : r; });
  }

  // ---- 給与 ----

  // 変更年は「その行の金額をその行の上昇率で開始年から膨らませた額」（Excel: FV）。
  // それ以外は 前年 ×（1＋直近の変更行の上昇率）。退職年齢に達した年から0。
  function salaryAt(state, sal, y, prev) {
    var sy = num(state.startYear);
    var rows = anchored(sal.rows, sy).filter(function (r) { return num(r.year); });
    var v;
    if (y === sy) {
      v = rows.length ? num(rows[0].amount) : 0;
    } else {
      var exact = rows.filter(function (r) { return num(r.year) === y; });
      if (exact.length) {
        v = exact.reduce(function (s, r) { return s + num(r.amount) * Math.pow(1 + pct(r.growth), y - sy); }, 0);
      } else {
        var before = rows.filter(function (r) { return num(r.year) < y; });
        if (!before.length) v = 0;
        else {
          var last = before.reduce(function (a, r) { return num(r.year) >= num(a.year) ? r : a; });
          v = prev * (1 + pct(last.growth));
        }
      }
    }
    var retire = num(sal.retireAge);
    if (retire) {
      var by = birthYearOf(state, sal.memberId) || baseBirthYear(state);
      if (y >= by + retire) v = 0;
    }
    return v;
  }

  // ---- 基本生活費 ----

  // 1行目の金額から始め、変更年は「今の価値で入れた金額」を開始年からの物価上昇で膨らませる（Excel: FV）。
  // それ以外は 前年 ×（1＋物価上昇率）。
  function livingAt(state, y, prev) {
    var infl = pct(state.inflation);
    var sy = num(state.startYear);
    var rows = state.living || [];
    if (y === sy) return rows.length ? num(rows[0].amount) : 0;
    var exact = rows.slice(1).filter(function (r) { return num(r.year) === y; });
    if (exact.length) {
      var base = exact.reduce(function (s, r) { return s + num(r.amount); }, 0);
      return base * Math.pow(1 + infl, y - sy);
    }
    return prev * (1 + infl);
  }

  // ---- 本体 ----

  function compute(state) {
    var sy = num(state.startYear);
    var by = baseBirthYear(state);
    var endYear = by + num(state.endAge);
    var fam = state.family || [];
    var invAssets = (state.assets || []).filter(function (a) { return !a.fixed; });
    var cashAsset = (state.assets || []).filter(function (a) { return a.fixed; })[0] || { amount: 0 };
    var depositRate = pct(state.depositRate || 0);
    var kids = children(state).map(function (c) { return eduPlan(state, c); });
    var cars = carOccurrences(state);

    var prevSalary = (state.salaries || []).map(function () { return 0; });
    var prevLiving = 0;
    var prevDeposit = num(cashAsset.amount);
    var prevInv = invAssets.map(function (a) { return num(a.amount); });

    var years = [];
    for (var y = sy; y <= endYear && years.length < 120; y++) {
      var ages = fam.map(function (m) {
        var b = parseDate(m.birth).y;
        return b && y >= b ? y - b : null;
      });

      // 収入
      var salaries = (state.salaries || []).map(function (s, i) {
        var v = salaryAt(state, s, y, prevSalary[i]);
        prevSalary[i] = v;
        return v;
      });
      var pension =
        lumpAt(state.lump, y) +
        rangeAt(state.corpPension, y) +
        rangeAt(state.privPension, y) +
        changeAt(state.pubPension, y);

      // 支出
      var living = livingAt(state, y, prevLiving); prevLiving = living;
      var housing = changeAt(anchored(state.housing, sy), y) + lumpAt(state.housingLump, y);
      var education = 0;
      kids.forEach(function (plan) {
        plan.forEach(function (st) { if (st.from <= y && y <= st.to) education += st.amount; });
      });
      var insurance = changeAt(state.insurance, y);
      // 維持費は、購入費の「◯歳まで」を過ぎたら車を手放したとみなして0（Excel: 入力シート 225行）
      var carUntil = num((state.carBuy || {}).untilAge);
      var maintenance = carUntil && y - by > carUntil ? 0 : changeAt(state.carCost, y);
      var car = maintenance + cars.reduce(function (s, o) { return s + (o.year === y ? o.amount : 0); }, 0);
      var other = changeAt(state.otherFlow, y) + lumpAt(state.otherLump, y);

      // 投資：積立は前年の預金で足りる分だけ、現金化は前年の残高で足りる分だけ（Excel: 足りなければその年は0）
      var cashLeft = prevDeposit;
      var flows = invAssets.map(function (a, i) {
        var iv = (state.invest && state.invest[a.id]) || { add: [], out: [] };
        var plannedIn = rangeAt(iv.add, y);
        var plannedOut = rangeAt(iv.out, y);
        var contribution = plannedIn > cashLeft ? 0 : plannedIn;
        cashLeft -= contribution;
        var withdrawal = plannedOut > prevInv[i] ? 0 : plannedOut;
        return { contribution: contribution, withdrawal: withdrawal };
      });

      var withdrawals = flows.reduce(function (s, f) { return s + f.withdrawal; }, 0);
      var contributions = flows.reduce(function (s, f) { return s + f.contribution; }, 0);
      var salaryTotal = salaries.reduce(function (s, v) { return s + v; }, 0);

      var incomeTotal = salaryTotal + pension + withdrawals;
      var expenseTotal = living + housing + education + insurance + car + other + contributions;
      var balance = incomeTotal - expenseTotal;

      // 年末残高
      var deposit = (prevDeposit + balance) * (1 + depositRate * 0.8);
      var invBalances = invAssets.map(function (a, i) {
        var r = pct(a.rate), t = pct(a.tax);
        return (prevInv[i] - flows[i].withdrawal) * (1 + r * (1 - t)) + flows[i].contribution;
      });
      var invTotal = invBalances.reduce(function (s, v) { return s + v; }, 0);

      years.push({
        year: y,
        age: y - by,
        ages: ages,
        income: { salaries: salaries, pension: pension, withdrawals: flows.map(function (f) { return f.withdrawal; }), total: incomeTotal },
        expense: {
          living: living, housing: housing, education: education, insurance: insurance, car: car, other: other,
          contributions: flows.map(function (f) { return f.contribution; }), total: expenseTotal
        },
        balance: balance,
        assets: { deposit: deposit, investments: invBalances, investTotal: invTotal, total: deposit + invTotal }
      });

      prevDeposit = deposit;
      prevInv = invBalances;
    }

    // 預金が最初にマイナスになる年と、最も落ち込む額
    var shortfall = null, minDeposit = Infinity;
    years.forEach(function (r) {
      if (r.assets.deposit < minDeposit) minDeposit = r.assets.deposit;
      if (!shortfall && r.assets.deposit < 0) shortfall = { year: r.year, age: r.age };
    });
    if (shortfall) shortfall.minDeposit = minDeposit;

    var last = years[years.length - 1];
    return {
      years: years,
      investNames: invAssets.map(function (a) { return a.name; }),
      salaryLabels: (state.salaries || []).map(function (s) { return s.who; }),
      endTotal: last ? last.assets.total : 0,
      endAge: last ? last.age : null,
      shortfall: shortfall
    };
  }

  // ---- 入力の確認 ----

  function isDate(s) {
    var m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(y, mo - 1, d);
    return y >= 1900 && y <= 2100 && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  // 計算できない入力や、入れても計算に使われない入力を探す。
  // at は画面上の場所（'start'、'fam:<id>'、'row:<項目>:<id>' など）、field はその中の欄。
  // level は 'error'（結果が正しくならない）か 'warn'（計算はするが、意図と違いそう）。
  function validate(state) {
    var out = [];
    function add(at, field, level, msg) { out.push({ at: at, field: field, level: level, msg: msg }); }

    var sy = num(state.startYear);
    var fam = state.family || [];
    if (!(sy >= 1990 && sy <= 2100 && sy === Math.floor(sy))) {
      add('start', 'start', 'error', '開始年は1990〜2100の西暦で入れてください');
      return out;
    }

    fam.forEach(function (m, i) {
      var at = 'fam:' + m.id;
      if (!m.birth) {
        if (i === 0) add(at, 'birth', 'error', '家族１の生年月日は必須です（年齢と期間の計算に使います）');
        return;
      }
      if (!isDate(m.birth)) { add(at, 'birth', 'error', '生年月日が正しい日付になっていません'); return; }
      var b = parseDate(m.birth).y;
      if (i === 0 && b > sy) add(at, 'birth', 'error', '家族１が開始年より後に生まれています');
      else if (i === 0 && sy - b < 18) add(at, 'birth', 'warn', '家族１は開始年に' + (sy - b) + '歳です。家計の中心になる人を家族１にします');
    });

    var by = baseBirthYear(state);
    var endAge = num(state.endAge);
    var age0 = sy - by;
    if (endAge <= age0) { add('start', 'endAge', 'error', '終了年齢は、開始年の家族１の年齢（' + age0 + '歳）より上にしてください'); return out; }
    if (endAge > 120) { add('start', 'endAge', 'error', '終了年齢は120歳までで入れてください'); return out; }
    var ey = by + endAge;
    var outside = '計算期間（' + sy + '〜' + ey + '年）の外なので、計算に入りません';

    function rate(at, field, v) {
      if (Math.abs(num(v)) > 10) add(at, field, 'warn', num(v) + '％はとても大きな率です。1.5％なら「1.5」と入れます');
    }
    function amount(at, r) {
      if (num(r.amount) < 0) add(at, 'amount', 'warn', 'マイナスの金額になっています');
    }
    function noYear(at, r) {
      if (num(r.year)) return false;
      add(at, 'year', 'error', '年を入れてください');
      return true;
    }
    // 期間型（から〜まで）
    function range(at, r) {
      if (noYear(at, r)) return;
      amount(at, r);
      var a = num(r.year), b = num(r.toYear);
      if (!b) add(at, 'toYear', 'error', '「まで」の年を入れてください');
      else if (b < a) add(at, 'toYear', 'error', '「まで」の年が「から」の年より前です');
      else if (b < sy || a > ey) add(at, 'year', 'warn', outside);
    }

    ['lump', 'housingLump', 'otherLump'].forEach(function (key) {
      (state[key] || []).forEach(function (r) {
        var at = 'row:' + key + ':' + r.id;
        if (noYear(at, r)) return;
        amount(at, r);
        if (num(r.year) < sy || num(r.year) > ey) add(at, 'year', 'warn', outside);
      });
    });
    ['pubPension', 'insurance', 'carCost', 'otherFlow', 'living', 'housing'].forEach(function (key) {
      var anchoredKey = key === 'living' || key === 'housing';
      (state[key] || []).forEach(function (r, i) {
        var at = 'row:' + key + ':' + r.id;
        amount(at, r);
        if (anchoredKey && i === 0) return;
        if (noYear(at, r)) return;
        if (num(r.year) > ey) add(at, 'year', 'warn', outside);
        // 2行目以降は開始年より後の年にする（基本生活費は開始年ちょうども使われない）
        else if (anchoredKey && (key === 'living' ? num(r.year) <= sy : num(r.year) < sy)) {
          add(at, 'year', 'warn', '開始年' + (key === 'living' ? '以前' : 'より前') + 'の行は使われません。開始年の金額は1行目に入れます');
        }
      });
    });
    ['corpPension', 'privPension'].forEach(function (key) {
      (state[key] || []).forEach(function (r) { range('row:' + key + ':' + r.id, r); });
    });

    (state.salaries || []).forEach(function (s) {
      (s.rows || []).forEach(function (r, i) {
        var at = 'salrow:' + s.id + ':' + r.id;
        amount(at, r);
        rate(at, 'growth', r.growth);
        if (i === 0 || noYear(at, r)) return;
        if (num(r.year) <= sy) add(at, 'year', 'warn', '開始年以前の行は使われません。開始年の金額は1行目に入れます');
        else if (num(r.year) > ey) add(at, 'year', 'warn', outside);
      });
      var retire = num(s.retireAge);
      var mb = birthYearOf(state, s.memberId);
      if (retire && mb && mb + retire <= sy) {
        add('sal:' + s.id, 'retire', 'warn', '開始年にはもう' + (sy - mb) + '歳なので、給与はずっと0になります');
      }
    });

    rate('infl', 'inflation', state.inflation);
    rate('deprate', 'depositRate', state.depositRate);
    (state.assets || []).forEach(function (a) {
      if (num(a.amount) < 0) add('asset:' + a.id, 'amount', 'warn', 'マイナスの金額になっています');
      if (!a.fixed) rate('rate:' + a.id, 'rate', a.rate);
    });
    Object.keys(state.invest || {}).forEach(function (aid) {
      ['add', 'out'].forEach(function (kind) {
        (state.invest[aid][kind] || []).forEach(function (r) { range('inv:' + aid + ':' + kind + ':' + r.id, r); });
      });
    });

    children(state).forEach(function (c) {
      eduPlan(state, c).forEach(function (st) {
        if (st.to < st.from) add('edu:' + c.id + ':' + st.index, 'to', 'error', '「まで」の年が「から」の年より前です');
      });
    });

    var car = state.carBuy || {};
    if (num(car.fromYear) && num(car.every) < 1) add('car', 'every', 'error', '買い替えの間隔は1年以上で入れてください');
    else if (num(car.fromYear) && num(car.untilAge) && by + num(car.untilAge) < num(car.fromYear)) {
      add('car', 'untilAge', 'warn', '家族１が' + num(car.untilAge) + '歳になるのは' + (by + num(car.untilAge)) + '年なので、一度も購入しません');
    }

    return out;
  }

  // 手取額の簡易計算（手取額計算シートと同じ考え方。会社員・年収150〜1000万円程度向け）
  var DEDUCT_SALARY = [[851, 0, 195], [661, 0.1, 110], [361, 0.2, 44], [191, 0.3, 8]];
  var DEDUCT_BASIC = [[2501, 0], [2451, 16], [2401, 32], [2351, 48], [656, 58], [490, 63], [337, 68], [133, 88], [0, 95]];
  var TAX_INCOME = [[4001, 0.45, -479.6], [1801, 0.4, -279.6], [901, 0.33, -153.6], [696, 0.23, -63.6], [331, 0.2, -42.75], [196, 0.1, -9.75], [0, 0.05, 0]];

  function bracket(table, v) {
    for (var i = 0; i < table.length; i++) if (v >= table[i][0]) return table[i];
    return table[table.length - 1];
  }

  function takeHome(income, hasSpouse, kids) {
    income = num(income);
    if (!(income > 0)) return { net: 0, social: 0, tax: 0, ratio: 0 };
    var sd = bracket(DEDUCT_SALARY, income);
    var gross = income - (income * sd[1] + sd[2]);
    var social = income * 0.155;
    var basic = bracket(DEDUCT_BASIC, gross)[1];
    var spouse = hasSpouse ? 38 : 0;
    var dependents = num(kids) * 38;
    // 課税所得は万円未満を切り捨てる（シートの 270 / 272 と一致させるため）
    var taxable = Math.max(0, Math.floor(gross - social - basic - spouse - dependents - 5));
    var ti = bracket(TAX_INCOME, taxable);
    var incomeTax = Math.max(0, taxable * ti[1] + ti[2]);
    // 住民税は生命保険料控除が2.8万円、税額に＋1万円（シートの注記どおり）
    var residentTax = Math.max(0, Math.floor(gross - social - basic - spouse - dependents - 2.8)) * 0.1 + 1;
    var tax = incomeTax + residentTax;
    var net = income - social - tax;
    return {
      net: Math.round(net), social: Math.round(social), tax: Math.round(tax * 100) / 100,
      ratio: Math.round(net / income * 1000) / 10
    };
  }

  return {
    EDU_UNIT: EDU_UNIT, EDU_STAGES: EDU_STAGES,
    parseDate: parseDate, isDate: isDate, validate: validate, isEarlyBorn: isEarlyBorn, baseBirthYear: baseBirthYear,
    changeAt: changeAt, lumpAt: lumpAt, rangeAt: rangeAt,
    eduPlan: eduPlan, children: children, carOccurrences: carOccurrences, anchored: anchored,
    compute: compute, takeHome: takeHome
  };
}));
