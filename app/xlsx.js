/*
 * Excel（.xlsx）の書き出し
 *
 * ネットにつながずに動くよう、外部のライブラリを使わずにファイルを組み立てる。
 *   1. zip（無圧縮）にまとめる部品
 *   2. ワークシート・スタイル・グラフ（DrawingML）のXML
 *   3. ライフプランの「サマリー」「CF表」の2枚のシートを作る lifeplanWorkbook
 * グラフはExcelの本物のグラフで、CF表のセルを参照する（あとからExcelで編集できる）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifePlanXlsx = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- zip（無圧縮） ----

  var CRC = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  }());
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(s); }

  // files: [{ name, data（文字列） }] → Uint8Array
  function zip(files, date) {
    var d = date || new Date();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, day, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, day, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var size = central.reduce(function (s, p) { return s + p.length; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, size, true); e.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(e.buffer)]);
    var out = new Uint8Array(all.reduce(function (s, p) { return s + p.length; }, 0)), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  // ---- XML の部品 ----

  function x(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function col(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function ref(c, r) { return col(c) + (r + 1); }
  var NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  // 色（アプリのピンクのテーマ）
  var C = { ink: '3D2A35', muted: '7B6572', accent: 'A02A5A', head: 'C2416F', section: 'FFF0F5', total: 'FCE4EC', line: 'EED8E2', deposit: 'E0558A', invest: '6D7EE6', income: '1BAF7A', expense: 'EB6834', paper: 'FFF7FA' };
  var FONT = 'Meiryo UI';

  // スタイル（cellXfs の番号）
  var S = { def: 0, title: 1, note: 2, head: 3, label: 4, num: 5, secLabel: 6, sec: 7, totLabel: 8, totNum: 9, age: 10, big: 11, key: 12, headLabel: 13, ageLabel: 14, unit: 15, text: 16, date: 17, keyBox: 18, bigNeg: 19 };
  function stylesXml() {
    var font = function (o) {
      return '<font>' + (o.b ? '<b/>' : '') + '<sz val="' + (o.sz || 10) + '"/><color rgb="FF' + (o.c || C.ink) + '"/><name val="' + FONT + '"/><family val="3"/><charset val="128"/></font>';
    };
    var fill = function (rgb) { return '<fill><patternFill patternType="solid"><fgColor rgb="FF' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>'; };
    var fonts = [font({}), font({ b: 1, sz: 18, c: C.accent }), font({ sz: 9, c: C.muted }), font({ b: 1, c: 'FFFFFF' }), font({ b: 1 }), font({ b: 1, sz: 16, c: C.accent }), font({ b: 1, sz: 11, c: C.accent }), font({ b: 1, sz: 16, c: 'C0392B' })];
    var fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', fill(C.head), fill(C.section), fill(C.total), fill(C.paper)];
    var line = '<color rgb="FF' + C.line + '"/>';
    var borders = [
      '<border><left/><right/><top/><bottom/><diagonal/></border>',
      '<border><left/><right/><top/><bottom style="thin">' + line + '</bottom><diagonal/></border>',
      '<border><left/><right/><top style="thin"><color rgb="FF' + C.head + '"/></top><bottom style="thin"><color rgb="FF' + C.head + '"/></bottom><diagonal/></border>',
      '<border><left style="thin">' + line + '</left><right style="thin">' + line + '</right><top style="thin">' + line + '</top><bottom style="thin">' + line + '</bottom><diagonal/></border>'
    ];
    // [numFmt, font, fill, border, 横位置]
    var xf = [
      [0, 0, 0, 0], [0, 1, 0, 0], [0, 2, 0, 0], [0, 3, 2, 0, 'center'], [0, 0, 0, 1], [164, 0, 0, 1, 'right'],
      [0, 6, 3, 1], [0, 0, 3, 1], [0, 4, 4, 2], [164, 4, 4, 2, 'right'], [166, 2, 0, 1, 'center'], [164, 5, 5, 3, 'right'],
      [0, 4, 5, 3], [0, 3, 2, 0, 'left'], [0, 2, 0, 1], [0, 2, 5, 3], [0, 0, 0, 1, 'left'], [0, 0, 0, 1, 'center'], [0, 2, 5, 3], [164, 7, 5, 3, 'right']
    ];
    return HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0;[Red]\\-#,##0;&quot;-&quot;"/><numFmt numFmtId="165" formatCode="#,##0.0;[Red]\\-#,##0.0"/><numFmt numFmtId="166" formatCode="0&quot;歳&quot;"/></numFmts>' +
      '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
      '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xf.length + '">' + xf.map(function (a) {
        return '<xf numFmtId="' + a[0] + '" fontId="' + a[1] + '" fillId="' + a[2] + '" borderId="' + a[3] + '" xfId="0"' +
          (a[0] ? ' applyNumberFormat="1"' : '') + ' applyFont="1"' + (a[2] ? ' applyFill="1"' : '') + (a[3] ? ' applyBorder="1"' : '') +
          ' applyAlignment="1"><alignment vertical="center"' + (a[4] ? ' horizontal="' + a[4] + '"' : '') + '/></xf>';
      }).join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }

  // シート1枚を組み立てる。cells: { 'r,c': { v, s } }
  function Sheet(name) {
    this.name = name; this.cells = {}; this.rows = {}; this.merges = []; this.cols = []; this.maxR = 0; this.maxC = 0;
  }
  Sheet.prototype.set = function (r, c, v, s) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) { if (s === undefined) return; v = ''; }
    this.cells[r + ',' + c] = { v: v, s: s || 0 };
    if (r > this.maxR) this.maxR = r; if (c > this.maxC) this.maxC = c;
  };
  Sheet.prototype.height = function (r, h) { this.rows[r] = h; };
  Sheet.prototype.merge = function (r1, c1, r2, c2) { this.merges.push(ref(c1, r1) + ':' + ref(c2, r2)); };
  Sheet.prototype.xml = function (o) {
    o = o || {};
    var self = this, rows = '';
    for (var r = 0; r <= this.maxR; r++) {
      var cs = '';
      for (var c = 0; c <= this.maxC; c++) {
        var cell = this.cells[r + ',' + c];
        if (!cell) continue;
        var at = ' r="' + ref(c, r) + '"' + (cell.s ? ' s="' + cell.s + '"' : '');
        if (typeof cell.v === 'number') cs += '<c' + at + '><v>' + Math.round(cell.v * 1000) / 1000 + '</v></c>';
        else if (cell.v === '') cs += '<c' + at + '/>';
        else cs += '<c' + at + ' t="inlineStr"><is><t xml:space="preserve">' + x(cell.v) + '</t></is></c>';
      }
      var ht = self.rows[r];
      if (cs || ht) rows += '<row r="' + (r + 1) + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>' + cs + '</row>';
    }
    var freeze = o.freeze ? '<pane' + (o.freeze[1] ? ' xSplit="' + o.freeze[1] + '"' : '') + ' ySplit="' + o.freeze[0] + '" topLeftCell="' + ref(o.freeze[1], o.freeze[0]) +
      '" activePane="' + (o.freeze[1] ? 'bottomRight' : 'bottomLeft') + '" state="frozen"/><selection pane="' + (o.freeze[1] ? 'bottomRight' : 'bottomLeft') + '"/>' : '';
    return HEAD + '<worksheet ' + NS + '>' +
      '<sheetPr><tabColor rgb="FF' + (o.tab || C.deposit) + '"/><pageSetUpPr fitToPage="1"/></sheetPr>' +
      '<dimension ref="A1:' + ref(this.maxC, this.maxR) + '"/>' +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0"' + (o.active ? ' tabSelected="1"' : '') + '>' + freeze + '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18" customHeight="1"/>' +
      (this.cols.length ? '<cols>' + this.cols.map(function (w) { return '<col min="' + w[0] + '" max="' + w[1] + '" width="' + w[2] + '" customWidth="1"/>'; }).join('') + '</cols>' : '') +
      '<sheetData>' + rows + '</sheetData>' +
      (this.merges.length ? '<mergeCells count="' + this.merges.length + '">' + this.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>' : '') +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="' + (o.portrait ? 'portrait' : 'landscape') + '" fitToWidth="' + (o.fitWidth || 1) + '" fitToHeight="' + (o.fitHeight === undefined ? 1 : o.fitHeight) + '"/>' +
      '<headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter>' +
      (o.drawing ? '<drawing r:id="rId1"/>' : '') +
      '</worksheet>';
  };

  // ---- グラフ（DrawingML） ----

  var TXT = function (sz, color, bold) {
    return '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + sz + '"' + (bold ? ' b="1"' : '') + '><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill>' +
      '<a:latin typeface="' + FONT + '"/><a:ea typeface="' + FONT + '"/></a:defRPr></a:pPr><a:endParaRPr lang="ja-JP"/></a:p></c:txPr>';
  };
  function strRef(f, v) { return '<c:strRef><c:f>' + x(f) + '</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' + x(v) + '</c:v></c:pt></c:strCache></c:strRef>'; }
  function numRef(f, vals, fmt) {
    return '<c:numRef><c:f>' + x(f) + '</c:f><c:numCache><c:formatCode>' + (fmt || 'General') + '</c:formatCode><c:ptCount val="' + vals.length + '"/>' +
      vals.map(function (v, i) { return isFinite(v) ? '<c:pt idx="' + i + '"><c:v>' + Math.round(v * 10) / 10 + '</c:v></c:pt>' : ''; }).join('') + '</c:numCache></c:numRef>';
  }
  // o: { title, type: 'bar'|'line', series: [{ name, nameRef, ref, values, color }], cats: { ref, values }, skip }
  function chartXml(o) {
    var ser = o.series.map(function (s, i) {
      var head = '<c:idx val="' + i + '"/><c:order val="' + i + '"/><c:tx>' + strRef(s.nameRef, s.name) + '</c:tx>';
      var cat = '<c:cat>' + numRef(o.cats.ref, o.cats.values) + '</c:cat><c:val>' + numRef(s.ref, s.values, '#,##0') + '</c:val>';
      if (o.type === 'bar') {
        return '<c:ser>' + head + '<c:spPr><a:solidFill><a:srgbClr val="' + s.color + '"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>' + cat + '</c:ser>';
      }
      return '<c:ser>' + head + '<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="' + s.color + '"/></a:solidFill><a:round/></a:ln></c:spPr>' +
        '<c:marker><c:symbol val="none"/></c:marker>' + cat + '<c:smooth val="0"/></c:ser>';
    }).join('');
    var plot = o.type === 'bar'
      ? '<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>' + ser + '<c:gapWidth val="40"/><c:overlap val="100"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>'
      : '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' + ser + '<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>';
    var axLine = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="' + C.line + '"/></a:solidFill></a:ln></c:spPr>';
    return HEAD + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<c:roundedCorners val="0"/>' +
      '<c:chart>' +
        '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="ja-JP" sz="1200" b="1"><a:solidFill><a:srgbClr val="' + C.ink + '"/></a:solidFill>' +
          '<a:latin typeface="' + FONT + '"/><a:ea typeface="' + FONT + '"/></a:rPr><a:t>' + x(o.title) + '</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>' +
        '<c:autoTitleDeleted val="0"/>' +
        '<c:plotArea><c:layout/>' + plot +
          '<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/>' +
            '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>' + axLine + TXT(900, C.muted) +
            '<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:tickLblSkip val="' + (o.skip || 5) + '"/><c:noMultiLvlLbl val="0"/></c:catAx>' +
          '<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/>' + (o.series.every(function (s) { return s.values.every(function (v) { return !(v < 0); }); }) ? '<c:min val="0"/>' : '') + '</c:scaling><c:delete val="0"/><c:axPos val="l"/>' +
            '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="F3E6EC"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
            '<c:title><c:tx><c:rich><a:bodyPr rot="0" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900" b="0"/></a:pPr><a:r><a:rPr lang="ja-JP" sz="900" b="0"><a:solidFill><a:srgbClr val="' + C.muted + '"/></a:solidFill></a:rPr><a:t>万円</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>' +
            '<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
            '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' + TXT(900, C.muted) + '<c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>' +
          '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
        '</c:plotArea>' +
        '<c:legend><c:legendPos val="t"/><c:overlay val="0"/>' + TXT(900, C.ink) + '</c:legend>' +
        '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>' +
      '</c:chart>' +
      '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="' + C.line + '"/></a:solidFill></a:ln></c:spPr>' +
      TXT(900, C.muted) +
      '</c:chartSpace>';
  }
  // anchors: [{ from: [col, row], to: [col, row] }]
  function drawingXml(anchors) {
    return HEAD + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      anchors.map(function (a, i) {
        return '<xdr:twoCellAnchor editAs="oneCell">' +
          '<xdr:from><xdr:col>' + a.from[0] + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + a.from[1] + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
          '<xdr:to><xdr:col>' + a.to[0] + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + a.to[1] + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
          '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="' + (i + 2) + '" name="グラフ ' + (i + 1) + '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
          '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
          '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId' + (i + 1) + '"/>' +
          '</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>';
      }).join('') + '</xdr:wsDr>';
  }
  function rels(list) {
    return HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list.map(function (r, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/' + r[0] + '" Target="' + r[1] + '"/>'; }).join('') + '</Relationships>';
  }

  // sheets: [{ sheet: Sheet, opts, charts: [chartXml の引数], anchors }]、printTitles: { sheetIndex, ref }
  function workbook(sheets, o) {
    o = o || {};
    var files = [], overrides = [], chartNo = 0, drawNo = 0;
    var T = 'officeDocument/2006/relationships/';
    sheets.forEach(function (sh, i) {
      var n = i + 1;
      if (sh.charts && sh.charts.length) {
        drawNo++;
        var crels = [];
        sh.charts.forEach(function (ch) {
          chartNo++;
          files.push({ name: 'xl/charts/chart' + chartNo + '.xml', data: chartXml(ch) });
          overrides.push(['/xl/charts/chart' + chartNo + '.xml', 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml']);
          crels.push([T + 'chart', '../charts/chart' + chartNo + '.xml']);
        });
        files.push({ name: 'xl/drawings/drawing' + drawNo + '.xml', data: drawingXml(sh.anchors) });
        files.push({ name: 'xl/drawings/_rels/drawing' + drawNo + '.xml.rels', data: rels(crels) });
        files.push({ name: 'xl/worksheets/_rels/sheet' + n + '.xml.rels', data: rels([[T + 'drawing', '../drawings/drawing' + drawNo + '.xml']]) });
        overrides.push(['/xl/drawings/drawing' + drawNo + '.xml', 'application/vnd.openxmlformats-officedocument.drawing+xml']);
        sh.opts = Object.assign({}, sh.opts, { drawing: true });
      }
      files.push({ name: 'xl/worksheets/sheet' + n + '.xml', data: sh.sheet.xml(Object.assign({ active: i === 0 }, sh.opts)) });
      overrides.push(['/xl/worksheets/sheet' + n + '.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']);
    });
    var defined = (o.printTitles || []).map(function (p) {
      return '<definedName name="_xlnm.Print_Titles" localSheetId="' + p.sheet + '">' + x(p.ref) + '</definedName>';
    }).join('');
    files.unshift(
      { name: '[Content_Types].xml', data: HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        overrides.map(function (v) { return '<Override PartName="' + v[0] + '" ContentType="' + v[1] + '"/>'; }).join('') + '</Types>' },
      { name: '_rels/.rels', data: rels([[T + 'officeDocument', 'xl/workbook.xml'], ['package/2006/relationships/metadata/core-properties', 'docProps/core.xml']]) },
      { name: 'docProps/core.xml', data: HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        '<dc:title>' + x(o.title || 'ライフプラン表') + '</dc:title><dc:creator>ライフプラン表</dc:creator>' +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + (o.date || new Date()).toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created></cp:coreProperties>' },
      { name: 'xl/workbook.xml', data: HEAD + '<workbook ' + NS + '><bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
        sheets.map(function (sh, i) { return '<sheet name="' + x(sh.sheet.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets>' +
        (defined ? '<definedNames>' + defined + '</definedNames>' : '') + '</workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: rels(sheets.map(function (sh, i) { return [T + 'worksheet', 'worksheets/sheet' + (i + 1) + '.xml']; }).concat([[T + 'styles', 'styles.xml']])) },
      { name: 'xl/styles.xml', data: stylesXml() }
    );
    return zip(files, o.date);
  }

  // ---- ライフプランの書き出し ----
  //
  // d: { plan（プラン名）, date（Date）, years, ages: [{ label, values }],
  //      groups: [{ label, rows: [{ label, values }], total: { label, values } }],   … 収入・支出
  //      balance: { label, values }, assets: { label, rows: [...], total: {...} }, deposit（普通預金等の行の番号）, investTotal（投資資産計の行の番号）,
  //      keys: [[見出し, 値, 単位, 赤字にするか]], family: [[続柄, 名前, 生年月日, 開始年の年齢]] }
  function lifeplanWorkbook(d) {
    var n = d.years.length, last = n;   // 年の列は B〜
    var cf = new Sheet('CF表');
    cf.cols = [[1, 1, 24], [2, n + 1, 8.6]];
    cf.set(0, 0, 'キャッシュフロー表　' + d.plan, S.title); cf.height(0, 30);
    cf.set(1, 0, '単位：万円（年末の残高）。この表は入力した条件にもとづく試算です。', S.note);
    var r = 2;
    cf.set(r, 0, '年', S.headLabel);
    d.years.forEach(function (y, i) { cf.set(r, i + 1, y, S.head); });
    cf.height(r, 22);
    var yearRow = r;
    r++;
    d.ages.forEach(function (a) {
      cf.set(r, 0, a.label, S.ageLabel);
      a.values.forEach(function (v, i) { cf.set(r, i + 1, v === null || v === undefined ? '' : v, S.age); });
      r++;
    });
    var freezeRow = r;
    var rowOf = {};
    var putRows = function (g) {
      cf.set(r, 0, g.label, S.secLabel);
      for (var i = 1; i <= last; i++) cf.set(r, i, '', S.sec);
      r++;
      g.rows.forEach(function (row) {
        cf.set(r, 0, '　' + row.label, S.label);
        row.values.forEach(function (v, i) { cf.set(r, i + 1, v, S.num); });
        if (row.key) rowOf[row.key] = r;
        r++;
      });
      if (g.total) {
        cf.set(r, 0, g.total.label, S.totLabel);
        g.total.values.forEach(function (v, i) { cf.set(r, i + 1, v, S.totNum); });
        if (g.total.key) rowOf[g.total.key] = r;
        r++;
      }
    };
    d.groups.forEach(putRows);
    cf.set(r, 0, d.balance.label, S.totLabel);
    d.balance.values.forEach(function (v, i) { cf.set(r, i + 1, v, S.totNum); });
    rowOf.balance = r; r++;
    putRows(d.assets);

    // サマリー
    var sm = new Sheet('サマリー');
    sm.cols = [[1, 1, 30], [2, 2, 16], [3, 3, 8], [4, 9, 11]];
    sm.set(0, 0, 'ライフプラン表　' + d.plan, S.title); sm.height(0, 34);
    var dt = d.date || new Date();
    sm.set(1, 0, dt.getFullYear() + '年' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日に作成。入力した条件にもとづく試算で、将来を約束するものではありません。', S.note);
    var k = 3;
    sm.set(k, 0, 'ポイント', S.secLabel); sm.set(k, 1, '', S.sec); sm.set(k, 2, '', S.sec); k++;
    d.keys.forEach(function (row) {
      sm.set(k, 0, row[0], S.keyBox);
      sm.set(k, 1, row[1], typeof row[1] === 'number' ? (row[3] ? S.bigNeg : S.big) : S.keyBox);
      sm.set(k, 2, row[2] || '', S.unit);
      sm.height(k, 30);
      k++;
    });
    k++;
    sm.set(k, 0, '家族', S.secLabel); for (var j = 1; j <= 3; j++) sm.set(k, j, '', S.sec); k++;
    ['続柄', '名前', '生年月日', '年齢'].forEach(function (h, i) { sm.set(k, i, h, i ? S.head : S.headLabel); }); k++;
    d.family.forEach(function (f) { f.forEach(function (v, i) { sm.set(k, i, v, i === 3 ? S.age : i === 2 ? S.date : S.text); }); k++; });
    k += 1;
    var chartTop = k;
    var cfRef = function (row, from, to) { return "'CF表'!$" + col(from) + '$' + (row + 1) + ':$' + col(to) + '$' + (row + 1); };
    var nameRef = function (row) { return "'CF表'!$A$" + (row + 1); };
    var cats = { ref: cfRef(yearRow, 1, last), values: d.years };
    var vals = function (row) { var a = []; for (var i = 1; i <= last; i++) { var c = cf.cells[row + ',' + i]; a.push(c && typeof c.v === 'number' ? c.v : NaN); } return a; };
    var skip = n > 40 ? 5 : n > 20 ? 2 : 1;
    var charts = [
      { title: '金融資産残高の推移', type: 'bar', cats: cats, skip: skip, series: [
        { name: '普通預金等', nameRef: nameRef(rowOf.deposit), ref: cfRef(rowOf.deposit, 1, last), values: vals(rowOf.deposit), color: C.deposit },
        { name: '投資資産', nameRef: nameRef(rowOf.investTotal), ref: cfRef(rowOf.investTotal, 1, last), values: vals(rowOf.investTotal), color: C.invest }
      ] },
      { title: '収入と支出', type: 'line', cats: cats, skip: skip, series: [
        { name: '収入計', nameRef: nameRef(rowOf.income), ref: cfRef(rowOf.income, 1, last), values: vals(rowOf.income), color: C.income },
        { name: '支出計', nameRef: nameRef(rowOf.expense), ref: cfRef(rowOf.expense, 1, last), values: vals(rowOf.expense), color: C.expense }
      ] }
    ];
    var anchors = [{ from: [0, chartTop], to: [9, chartTop + 20] }, { from: [0, chartTop + 21], to: [9, chartTop + 41] }];
    sm.set(chartTop + 42, 0, '詳しい数字は「CF表」のシートにあります。グラフは「CF表」のセルを参照しているので、表の数字を書き換えるとグラフも変わります。', S.note);

    return workbook([
      { sheet: sm, opts: { tab: C.deposit, portrait: true, fitWidth: 1, fitHeight: 1 }, charts: charts, anchors: anchors },
      { sheet: cf, opts: { tab: C.invest, freeze: [freezeRow, 1], fitWidth: Math.max(1, Math.ceil(n / 20)), fitHeight: 1 } }
    ], { title: 'ライフプラン表　' + d.plan, date: d.date, printTitles: [{ sheet: 1, ref: "'CF表'!$A:$A,'CF表'!$" + (yearRow + 1) + ':$' + freezeRow }] });
  }

  return { zip: zip, crc32: crc32, Sheet: Sheet, workbook: workbook, lifeplanWorkbook: lifeplanWorkbook, col: col };
}));
