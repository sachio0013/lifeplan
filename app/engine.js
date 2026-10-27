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
  // 上昇率・利回り・物価上昇率は −100％〜1000％に収める（ありえない率で計算があふれて ∞ や NaN にならないように）。
  // 入力の確認では、100％を超える率をエラーとして知らせる。
  function growthRate(v) { return Math.max(-1, Math.min(10, pct(v))); }

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
        v = exact.reduce(function (s, r) { return s + num(r.amount) * Math.pow(1 + growthRate(r.growth), y - sy); }, 0);
      } else {
        var before = rows.filter(function (r) { return num(r.year) < y; });
        if (!before.length) v = 0;
        else {
          var last = before.reduce(function (a, r) { return num(r.year) >= num(a.year) ? r : a; });
          v = prev * (1 + growthRate(last.growth));
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
    var infl = growthRate(state.inflation);
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
    var depositRate = growthRate(state.depositRate || 0);
    var kids = children(state).map(function (c) { return eduPlan(state, c); });
    var cars = carOccurrences(state);

    var prevSalary = (state.salaries || []).map(function () { return 0; });
    var prevLiving = 0;
    // 公的年金：自動（penAuto）なら、プランの給与から見込んだ額を使う
    var pubRows = state.penAuto ? pensionPlan(state).rows : state.pubPension;
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
        changeAt(pubRows, y);

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
        var r = growthRate(a.rate), t = pct(a.tax);
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

  // ---- 公的年金の試算（入力シート T85:AL91） ----

  // 会社員・公務員（2号被保険者）だった期間の手取額から、受け取る年金額（万円・年額）をおおざっぱに出す。
  //   報酬比例 ＝ ROUND（（入社時の手取額＋最終退職時の手取額）÷ 2 × 年数 × 0.55%, 0）
  //   年金額   ＝（報酬比例 ＋ 基礎年金）× 調整（Excelは0.9。所得代替率の低下を見込む）
  // p: { from, to, payFrom, payTo, basic }、adjust は％（90 なら 0.9 倍）
  function pensionEstimate(p, adjust) {
    var from = num(p.from), to = num(p.to);
    var years = from && to && to >= from ? to - from + 1 : 0;
    var raw = (num(p.payFrom) + num(p.payTo)) / 2 * years * 0.0055;
    var earn = Math.round(Math.round(raw * 1e6) / 1e6);
    var basic = num(p.basic);
    var total = Math.round((earn + basic) * pct(adjust) * 10) / 10;
    return { years: years, earn: earn, basic: basic, total: total };
  }

  // 試算の初期値（Excel: 入社は生年＋22年、最終退職は入社＋38年、基礎年金70万円）
  function pensionDefaults(birthYear) {
    return { from: birthYear + 22, to: birthYear + 60, payFrom: '', payTo: '', basic: 70 };
  }

  // ---- 公的年金の見込み（額面基準。プランの給与から計算する） ----
  //
  // 老齢厚生年金（報酬比例）＝ 額面の年収（上限あり）× 5.481/1000 を、厚生年金に入る年ごとに足す（2003年4月以降の式）
  //   これから：開始年から70歳になる年の前まで、プランの給与（手取り）を額面に直して使う。役職定年や再雇用の減額もそのまま入る
  //   これまで：次のどれか
  //     auto  … 働きはじめた年齢（既定22歳）から、今の年収を年齢ごとの賃金カーブでさかのぼって推測
  //     first … 働きはじめた年齢とその年の年収から、今の年収まで直線で推測
  //     teiki … ねんきん定期便の老齢厚生年金の額。50歳未満は「これまでの加入実績」なので、これからの分を足す。
  //             50歳以上は「60歳まで今の条件で入った場合の見込額」なので、60歳までの給与の変化（プランの給与−今の給与）と60歳以降の分を足し引きする
  //   今は給与の無い人は、会社員だった年数とそのころの年収（額面）から
  // 老齢基礎年金 ＝ 満額 83.2万円（2025年度、1956年4月2日以降生まれ）× 納めた年数 ÷ 40
  // 受け取りはじめる年齢で、繰上げ（1か月0.4％減）・繰下げ（1か月0.7％増）
  // 手取り ＝ 額面 − 国民健康保険・介護保険 − 所得税・住民税（おおよそ）、それに将来の目減り（既定90％）を掛ける
  var PEN_RATE = 5.481 / 1000;
  var BASIC_FULL = 83.2;
  // 年齢ごとの賃金の目安（50〜54歳を100。賃金構造基本統計調査の所定内給与・男女計をもとにした概数）
  var WAGE_CURVE = [[22, 59], [27, 68], [32, 76], [37, 84], [42, 91], [47, 95], [52, 100], [57, 99], [62, 79]];
  function wageCurve(age) {
    var c = WAGE_CURVE;
    if (age <= c[0][0]) return c[0][1];
    for (var i = 1; i < c.length; i++) {
      if (age <= c[i][0]) { var a = c[i - 1], b = c[i]; return a[1] + (b[1] - a[1]) * (age - a[0]) / (b[0] - a[0]); }
    }
    return c[c.length - 1][1];
  }
  // 厚生年金の標準報酬の上限を年収に直したもの（月額の上限×12＋賞与1回150万円×2回）。
  // 2025年の年金制度改正で、月額の上限65万円を2027年9月に68万円、2028年9月に71万円、2029年9月に75万円へ引き上げる
  function pensionCap(y) {
    if (y >= 2030) return 75 * 12 + 300;
    if (y === 2029) return 71 * 8 + 75 * 4 + 300;
    if (y === 2028) return 68 * 8 + 71 * 4 + 300;
    if (y === 2027) return 65 * 8 + 68 * 4 + 300;
    if (y >= 2021) return 65 * 12 + 300;
    return 62 * 12 + 300;
  }
  // 手取りから額面を逆算する（手取額計算の式。扶養なし・社会保険料は年収の15.5％）
  function grossFromNet(net) {
    if (!(net > 0)) return 0;
    var lo = net, hi = net * 2 + 300;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (takeHome({ income: mid }).net < net) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  // 公的年金の手取り（65歳以上・単身とみなした、おおよその額）
  function pensionDeduction(g) { return g <= 330 ? 110 : g <= 410 ? g * 0.25 + 27.5 : g <= 770 ? g * 0.15 + 68.5 : g <= 1000 ? g * 0.05 + 145.5 : 195.5; }
  function pensionNet(g) {
    if (!(g > 0)) return { net: 0, social: 0, tax: 0 };
    var income = Math.max(0, g - pensionDeduction(g));
    // 国民健康保険（75歳からは後期高齢者医療）：所得割10％＋均等割4万円、介護保険：4万円＋所得の2％ほど。所得が少なければ軽減
    var social = income > 43 ? (income - 43) * 0.1 + 4 + 4 + income * 0.02 : 3.2;
    var taxable = Math.max(0, income - social - bracket(DEDUCT_BASIC, income)[1]);
    var ti = bracket(TAX_INCOME, taxable);
    var incomeTax = (taxable * ti[1] + ti[2]) * 1.021;
    var rBase = income - social - 43;
    var resident = rBase > 0 ? rBase * 0.1 + 0.5 : 0;
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    return { net: r2(g - social - incomeTax - resident), social: r2(social), tax: r2(incomeTax + resident) };
  }
  // 開始年から、給与ごとの毎年の手取り（compute と同じ計算）
  function salarySeries(state) {
    var sy = num(state.startYear), endYear = baseBirthYear(state) + num(state.endAge);
    var list = state.salaries || [];
    var out = list.map(function () { return {}; }), prev = list.map(function () { return 0; });
    for (var y = sy; y <= endYear && y < sy + 120; y++) {
      list.forEach(function (sal, i) { var v = salaryAt(state, sal, y, prev[i]); prev[i] = v; out[i][y] = v; });
    }
    return out;
  }
  function pensionFactor(startAge) {
    var a = Math.max(60, Math.min(75, startAge));
    return a >= 65 ? 1 + 0.084 * (a - 65) : 1 - 0.048 * (65 - a);
  }

  // state.penPlan = { adjust（％、既定90）, people: { 家族のid: { mode, firstAge, firstIncome, pastYears, pastIncome, teikiEarn, teikiBasic, basicYears, startAge } } }
  function pensionPlan(state) {
    var pp = state.penPlan || {};
    var adjust = pp.adjust === undefined || pp.adjust === '' ? 90 : num(pp.adjust);
    var sy = num(state.startYear);
    var series = salarySeries(state);
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    var people = (state.family || []).filter(function (m) {
      return (m.relation === '家族１' || m.relation === '家族２') && parseDate(m.birth).y;
    }).map(function (m) {
      var s = (pp.people && pp.people[m.id]) || {};
      var by = parseDate(m.birth).y, age0 = sy - by;
      // 額面の年収（その人の給与の合計）。手取りの計算で年収（額面）を入れていれば、その比率で合わせる
      var gross = {};
      (state.salaries || []).forEach(function (sal, i) {
        if (sal.memberId !== m.id) return;
        var net0 = series[i][sy] || 0, k = 1, c = sal.calc;
        var cg = c ? (c.mode === 'slip' ? num(c.gPay) / 10000 : num(c.income)) : 0;
        if (cg > 0 && net0 > 0) { var gg = grossFromNet(net0); if (gg > 0 && cg / gg > 0.7 && cg / gg < 1.5) k = cg / gg; }
        Object.keys(series[i]).forEach(function (y) { var n = series[i][y]; if (n > 0) gross[y] = (gross[y] || 0) + grossFromNet(n) * k; });
      });
      var g0 = gross[sy] || 0;
      // これから
      var future = 0, futureYears = 0, cappedYears = 0, futureBefore60 = 0, before60Now = 0, lastWork = 0;
      for (var y = sy; y < by + 70; y++) {
        var g = gross[y] || 0, cap = pensionCap(y);
        if (y - by < 60) before60Now += Math.min(g0, cap) * PEN_RATE;
        if (!g) continue;
        var a = Math.min(g, cap) * PEN_RATE;
        future += a; futureYears++; lastWork = y - by;
        if (g > cap) cappedYears++;
        if (y - by < 60) futureBefore60 += a;
      }
      // これまで
      var mode = s.mode === 'first' || s.mode === 'teiki' ? s.mode : 'auto';
      var over50 = age0 >= 50;
      var past = 0, pastYears = 0, earn;
      var firstAge = s.firstAge !== undefined && s.firstAge !== '' ? num(s.firstAge) : 22;
      if (mode === 'teiki') {
        past = num(s.teikiEarn);
        // 50歳以上の定期便は60歳まで今の給与が続く前提なので、その分を入れ替える
        earn = over50 ? past - before60Now + future : past + future;
      } else {
        if (g0 > 0) {
          var fi = num(s.firstIncome);
          for (var age = firstAge; age < age0; age++) {
            var gp = mode === 'first' && fi > 0 ? fi + (g0 - fi) * (age - firstAge) / Math.max(1, age0 - firstAge) : g0 * wageCurve(age) / wageCurve(age0);
            past += Math.min(gp, pensionCap(by + age)) * PEN_RATE;
            pastYears++;
          }
        } else {
          pastYears = Math.max(0, num(s.pastYears));
          past = pastYears * Math.min(num(s.pastIncome), pensionCap(sy - 1)) * PEN_RATE;
        }
        earn = past + future;
      }
      earn = Math.max(0, earn);
      var basicYears = s.basicYears !== undefined && s.basicYears !== '' ? Math.max(0, Math.min(40, num(s.basicYears))) : 40;
      var basic = mode === 'teiki' && over50 && num(s.teikiBasic) > 0 ? num(s.teikiBasic) : BASIC_FULL * basicYears / 40;
      var startAge = s.startAge !== undefined && s.startAge !== '' ? Math.max(60, Math.min(75, Math.round(num(s.startAge)))) : 65;
      var factor = pensionFactor(startAge);
      var grossPension = (earn + basic) * factor;
      var pn = pensionNet(grossPension);
      return {
        memberId: m.id, birthYear: by, age: age0, mode: mode, over50: over50, firstAge: firstAge,
        current: r1(g0), past: r1(past), pastYears: pastYears, future: r1(future), futureYears: futureYears, lastWork: lastWork,
        cappedYears: cappedYears, futureBefore60: r1(futureBefore60), before60Now: r1(before60Now),
        earn: r1(earn), basic: r1(basic), basicYears: basicYears, startAge: startAge, startYear: by + startAge, factor: factor,
        gross: r1(grossPension), net: r1(pn.net), social: pn.social, tax: pn.tax, amount: r1(pn.net * adjust / 100)
      };
    });
    // CF表の公的年金の行（変更型）：受け取りはじめる年ごとに、その時点の合計
    var rows = [], sum = 0;
    people.slice().sort(function (a, b) { return a.startYear - b.startYear; }).forEach(function (p) {
      sum = r1(sum + p.amount);
      var last = rows[rows.length - 1];
      if (last && last.year === p.startYear) last.amount = sum;
      else rows.push({ year: p.startYear, amount: sum });
    });
    return { people: people, rows: rows, adjust: adjust };
  }

  // ---- もしもの場合（必要保障額のリスクシナリオ） ----
  //
  // 「◯年に家族１（または家族２）が亡くなったら」のプランを作り、CF表で足りなくなるお金（不足資金）を出す。
  // risk = { memberId（亡くなる人。既定は家族１）, year（亡くなる年。既定は開始年）, livingRate（遺族の生活費の割合％、既定70）,
  //          funeral（葬儀・整理資金、既定200）, lumpIn（死亡退職金・弔慰金）, insurance（加入中の死亡保険金）,
  //          drop（亡くなった後は入らない一時金・企業年金・個人年金の行の id。無ければ riskDropDefaults） }
  // 変えるもの：
  //   亡くなる人の給与は亡くなる年から0（その年の給与も入らないとみなす）
  //   基本生活費は亡くなる年から、今の価値の金額×割合
  //   住宅費の「団信あり」の行は、亡くなる年から返済分（loan、無ければ行の金額）を引く
  //   公的年金は亡くなる年から「遺された配偶者の老齢年金＋遺族年金」（亡くなる前の年までは今のプランのまま）
  //   葬儀・整理資金を支出に、死亡退職金・死亡保険金を一時収入に
  // 遺族年金は、Excel「必要保障額」シート（2028年度改正版）と同じ考え方（survivorYear）。非課税なので手取り＝額面、将来の目減りは公的年金と同じ割合。
  var CHILD_ADD = 28.17;   // 子の加算（2028年4月から、1人あたり年28.17万円）

  // 遺族年金の1年分（万円）。
  //   遺族基礎年金：18歳以下（その年の年末で）の子がいる間、基礎年金の満額＋子の加算（子1人ごと）。65歳からは本人の老齢基礎年金
  //   遺族厚生年金：亡くなった人の報酬比例（加入が25年に満たなければ25年とみなす）の3/4。子がいなくなってからの5年間は、
  //     2028年改正の有期給付（有期給付加算で報酬比例の全額ほど）で、その後は無い
  //   65歳から：本人の老齢厚生年金と、亡くなった人の報酬比例の3/4の多いほう
  // o: { basic（基礎年金の満額）, emp（亡くなった人の報酬比例）, own（遺された人の報酬比例。65歳からの比較用）, age, kids（18歳以下の子の数）, noKidYears（子がいない年の通算） }
  // 返り値は { basic, emp, child, own65 }（own65 は65歳からの老齢厚生年金＋上乗せ分の合計で、本人の年金を含む）
  function survivorYear(o) {
    var noKid = o.kids === 0;
    return {
      basic: noKid && o.age < 65 ? 0 : o.basic,
      emp: o.age >= 65 ? 0 : o.kids > 0 ? o.emp * 0.75 : o.noKidYears > 5 ? 0 : o.emp,
      child: o.kids * CHILD_ADD,
      own65: o.age >= 65 ? Math.max(o.emp * 0.75, o.own) : 0
    };
  }

  function riskDropDefaults(state, risk) {
    var dead = riskPerson(state, risk);
    var re = /退職|DC|企業年金|確定拠出|確定給付/;
    var ids = [];
    ['lump', 'corpPension'].forEach(function (key) {
      (state[key] || []).forEach(function (r) { if (re.test(r.memo || '') || key === 'corpPension') ids.push(r.id); });
    });
    return dead ? ids : [];
  }
  function riskPerson(state, risk) {
    var fam = state.family || [];
    var want = num((risk || {}).memberId);
    return fam.filter(function (m) { return m.id === want && (m.relation === '家族１' || m.relation === '家族２'); })[0] ||
      fam.filter(function (m) { return m.relation === '家族１'; })[0] || null;
  }

  function riskState(state, risk) {
    risk = risk || {};
    var st = JSON.parse(JSON.stringify(state));
    var sy = num(st.startYear), endYear = baseBirthYear(st) + num(st.endAge);
    var dead = riskPerson(st, risk);
    var dy = Math.max(sy, Math.round(num(risk.year)) || sy);
    var info = { year: dy, dead: dead, spouse: null, survivor: [], basicYears: 0, emp: 0, empYears: 0 };
    if (!dead) return { state: st, info: info };
    var spouse = (st.family || []).filter(function (m) { return m !== dead && (m.relation === '家族１' || m.relation === '家族２'); })[0] || null;
    info.spouse = spouse;
    var dby = parseDate(dead.birth).y || baseBirthYear(st);
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    var origPlan = pensionPlan(st);
    var originalPension = st.penAuto ? origPlan.rows : (st.pubPension || []);
    var pdOrig = origPlan.people.filter(function (p) { return p.memberId === dead.id; })[0];

    // 給与：亡くなる年から0
    (st.salaries || []).forEach(function (s) {
      if (s.memberId !== dead.id) return;
      var ra = dy - dby;
      if (!num(s.retireAge) || num(s.retireAge) > ra) s.retireAge = Math.max(1, ra);
    });
    // 遺された配偶者の働き方（spouseNet：亡くなった年からの手取りの年額、spouseUntil：何歳まで）。空欄ならプランのまま
    if (spouse && risk.spouseNet !== undefined && risk.spouseNet !== '' && risk.spouseNet !== null) {
      var sal = (st.salaries || []).filter(function (s) { return s.memberId === spouse.id; })[0];
      if (!sal) {
        sal = { id: 80500, who: spouse.name || spouse.relation, memberId: spouse.id, retireAge: 0, rows: [{ id: 80501, year: sy, amount: 0, growth: 0 }] };
        st.salaries.push(sal);
      }
      sal.rows = sal.rows.filter(function (r, i) { return i === 0 || num(r.year) < dy; });
      if (dy === sy) { sal.rows[0].amount = num(risk.spouseNet); sal.rows[0].growth = 0; }
      else sal.rows.push({ id: 80502, year: dy, amount: num(risk.spouseNet), growth: 0 });
      if (risk.spouseUntil !== undefined && risk.spouseUntil !== '' && num(risk.spouseUntil) > 0) sal.retireAge = num(risk.spouseUntil);
      else if (!num(sal.retireAge)) sal.retireAge = 65;
    }

    // 遺族年金
    var plan = pensionPlan(st);
    var pd = plan.people.filter(function (p) { return p.memberId === dead.id; })[0];
    var ps = spouse ? plan.people.filter(function (p) { return p.memberId === spouse.id; })[0] : null;
    // 亡くなった人の報酬比例：これまでの分は元のプランから（給与を止めると今の年収から推測できなくなるため）、これからの分は亡くなる前の年まで
    var earnDead = 0, empYears = 0;
    if (pd && pdOrig) {
      if (pd.mode === 'teiki') { earnDead = pd.earn; empYears = Math.max(0, pd.age - pd.firstAge) + pd.futureYears; }
      else { earnDead = pdOrig.past + pd.future; empYears = pdOrig.pastYears + pd.futureYears; }
    }
    var E = empYears > 0 ? earnDead * (empYears < 25 ? 25 / empYears : 1) : 0;
    info.emp = r1(E); info.empYears = empYears;
    var kids = children(st).map(function (c) { return parseDate(c.birth).y; }).filter(Boolean);
    var sby = spouse ? parseDate(spouse.birth).y : 0;
    var adjust = plan.adjust / 100;
    var noKidYears = 0;
    var yearly = [];
    for (var y = dy; y <= endYear; y++) {
      var n = kids.filter(function (b) { return y - b >= 0 && y - b <= 18; }).length;
      if (!n) noKidYears++;
      var surv = 0, row = { basic: 0, emp: 0, child: 0, extra: 0 };
      if (spouse) {
        var sAge = y - sby;
        var sv = survivorYear({ basic: BASIC_FULL, emp: E, own: ps ? ps.earn : 0, age: sAge, kids: n, noKidYears: noKidYears });
        row.basic = sAge < 65 ? sv.basic : 0;       // 65歳からの老齢基礎年金は、本人の公的年金に入っている
        row.emp = sv.emp; row.child = sv.child;
        row.extra = sAge >= 65 ? Math.max(0, sv.own65 - (ps ? ps.earn : 0)) : 0;   // 本人の老齢厚生年金より多い分だけ上乗せ
        surv = row.basic + row.emp + row.child + row.extra;
      } else if (n > 0) {
        // 配偶者がいなければ子が受ける（子の加算は2人目から）
        row.basic = BASIC_FULL; row.emp = E * 0.75; row.child = (n - 1) * CHILD_ADD;
        surv = row.basic + row.emp + row.child;
      }
      surv *= adjust;
      var ownPension = ps && y >= ps.startYear ? ps.amount : 0;
      info.survivor.push({ year: y, basic: r1(row.basic * adjust), emp: r1(row.emp * adjust), child: r1(row.child * adjust), extra: r1(row.extra * adjust), own: ownPension, total: r1(surv + ownPension) });
      yearly.push(r1(surv + ownPension));
    }
    // 公的年金の行（変更型）：亡くなる前の年までは今のまま、亡くなる年から毎年の額（変わる年だけ行にする）
    var rows = originalPension.filter(function (r) { return num(r.year) && num(r.year) < dy; }).map(function (r) { return { year: num(r.year), amount: num(r.amount) }; });
    yearly.forEach(function (v, i) { if (i === 0 || v !== yearly[i - 1]) rows.push({ year: dy + i, amount: v }); });
    st.penAuto = false;
    st.pubPension = rows.map(function (r, i) { return { id: 80000 + i, year: r.year, amount: r.amount, memo: '' }; });

    // 基本生活費：亡くなる年から末子が独立するまでは今の価値の金額×割合1（既定80％）、独立してからは×割合2（既定60％）。
    // 末子の独立は、いちばん下の子の生年＋独立の年齢（既定22歳）。子がいなければ亡くなる年から割合2
    var pctOr = function (v, d) { return (v === undefined || v === '' || v === null ? d : num(v)) / 100; };
    var rate1 = pctOr(risk.livingRate, 80), rate2 = pctOr(risk.livingRate2, 60);
    var indep = kids.length ? Math.max.apply(null, kids) + (risk.indepAge === undefined || risk.indepAge === '' ? 22 : num(risk.indepAge)) : dy;
    info.indepYear = indep;
    var mult = function (y) { return y < indep ? rate1 : rate2; };
    var L = st.living || [];
    if (L.length) {
      var ly = function (r, i) { return i === 0 ? sy : num(r.year); };
      // その年に使われている今の価値の金額（1行目は開始年から、同じ年の行は合算）
      var valueAt = function (Y) {
        var best = -Infinity, sum = 0;
        L.forEach(function (r, i) { var ry = ly(r, i); if (ry > Y) return; if (ry > best) { best = ry; sum = num(r.amount); } else if (ry === best) sum += num(r.amount); });
        return sum;
      };
      var add = [];
      [dy, indep].forEach(function (Y) {
        if (Y < dy || Y < sy || Y === sy) return;
        if (!L.some(function (r, i) { return i > 0 && num(r.year) === Y; }) && !add.some(function (a) { return a.year === Y; })) add.push({ year: Y, amount: valueAt(Y) });
      });
      L.forEach(function (r, i) { var ry = ly(r, i); if (ry >= dy) r.amount = num(r.amount) * mult(ry); });
      add.forEach(function (a, k) { L.push({ id: 80100 + k, year: a.year, amount: a.amount * mult(a.year), memo: '' }); });
    }

    // 住宅費：団信ありの行は、亡くなる年から返済分を引く
    var H = st.housing || [];
    var hy = function (r, i) { return i === 0 ? sy : num(r.year); };
    var loanPart = function (r) { return r.dansin ? (r.loan === undefined || r.loan === '' ? num(r.amount) : Math.min(num(r.amount), num(r.loan))) : 0; };
    if (H.some(function (r) { return r.dansin; })) {
      var best = -Infinity;
      H.forEach(function (r, i) { var ey = hy(r, i); if (ey <= dy && ey > best) best = ey; });
      var activeRows = H.filter(function (r, i) { return hy(r, i) === best; });
      var needRow = best < dy && activeRows.some(function (r) { return r.dansin; });
      var activeSum = activeRows.reduce(function (s, r) { return s + num(r.amount) - loanPart(r); }, 0);
      H.forEach(function (r, i) { if (hy(r, i) >= dy && r.dansin) { r.amount = num(r.amount) - loanPart(r); r.dansin = false; } });
      if (needRow) H.push({ id: 80200, year: dy, amount: Math.max(0, activeSum), memo: '団信で返済終了' });
    }

    // 一時金・企業年金：亡くなった後は入らないもの
    var drop = risk.drop || riskDropDefaults(state, risk);
    st.lump = (st.lump || []).filter(function (r) { return !(drop.indexOf(r.id) >= 0 && num(r.year) >= dy); });
    ['corpPension', 'privPension'].forEach(function (key) {
      st[key] = (st[key] || []).filter(function (r) { return !(drop.indexOf(r.id) >= 0 && num(r.year) >= dy); }).map(function (r) {
        if (drop.indexOf(r.id) >= 0 && num(r.toYear) >= dy) r.toYear = dy - 1;
        return r;
      });
    });
    // 亡くなる年の出入り
    if (num(risk.lumpIn) > 0) st.lump.push({ id: 80300, year: dy, amount: num(risk.lumpIn), memo: '死亡退職金・弔慰金' });
    if (num(risk.insurance) > 0) st.lump.push({ id: 80301, year: dy, amount: num(risk.insurance), memo: '死亡保険金' });
    var funeral = risk.funeral === undefined || risk.funeral === '' ? 200 : num(risk.funeral);
    if (funeral > 0) { st.otherLump = st.otherLump || []; st.otherLump.push({ id: 80302, year: dy, amount: funeral, memo: '葬儀・整理資金' }); }
    return { state: st, info: info };
  }

  // 不足資金：亡くなる年に一度にいくら入れれば、最後まで金融資産（預金＋投資）がマイナスにならないか（万円、1万円単位で切り上げ）。
  // 投資は取り崩せるとみなす（預金が足りない年は積立も止まる）
  // 遺される家族：配偶者がいなければ、独立前（22歳以下）の子が遺される家族。どちらもいなければ alone（必要なのは葬儀・整理資金だけ）。
  // 配偶者がいなければ、末子が独立する年の前までで判定する（その後のお金は遺される家族のものではないため）
  function riskShortfall(state, risk) {
    risk = risk || {};
    var rs = riskState(state, risk);
    var dy = rs.info.year;
    var kids = children(state).map(function (c) { return parseDate(c.birth).y; }).filter(function (b) { return b && dy - b <= 22; });
    var alone = !!rs.info.dead && !rs.info.spouse && !kids.length;
    rs.info.alone = alone;
    var until = rs.info.spouse || !kids.length ? Infinity : rs.info.indepYear - 1;
    rs.info.until = until;
    if (alone) {
      // 亡くなる前の年の末の金融資産（開始年なら前年末の残高）で、葬儀・整理資金をまかなえるか
      var base = compute(state);
      var before = base.years.filter(function (r) { return r.year === dy - 1; })[0];
      var assets = before ? before.assets.total : (state.assets || []).reduce(function (t, a) { return t + num(a.amount); }, 0);
      var funeral = risk.funeral === undefined || risk.funeral === '' ? 200 : num(risk.funeral);
      var lack = funeral - assets - num(risk.lumpIn) - num(risk.insurance);
      return { need: lack > 0 ? Math.ceil(lack) : 0, minDeposit: assets, cf: base, state: state, info: rs.info, assets: assets };
    }
    var minDep = function (st) {
      var r = compute(st), m = Infinity;
      r.years.forEach(function (row) { if (row.year >= dy && row.year <= until && row.assets.total < m) m = row.assets.total; });
      return { min: m, cf: r };
    };
    var first = minDep(rs.state);
    var need = 0;
    if (first.min < 0) {
      var withX = function (x) {
        var st = JSON.parse(JSON.stringify(rs.state));
        st.lump.push({ id: 80400, year: dy, amount: x, memo: '' });
        return minDep(st).min;
      };
      // 見当（いちばん深い落ち込み）を上限にして、二分探索で最小の額を探す。
      // 早めに入れると、マイナスの預金に付く利息の分だけ少なくて済むので、見当より少ないことがある
      var lo = 0, hi = Math.max(1, Math.ceil(-first.min));
      for (var k = 0; k < 20 && withX(hi) < -0.01; k++) hi *= 2;
      while (hi - lo > 0.5) { var mid = (lo + hi) / 2; if (withX(mid) < -0.01) lo = mid; else hi = mid; }
      need = Math.ceil(hi - 1e-6);
    }
    return { need: need, minDeposit: first.min, cf: first.cf, state: rs.state, info: rs.info };
  }

  // ---- 必要保障額の簡易計算（Excel「必要保障額」シート、2028年度改正版） ----
  //
  // 必要保障額 ＝ 支出の合計 − 収入の合計（マイナスなら0）。金額は万円、年齢は今の年齢。
  // o: { deposit, invest, otherAssets（今の金融資産）, avgIncome, years（亡くなる人のこれまでの平均年収と勤続年数）,
  //      age（遺される配偶者の年齢）, kids（子の年齢）, condolence, retirement, otherCompany（弔慰金・死亡退職金・その他）,
  //      spouseNet, spouseYears（配偶者の手取り×年数）, spouseAvg, spouseLifeYears（配偶者の生涯の平均年収と勤続年数）, otherIncome,
  //      living, rate1, indepAge, rate2（生活費、末子独立までの割合、独立年齢、その後の割合）,
  //      loanYears, loanAnnual, dansin（団信で相殺される％）, upkeep, rent, edu, insurance, insuranceUntil, carCost, carUntil, carTimes, carPrice, others,
  //      until（何歳までの生活を見るか、既定90）, basic（基礎年金、既定80）, childAdd（子の加算、既定28）, year（上限を決める年。プランの開始年） }
  function needSimple(o) {
    var d = function (k, v) { return o[k] === undefined || o[k] === '' || o[k] === null ? v : num(o[k]); };
    var until = d('until', 90), age = num(o.age);
    var kids = (o.kids || []).filter(function (k) { return k !== '' && k !== null && k !== undefined && isFinite(parseFloat(k)); }).map(num);
    var basicFull = d('basic', 80), childAdd = d('childAdd', 28);
    // 遺族年金等（シート M10:CE25）
    // 平均年収は、公的年金の見込みと同じ標準報酬の上限まで（その年の上限。今は1,080万円、2030年からは1,200万円）。シートは1,000万円
    var cap = pensionCap(d('year', new Date().getFullYear()));
    var emp = Math.min(cap, num(o.avgIncome)) * PEN_RATE * Math.max(25, num(o.years));
    var own = Math.min(cap, num(o.spouseAvg)) * PEN_RATE * num(o.spouseLifeYears) * 0.75;
    var table = [], noKidYears = 0;
    for (var a = age; a <= until && table.length < 120; a++) {
      var n = kids.filter(function (k) { return k + (a - age) <= 18; }).length;
      if (!n) noKidYears++;
      var sv = survivorYear({ basic: basicFull, emp: emp, own: own, age: a, kids: n, noKidYears: noKidYears });
      // シートは子の加算を独自の額（childAdd）で計算し、遺族厚生年金は有期のあいだ65歳以降も続く。
      // 子がいる間の遺族厚生年金は3/4（シートは全額。アプリでは法律どおり3/4にした）
      var e = n > 0 ? emp * 0.75 : noKidYears > 5 ? 0 : emp;
      table.push({ age: a, kids: n, basic: sv.basic, emp: e, own65: sv.own65, child: n * childAdd, total: sv.basic + e + sv.own65 + n * childAdd });
    }
    var survivor = table.reduce(function (s, r) { return s + r.total; }, 0);
    var assets = num(o.deposit) + num(o.invest) + num(o.otherAssets);
    var company = num(o.condolence) + num(o.retirement) + num(o.otherCompany);
    var spouseIncome = num(o.spouseNet) * num(o.spouseYears);
    var income = assets + survivor + company + spouseIncome + num(o.otherIncome);
    // 支出
    var youngest = kids.length ? Math.min.apply(null, kids) : null;
    var y1 = youngest === null ? 0 : Math.max(0, d('indepAge', 22) - youngest);
    var living = y1 * num(o.living) * d('rate1', 80) / 100 + (until - age - y1) * num(o.living) * d('rate2', 60) / 100;
    var housing = num(o.rent) === 0
      ? num(o.loanYears) * num(o.loanAnnual) * (1 - d('dansin', 100) / 100) + (until - age) * num(o.upkeep)
      : num(o.rent) * (until - age);
    var insurance = Math.max(0, (d('insuranceUntil', 60) - age) * num(o.insurance));
    var car = Math.max(0, (d('carUntil', 75) - age) * num(o.carCost)) + num(o.carTimes) * num(o.carPrice);
    var others = (o.others || []).reduce(function (s, v) { return s + num(v); }, 0);
    var expense = living + housing + num(o.edu) + insurance + car + others;
    return {
      income: { assets: assets, survivor: survivor, company: company, spouse: spouseIncome, other: num(o.otherIncome), total: income },
      expense: { living: living, housing: housing, edu: num(o.edu), insurance: insurance, car: car, other: others, total: expense },
      need: expense - income < 0 ? 0 : Math.round(expense - income),
      survivorTable: table, emp: emp, own: own
    };
  }

  // 簡易計算の初期値を、プランから作る（亡くなる人と配偶者は riskPerson と同じ）
  function needFromPlan(state, risk) {
    var sy = num(state.startYear);
    var dead = riskPerson(state, risk || {});
    var fam = state.family || [];
    var spouse = dead ? fam.filter(function (m) { return m !== dead && (m.relation === '家族１' || m.relation === '家族２'); })[0] : null;
    var plan = pensionPlan(state);
    var pd = dead ? plan.people.filter(function (p) { return p.memberId === dead.id; })[0] : null;
    var ps = spouse ? plan.people.filter(function (p) { return p.memberId === spouse.id; })[0] : null;
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    var assets = state.assets || [];
    var cash = assets.filter(function (a) { return a.fixed; }).reduce(function (s, a) { return s + num(a.amount); }, 0);
    var inv = assets.filter(function (a) { return !a.fixed; }).reduce(function (s, a) { return s + num(a.amount); }, 0);
    var age = spouse && parseDate(spouse.birth).y ? sy - parseDate(spouse.birth).y : '';
    var kids = children(state).map(function (c) { var b = parseDate(c.birth).y; return b ? sy - b : null; })
      .filter(function (k) { return k !== null && k >= 0 && k <= 22; });
    var spSal = spouse ? (state.salaries || []).filter(function (s) { return s.memberId === spouse.id; })[0] : null;
    var spNet = spSal && spSal.rows[0] ? num(spSal.rows[0].amount) : 0;
    var spYears = spNet > 0 && age !== '' ? Math.max(0, (num(spSal.retireAge) || 65) - age) : 0;
    var r = compute(state);
    var edu = r.years.reduce(function (s, y) { return s + y.expense.education; }, 0);
    // 住居費：団信ありの行（住宅ローン）があれば、その返済と維持費。無ければ開始年の住宅費を家賃（または維持費）として
    var H = state.housing || [];
    var h0 = H.filter(function (x) { return x.dansin; })[0] || H[0] || { amount: 0 };
    var loanYears = 0, loanAnnual = 0, upkeep = 0, rent = 0;
    if (h0.dansin) {
      loanAnnual = h0.loan === undefined || h0.loan === '' ? num(h0.amount) : num(h0.loan);
      upkeep = Math.max(0, num(h0.amount) - loanAnnual);
      var next = H.slice(1).map(function (x) { return num(x.year); }).filter(function (y) { return y > sy; }).sort(function (a, b) { return a - b; });
      var lc = state.loanCalc;
      var end = lc && num(lc.start) && num(lc.years) ? num(lc.start) + num(lc.years) : next.length ? next[next.length - 1] : sy + 30;
      loanYears = Math.max(0, end - sy);
    } else rent = num(h0.amount);
    var carBuy = state.carBuy || {};
    var cars = carOccurrences(state).filter(function (c) { return c.year >= sy; });
    var avg = function (p) {
      if (!p) return { avg: 0, years: 0 };
      var yrs = p.pastYears + p.futureYears;
      return { avg: yrs ? r1((p.past + p.future) / PEN_RATE / yrs) : 0, years: yrs };
    };
    var pastOnly = pd ? { avg: pd.pastYears ? r1(pd.past / PEN_RATE / pd.pastYears) : pd.current, years: pd.pastYears } : { avg: 0, years: 0 };
    var life = avg(ps);
    return {
      year: sy, deposit: cash, invest: inv, otherAssets: 0,
      avgIncome: pastOnly.avg, years: pastOnly.years,
      age: age, kids: kids,
      condolence: 0, retirement: 0, otherCompany: 0,
      spouseNet: spNet, spouseYears: spYears, spouseAvg: life.avg, spouseLifeYears: life.years, otherIncome: 0,
      living: (state.living && state.living[0]) ? num(state.living[0].amount) : 0, rate1: 80, indepAge: 22, rate2: 60,
      loanYears: loanYears, loanAnnual: loanAnnual, dansin: 100, upkeep: upkeep, rent: rent,
      edu: r1(edu), insurance: (state.insurance && state.insurance[0]) ? num(state.insurance[0].amount) : 0, insuranceUntil: 60,
      carCost: (state.carCost && state.carCost[0]) ? num(state.carCost[0].amount) : 0, carUntil: num(carBuy.untilAge) || 75,
      carTimes: cars.length, carPrice: num(carBuy.amount), others: [], until: 90
    };
  }

  // ---- 投資の取り崩しの提案 ----
  //
  // 老後に普通預金等を「目標の額くらい」に保つように、投資資産の現金化（取り崩し）の額を提案する。
  // o: { target（保ちたい普通預金等、万円）, startAge（家族１が何歳から取り崩すか）, step（額を見直す間隔、既定10年） }
  //   取り崩しを始める年から、step 年ごとの期間に分け、期間ごとに「年◯万円」を一定にする。
  //   期間の額は、その期間の最後の年の普通預金等が目標になるように、二分探索で決める。
  //   どの投資から取り崩すかは、税金のかかる口座 → iDeCo → NISAなど税金のかからない口座の順（NISAを長く残す）。
  //   1つの投資から取り崩せるのは、期間の最後まで残高が足りる額まで（足りない年は0になる計算のため）。
  // 返り値 { start, end, segments: [{ from, to, total, parts: [{ id, name, amount }] }], rows: { 投資のid: 現金化の行 }, before, after（compute の結果）, keptUntil, short }
  function drawdownPlan(state, o) {
    o = o || {};
    var st = JSON.parse(JSON.stringify(state));
    // 年金は給与で決まり、取り崩しでは変わらないので、自動の見込みは先に行にしておく（何度も計算するため）
    if (st.penAuto) { st.pubPension = pensionPlan(st).rows.map(function (r, i) { return { id: 70000 + i, year: r.year, amount: r.amount }; }); st.penAuto = false; }
    var sy = num(st.startYear), by = baseBirthYear(st), endYear = by + num(st.endAge);
    var start = Math.max(sy, by + Math.round(num(o.startAge) || 65));
    var target = num(o.target), step = Math.max(1, Math.round(num(o.step) || 10));
    var invAssets = (st.assets || []).filter(function (a) { return !a.fixed; });
    var rank = function (a) { return pct(a.tax) > 0 ? 0 : /idec/i.test(a.name || '') ? 1 : 2; };
    var order = invAssets.slice().sort(function (a, b) { return rank(a) - rank(b); });
    // 取り崩しを始める年より後の現金化の行は、提案で置き換える（前の行は残し、またがる行は前の年までにする）
    st.invest = st.invest || {};
    var kept = {};
    invAssets.forEach(function (a) {
      var iv = st.invest[a.id] || (st.invest[a.id] = { add: [], out: [] });
      kept[a.id] = (iv.out || []).filter(function (r) { return num(r.year) < start; }).map(function (r) {
        var c = JSON.parse(JSON.stringify(r)); if (num(c.toYear) >= start) c.toYear = start - 1; return c;
      });
      iv.out = kept[a.id].slice();
    });
    var before = compute(state);
    var depAt = function (res, y) { var row = res.years.filter(function (r) { return r.year === y; })[0]; return row ? row.assets.deposit : 0; };
    var segments = [];
    var nextId = 71000;
    // 1つの投資から、期間 [s, e] に毎年 a を取り崩せるか（残高が足りるか）
    var fits = function (res, a, s, e, amount) {
      var i = invAssets.indexOf(a);
      var prev = res.years.filter(function (r) { return r.year === s - 1; })[0];
      var bal = prev ? prev.assets.investments[i] : num(a.amount);
      var rr = growthRate(a.rate), t = pct(a.tax);
      var add = (st.invest[a.id].add || []);
      for (var y = s; y <= e; y++) {
        if (amount > bal + 1e-9) return false;
        bal = (bal - amount) * (1 + rr * (1 - t)) + rangeAt(add, y);
      }
      return true;
    };
    var capOf = function (res, a, s, e) {
      if (!fits(res, a, s, e, 0.5)) return 0;
      var lo = 0.5, hi = 1;
      while (fits(res, a, s, e, hi) && hi < 1e6) { lo = hi; hi *= 2; }
      for (var k = 0; k < 30; k++) { var m = (lo + hi) / 2; if (fits(res, a, s, e, m)) lo = m; else hi = m; }
      return Math.floor(lo * 10) / 10;
    };
    for (var s = start; s <= endYear; s += step) {
      var e = Math.min(s + step - 1, endYear);
      var cur = compute(st);
      var caps = order.map(function (a) { return capOf(cur, a, s, e); });
      var total = caps.reduce(function (t, c) { return t + c; }, 0);
      var alloc = function (W) {
        var rem = W;
        return order.map(function (a, k) { var v = Math.min(rem, caps[k]); rem -= v; return v; });
      };
      var withW = function (W) {
        var parts = alloc(W);
        order.forEach(function (a, k) { st.invest[a.id].out = st.invest[a.id].out.filter(function (r) { return r.id !== nextId + k; }); if (parts[k] > 0) st.invest[a.id].out.push({ id: nextId + k, year: s, toYear: e, amount: parts[k], memo: '取り崩しの提案' }); });
        return depAt(compute(st), e);
      };
      var W = 0;
      if (withW(0) < target && total > 0) {
        if (withW(total) <= target) W = total;
        else {
          var lo = 0, hi = total;
          for (var it = 0; it < 30 && hi - lo > 0.05; it++) { var mid = (lo + hi) / 2; if (withW(mid) < target) lo = mid; else hi = mid; }
          W = Math.min(total, Math.ceil(hi));
        }
      }
      var parts = alloc(W).map(function (v) { return Math.round(v * 10) / 10; });
      withW(0);   // 試しの行を消す
      order.forEach(function (a, k) {
        st.invest[a.id].out = st.invest[a.id].out.filter(function (r) { return r.id !== nextId + k; });
        if (parts[k] > 0) st.invest[a.id].out.push({ id: nextId + k, year: s, toYear: e, amount: parts[k], memo: '取り崩しの提案' });
      });
      segments.push({ from: s, to: e, total: Math.round(parts.reduce(function (t, v) { return t + v; }, 0) * 10) / 10,
        parts: order.map(function (a, k) { return { id: a.id, name: a.name, amount: parts[k] }; }).filter(function (p) { return p.amount > 0; }) });
      nextId += 10;
    }
    var after = compute(st);
    // 目標を保てる年：取り崩しを始めてから、普通預金等が目標の8割を下回る前の年まで
    var keptUntil = null, short = false;
    for (var y = start + 1; y <= endYear; y++) {
      if (depAt(after, y) < target * 0.8) { short = true; break; }
      keptUntil = y;
    }
    var rows = {};
    invAssets.forEach(function (a) { rows[a.id] = st.invest[a.id].out; });
    return { start: start, end: endYear, startAge: start - by, target: target, segments: segments, rows: rows, before: before, after: after, keptUntil: keptUntil, short: short, birthYear: by };
  }

  // ---- 住宅ローンの試算（入力シート T114:AH125、住宅ローン返済表シート） ----

  // 元利均等返済。金利は3段階まで変えられ、2段階目以降は「前の段階が終わった時点の残高」を
  // 残りの期間・新しい金利で返す（Excel: 返済表シートの B432・B860 が前の表の残高を引く）。
  // 最後の段階の年数は、返済期間の残り全部とする。
  // loan: { amount（万円）, years, phases: [{ rate（％）, years }] }
  function loanSchedule(loan) {
    var total = Math.max(0, Math.round(num(loan.years)));
    var balance = num(loan.amount) * 10000;   // 返済表シートと同じく円で計算する
    var phases = [], yearly = [], month = 0, used = 0, paid = 0;
    (loan.phases || []).forEach(function (ph, k, list) {
      var last = k === list.length - 1;
      var yrs = last ? total - used : Math.min(Math.max(0, Math.round(num(ph.years))), total - used);
      if (yrs <= 0) return;
      var n = (total - used) * 12;             // 残りの回数（この段階の金利で、完済までの返済額を出す）
      var i = pct(ph.rate) / 12;
      var pay = i ? balance * i / (1 - Math.pow(1 + i, -n)) : balance / n;
      phases.push({ rate: num(ph.rate), from: used, years: yrs, monthly: pay / 10000, annual: pay * 12 / 10000 });
      for (var m = 0; m < yrs * 12; m++, month++) {
        var interest = balance * i, principal = pay - interest;
        balance -= principal;
        var y = Math.floor(month / 12);
        var row = yearly[y] || (yearly[y] = { index: y, pay: 0, principal: 0, interest: 0, balance: 0 });
        row.pay += pay / 10000; row.principal += principal / 10000; row.interest += interest / 10000;
        row.balance = Math.max(0, balance) / 10000;
        paid += pay / 10000;
      }
      used += yrs;
    });
    return { phases: phases, yearly: yearly, total: paid, interest: paid - num(loan.amount), years: used };
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
      if (i === 0 && m.relation !== '家族１') add(at, 'relation', 'error', '1人目は家計の中心になる人（家族１）にしてください');
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
      if (Math.abs(num(v)) > 100) add(at, field, 'error', num(v) + '％は計算に使えない大きさです。1.5％なら「1.5」と入れます');
      else if (Math.abs(num(v)) > 10) add(at, field, 'warn', num(v) + '％はとても大きな率です。1.5％なら「1.5」と入れます');
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
    (state.penAuto ? [] : ['pubPension']).concat(['insurance', 'carCost', 'otherFlow', 'living', 'housing']).forEach(function (key) {
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

  // ---- 手取額の簡易計算（手取額計算シート「年収から手取り額を簡易計算（会社員向け）2025.4～」と同じ式） ----
  //
  // 会社員で年収150〜1000万円くらい（社会保険加入）向けのざっくりした計算。金額は万円。
  //   社会保険料 ＝ 年収×15.5％（上限180万円）
  //   所得金額   ＝ 年収 − 給与所得控除
  //   課税所得   ＝ 所得金額 − （社会保険料＋基礎控除＋配偶者控除＋扶養控除＋生命保険料控除＋iDeCo＋その他）
  //   所得税     ＝ 課税所得×税率 − 速算控除
  //   住民税     ＝ 課税所得×10％ ＋ 1（所得税との控除額の違いの分）＋ 0.2 − 前年のふるさと納税額
  //   手取り     ＝ 年収 − 社会保険料 − 所得税 − 住民税
  var DEDUCT_SALARY = [[851, 0, 195], [661, 0.1, 110], [361, 0.2, 44], [191, 0.3, 8]];
  var DEDUCT_BASIC = [[2501, 0], [2451, 16], [2401, 32], [2351, 48], [656, 58], [490, 63], [337, 68], [133, 88], [0, 95]];
  var TAX_INCOME = [[4001, 0.45, -479.6], [1801, 0.4, -279.6], [901, 0.33, -153.6], [696, 0.23, -63.6], [331, 0.2, -42.75], [196, 0.1, -9.75], [0, 0.05, 0]];
  // 配偶者控除・配偶者特別控除（シート K14:O24）。行は配偶者の所得、列は本人の所得（900万円以下／901〜950／951〜1000／1001〜）
  var DEDUCT_SPOUSE = [[134, 0, 0, 0, 0], [131, 3, 2, 1, 0], [126, 6, 4, 2, 0], [121, 11, 8, 4, 0], [116, 16, 11, 6, 0], [111, 21, 14, 7, 0],
    [106, 26, 18, 9, 0], [101, 31, 21, 11, 0], [96, 36, 24, 12, 0], [59, 38, 26, 13, 0], [0, 38, 26, 13, 0]];
  // 扶養控除（シート C22）：16歳以上の子供等 38、19〜23歳 63、70歳以上で別居 48、同居 58
  var DEDUCT_DEP = { g16: 38, g19: 63, elderAway: 48, elderLive: 58 };

  function bracket(table, v) {
    for (var i = 0; i < table.length; i++) if (v >= table[i][0]) return table[i];
    return table[table.length - 1];
  }
  function salaryDeduction(income) {
    if (income <= 190) return 65;
    var sd = bracket(DEDUCT_SALARY, income);
    return income * sd[1] + sd[2];
  }

  // 社会保険料の本人負担の率（％、目安）。健康保険の種類と年齢（40〜64歳は介護保険料あり）で変える。
  //   協会けんぽ：健康保険 5.0（全国平均10.0％の半分）、介護 0.8、厚生年金 9.15、雇用保険 0.55
  //   健康保険組合：健康保険 4.2、介護 0.8（組合の平均的な料率と会社負担の多さから。組合ごとに違う）
  // 厚生年金は標準報酬月額65万円・賞与1回150万円が上限なので、年収1,080万円（65万×12＋150万×2）を上限とみなす（今年の手取りなので今の上限）。
  var HEALTH = { kyokai: { health: 5.0, care: 0.8 }, kumiai: { health: 4.2, care: 0.8 } };
  function socialInsurance(income, health, age) {
    var h = HEALTH[health];
    if (!h) return Math.min(income * 0.155, 180);    // Excelの手取額計算シートと同じ（年収×15.5％、上限180）
    var care = age >= 40 && age < 65 ? h.care : 0;
    // 健康保険・介護保険は標準報酬月額139万円・標準賞与額 年573万円が上限（年収2,241万円とみなす）。雇用保険は上限なし
    return Math.min(income, 2241) * (h.health + care) / 100 + income * 0.55 / 100 + Math.min(income, 1080) * 0.0915;
  }

  // o: { income, spouse（扶養配偶者 'あり'/'なし'）, spouseIncome（配偶者の年収）, g16, g19, elderAway, elderLive（人数）,
  //      life（生命保険料控除、既定5）, ideco, other, furusato,
  //      health（'kyokai'/'kumiai'、無ければExcelと同じ15.5％）, age（本人の年齢）, social（社会保険料の実額。あればこれを使う）,
  //      lastIncome（去年の年収。住民税は去年の所得で決まるので、あれば住民税だけこれで計算する） }
  // 以前の呼び方 takeHome(年収, 扶養配偶者あり, 子供の数) も受け付ける（子供は16歳以上として数える）
  function takeHome(o, hasSpouse, kids) {
    if (typeof o !== 'object' || o === null) o = { income: o, spouse: hasSpouse ? 'あり' : 'なし', g16: kids };
    var income = num(o.income);
    if (!(income > 0)) return { net: 0, social: 0, tax: 0, incomeTax: 0, residentTax: 0, ratio: 0, taxable: 0, deductions: {} };
    var own = income - salaryDeduction(income);
    var actual = o.social !== undefined && o.social !== '' && o.social !== null && num(o.social) > 0;
    var social = actual ? num(o.social) : socialInsurance(income, o.health, num(o.age));
    var basic = bracket(DEDUCT_BASIC, own)[1];
    var spouseOn = o.spouse === true || o.spouse === 'あり';
    var sIncome = num(o.spouseIncome);
    var spouseOwn = sIncome > 0 ? Math.max(0, sIncome - salaryDeduction(sIncome)) : 0;
    var col = own >= 1001 ? 4 : own >= 951 ? 3 : own >= 901 ? 2 : 1;
    var spouse = spouseOn ? bracket(DEDUCT_SPOUSE, spouseOwn)[col] : 0;
    var dep = num(o.g16) * DEDUCT_DEP.g16 + num(o.g19) * DEDUCT_DEP.g19 + num(o.elderAway) * DEDUCT_DEP.elderAway + num(o.elderLive) * DEDUCT_DEP.elderLive;
    var life = o.life == null || o.life === '' ? 5 : num(o.life);
    var taxable = Math.max(0, own - (social + basic + spouse + dep + life + num(o.ideco) + num(o.other)));
    var ti = bracket(TAX_INCOME, taxable);
    var incomeTax = taxable * ti[1] + ti[2];
    var residentTax = Math.max(0, taxable * 0.1) + 1 - num(o.furusato) + 0.2;
    // 住民税は去年の所得で決まる。去年の年収があれば、扶養などは今年と同じとして住民税だけ去年の年収で計算する
    var last = num(o.lastIncome);
    if (last > 0 && last !== income) {
      var lastOwn = last - salaryDeduction(last);
      var lastSocial = actual ? social * last / income : socialInsurance(last, o.health, num(o.age) - 1);
      var lastCol = lastOwn >= 1001 ? 4 : lastOwn >= 951 ? 3 : lastOwn >= 901 ? 2 : 1;
      var lastTaxable = Math.max(0, lastOwn - (lastSocial + bracket(DEDUCT_BASIC, lastOwn)[1] + (spouseOn ? bracket(DEDUCT_SPOUSE, spouseOwn)[lastCol] : 0) +
        dep + life + num(o.ideco) + num(o.other)));
      residentTax = lastTaxable * 0.1 + 1 - num(o.furusato) + 0.2;
    }
    var tax = incomeTax + residentTax;
    var net = income - social - tax;
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    return {
      net: r2(net), social: r2(social), tax: r2(tax), incomeTax: r2(incomeTax), residentTax: r2(residentTax),
      taxable: r2(taxable), ratio: Math.round(net / income * 1000) / 10,
      socialRate: Math.round(social / income * 1000) / 10, socialActual: actual, residentFromLast: last > 0 && last !== income,
      deductions: { salary: r2(income - own), basic: basic, spouse: spouse, dependents: dep, life: life }
    };
  }

  // 源泉徴収票の欄から手取りを出す（金額は円で受け取り、万円で返す）。所得税・社会保険料は実額なので、
  // 年の途中の昇給、健康保険組合の料率、住宅ローン控除、復興特別所得税なども入っている。
  // o: { pay（支払金額）, after（給与所得控除後の金額。無ければ計算）, deductions（所得控除の額の合計額）, tax（源泉徴収税額）,
  //      social（社会保険料等の金額）, small（そのうち小規模企業共済等掛金＝iDeCo・企業型DCの本人掛金）,
  //      resident（住民税の年額。無ければ課税所得×10％＋1＋0.2で見積もる＝Excelの手取額計算シートと同じ） }
  // iDeCoなどの掛金は貯蓄なので、手取りに含める（社会保険料からは除く）。
  function takeHomeFromSlip(o) {
    var m = function (v) { return num(v) / 10000; };
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    var pay = m(o.pay);
    if (!(pay > 0)) return { net: 0, social: 0, tax: 0, incomeTax: 0, residentTax: 0, ratio: 0, small: 0, residentEstimated: false };
    var socialAll = m(o.social);
    var small = Math.min(Math.max(0, m(o.small)), socialAll);
    var social = socialAll - small;
    var incomeTax = m(o.tax);
    var estimated = !(num(o.resident) > 0);
    var residentTax = m(o.resident);
    if (estimated) {
      var after = num(o.after) > 0 ? m(o.after) : Math.max(0, pay - salaryDeduction(pay));
      // 所得控除の合計が無ければ、社会保険料等と基礎控除だけとみなす
      var ded = num(o.deductions) > 0 ? m(o.deductions) : socialAll + bracket(DEDUCT_BASIC, after)[1];
      var taxable = Math.floor(Math.max(0, after - ded) * 10) / 10;     // 千円未満切り捨て
      residentTax = taxable > 0 ? taxable * 0.1 + 1 + 0.2 : 0;
    }
    var net = pay - social - incomeTax - residentTax;
    return {
      net: r2(net), social: r2(social), tax: r2(incomeTax + residentTax), incomeTax: r2(incomeTax), residentTax: r2(residentTax),
      small: r2(small), ratio: Math.round(net / pay * 1000) / 10, residentEstimated: estimated
    };
  }

  // 投資シミュレーション（Excel「投資シミュレーション」シートと同じ式）。金額は万円、率は％。
  // o: { start（前年末の残高）, contrib（毎年の積立額）, rate（想定利回り）, cost（信託報酬などのコスト）,
  //      age（今年末の年齢）, until（何歳まで積み立てるか）, to（何歳まで計算するか。無ければ until） }
  // 今年は（前年末の残高＋積立）×（1＋利回り−コスト）、翌年からは 前年×（1＋利回り−コスト）＋積立（until歳まで）。
  function investSim(o) {
    var r = (num(o.rate) - num(o.cost)) / 100;
    var age = Math.round(num(o.age)), until = Math.round(num(o.until)), c = num(o.contrib);
    var to = Math.round(o.to === undefined || o.to === '' ? until : num(o.to));
    to = Math.max(age, Math.min(to, age + 80));
    var rows = [], value = 0, cum = 0;
    for (var a = age; a <= to; a++) {
      var add = a > until ? 0 : c;
      if (a === age) { cum = num(o.start) + add; value = cum * (1 + r); }
      else { cum += add; value = value * (1 + r) + add; }
      rows.push({ age: a, contrib: add, cumulative: cum, value: value, ret: cum ? (value - cum) / cum : 0 });
    }
    var last = rows[rows.length - 1];
    return { rows: rows, value: last.value, cumulative: last.cumulative, gain: last.value - last.cumulative };
  }
  // 目標額に届く毎年の積立額（結果は積立額について一次式なので、0と1で計算して逆算する）
  function investNeed(o, target) {
    var a = investSim(Object.assign({}, o, { contrib: 0 })).value;
    var b = investSim(Object.assign({}, o, { contrib: 1 })).value - a;
    return b > 0 ? Math.max(0, (num(target) - a) / b) : 0;
  }

  // 扶養控除の区分を年齢から決める（その年の12月31日の年齢）。16歳未満は扶養控除なし（児童手当の対象）
  function dependentGroup(age) {
    if (age < 16) return 'under16';
    if (age <= 18) return 'g16';
    if (age <= 22) return 'g19';
    if (age < 70) return 'g16';
    return 'elder';
  }

  return {
    EDU_UNIT: EDU_UNIT, EDU_STAGES: EDU_STAGES,
    parseDate: parseDate, isDate: isDate, validate: validate, isEarlyBorn: isEarlyBorn, baseBirthYear: baseBirthYear,
    changeAt: changeAt, lumpAt: lumpAt, rangeAt: rangeAt,
    eduPlan: eduPlan, children: children, carOccurrences: carOccurrences, anchored: anchored,
    compute: compute, takeHome: takeHome, takeHomeFromSlip: takeHomeFromSlip, investSim: investSim, investNeed: investNeed, dependentGroup: dependentGroup, pensionEstimate: pensionEstimate, pensionDefaults: pensionDefaults,
    pensionPlan: pensionPlan, riskState: riskState, riskShortfall: riskShortfall, riskDropDefaults: riskDropDefaults, needSimple: needSimple, needFromPlan: needFromPlan, drawdownPlan: drawdownPlan, pensionCap: pensionCap, pensionNet: pensionNet, grossFromNet: grossFromNet, wageCurve: wageCurve, salarySeries: salarySeries, loanSchedule: loanSchedule
  };
}));
