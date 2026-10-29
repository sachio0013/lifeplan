// Excel書き出し（app/xlsx.js）のテスト。node --test で実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const X = require('../app/xlsx.js');

// zip の中身を読む（無圧縮だけ）
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = buf.length - 22;
  while (v.getUint32(e, true) !== 0x06054b50) e--;
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const crc = v.getUint32(p + 16, true), size = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nlen));
    const lnlen = v.getUint16(off + 26, true);
    const data = buf.slice(off + 30 + lnlen, off + 30 + lnlen + size);
    assert.equal(X.crc32(data), crc, name);
    out[name] = new TextDecoder().decode(data);
    p += 46 + nlen;
  }
  return out;
}

test('zip：CRC32が正しく、書いた内容をそのまま読み戻せる', () => {
  assert.equal(X.crc32(new TextEncoder().encode('hello')), 0x3610a686);
  const z = unzip(X.zip([{ name: 'a.txt', data: 'あいう' }, { name: 'dir/b.xml', data: '<x/>' }]));
  assert.deepEqual(z, { 'a.txt': 'あいう', 'dir/b.xml': '<x/>' });
});

test('ライフプランのExcel：サマリーとCF表、グラフ2つ（CF表のセルを参照）、行と列の固定、マイナスは赤字', () => {
  const vals = (a) => a.map(Number);
  const d = {
    plan: 'テスト<&>', date: new Date(2026, 9, 27), years: [2026, 2027, 2028],
    ages: [{ label: '夫', values: [35, 36, 37] }],
    groups: [
      { label: '収入', rows: [{ label: '夫の給与', values: vals([500, 510, 520]) }], total: { label: '収入計', key: 'income', values: vals([500, 510, 520]) } },
      { label: '支出', rows: [{ label: '基本生活費', values: vals([400, 600, 410]) }], total: { label: '支出計', key: 'expense', values: vals([400, 600, 410]) } }
    ],
    balance: { label: '年間収支', values: [100, -90, 110] },
    assets: { label: '金融資産残高（年末）', rows: [{ label: '普通預金等', key: 'deposit', values: [600, 510, 620] }, { label: '投資資産計', key: 'investTotal', values: [0, 0, 0] }],
      total: { label: '金融資産の合計', values: [600, 510, 620] } },
    keys: [['終了時点の金融資産', 620, '万円'], ['計算する期間', '2026年〜2028年', '']],
    family: [['家族１', '夫', '1991/01/01', 35]]
  };
  const z = unzip(X.lifeplanWorkbook(d));
  assert.ok(z['xl/workbook.xml'].includes('name="サマリー"') && z['xl/workbook.xml'].includes('name="CF表"'));
  assert.ok(z['xl/workbook.xml'].includes('_xlnm.Print_Titles'));
  const cf = z['xl/worksheets/sheet2.xml'];
  assert.match(cf, /<pane xSplit="1" ySplit="4" topLeftCell="B5"/);                  // 年と年齢の行、項目の列を固定
  assert.ok(cf.includes('キャッシュフロー表　テスト&lt;&amp;&gt;'));                     // 文字はエスケープ
  assert.ok(cf.includes('<v>-90</v>'));
  assert.ok(z['xl/styles.xml'].includes('[Red]'));                                   // マイナスは赤字
  const c1 = z['xl/charts/chart1.xml'], c2 = z['xl/charts/chart2.xml'];
  assert.ok(c1.includes('<c:barChart>') && c1.includes('<c:grouping val="stacked"/>'));
  assert.ok(c1.includes("'CF表'!$B$3:$D$3"));                                       // 年の行を参照
  assert.ok(c2.includes('<c:lineChart>') && c2.includes('<c:min val="0"/>'));
  assert.ok(z['xl/drawings/_rels/drawing1.xml.rels'].includes('../charts/chart2.xml'));
  assert.ok(z['[Content_Types].xml'].includes('/xl/charts/chart1.xml'));
});

test('保障のExcel：保障サマリー（結果・条件・遺族年金・3本の推移グラフ）、もしものCF表、かんたん計算', () => {
  const cf = {
    years: [2026, 2027], ages: [{ label: '妻', values: [35, 36] }],
    groups: [{ label: '収入', rows: [], total: { label: '収入計', key: 'income', values: [100, 100] } }, { label: '支出', rows: [], total: { label: '支出計', key: 'expense', values: [300, 300] } }],
    balance: { label: '年間収支', values: [-200, -200] },
    assets: { label: '金融資産残高（年末）', rows: [{ label: '普通預金等', key: 'deposit', values: [300, 100] }, { label: '投資資産計', key: 'investTotal', values: [0, 0] }], total: { label: '金融資産の合計', values: [300, 100] } },
    extra: [{ label: '比較（金融資産の合計）', rows: [{ label: 'いつも', key: 'base', values: [900, 1000] }, { label: 'もしも', key: 'risk', values: [300, 100] }, { label: '保険で備えた場合', key: 'covered', values: [800, 600] }] }]
  };
  const z = unzip(X.riskWorkbook({
    plan: 'テスト', date: new Date(2026, 9, 27), title: '夫が2026年（35歳）に亡くなったら', keys: [['必要保障額', 4023, '万円']],
    conds: [['亡くなる人', '夫', ''], ['葬儀・整理資金', 200, '万円']], steps: [[2026, 35, 177.5], [2056, 65, 141.5]], cf,
    simple: { need: 5547, expense: [['生活費', 100], ['支出の合計', 100]], income: [['今の金融資産', 10], ['収入の合計', 10]], table: [[35, 2, 80, 41.1, 56, 0, 177.1]] }
  }));
  assert.ok(['保障サマリー', 'もしものCF表', 'かんたん計算'].every((n) => z['xl/workbook.xml'].includes(`name="${n}"`)));
  const ch = z['xl/charts/chart1.xml'];
  assert.ok(ch.includes('<c:lineChart>') && (ch.match(/<c:ser>/g) || []).length === 3 && ch.includes('prstDash'));   // 保険で備えた場合は破線
  assert.ok(z['xl/worksheets/sheet1.xml'].includes('<v>2026</v>'));
  assert.ok(z['xl/worksheets/sheet3.xml'].includes('<v>5547</v>'));
});

test('家計簿のExcel：まとめ（区分別の積み上げ棒＋収入の折れ線）と、月×項目の1年の表', () => {
  const m = (v) => Array(12).fill(v).concat([v * 12]);
  const z = unzip(X.bookWorkbook({
    year: 2026, date: new Date(2026, 9, 27),
    blocks: [{ group: '１．支出' }, { label: '食費', values: m(50000) }, { label: '支出計', total: true, key: 'expense', values: m(50000) },
      { group: '３．区分別' }, { label: '1 基本生活費', key: 'cat1', values: m(50000) }, { label: '収入計', total: true, key: 'income', values: m(300000) },
      { label: '備考', text: true, values: Array(13).fill('') }],
    cats: [{ key: 'cat1', label: '1 基本生活費', color: '2A78D6' }, { key: 'cat9', label: 'なし', color: '000000' }],
    keys: [['収入の合計', 3600000, '円']]
  }));
  assert.ok(z['xl/workbook.xml'].includes('name="まとめ"') && z['xl/workbook.xml'].includes('name="2026年"'));
  const ch = z['xl/charts/chart1.xml'];
  assert.ok(ch.includes('<c:barChart>') && ch.includes('<c:lineChart>'));                  // 棒と折れ線を重ねる
  assert.ok(ch.includes("'2026年'!$B$3:$M$3") && !ch.includes('$N$'));                     // 1〜12月だけ（年計は含めない）
  assert.ok(ch.includes('<c:v>1月</c:v>') && ch.includes('<a:t>円</a:t>'));
  assert.equal((ch.match(/<c:ser>/g) || []).length, 2);                                      // 行の無い区分は入れない
});
