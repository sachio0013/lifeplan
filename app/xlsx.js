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
  var S = { def: 0, title: 1, note: 2, head: 3, label: 4, num: 5, secLabel: 6, sec: 7, totLabel: 8, totNum: 9, age: 10, big: 11, key: 12, headLabel: 13, ageLabel: 14, unit: 15, text: 16, date: 17, keyBox: 18, bigNeg: 19, plain: 20 };
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
      [0, 4, 5, 3], [0, 3, 2, 0, 'left'], [0, 2, 0, 1], [0, 2, 5, 3], [0, 0, 0, 1, 'left'], [0, 0, 0, 1, 'center'], [0, 2, 5, 3], [164, 7, 5, 3, 'right'], [0, 0, 0, 1, 'center']
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
  function strRefs(f, vals) {
    return '<c:strRef><c:f>' + x(f) + '</c:f><c:strCache><c:ptCount val="' + vals.length + '"/>' +
      vals.map(function (v, i) { return '<c:pt idx="' + i + '"><c:v>' + x(v) + '</c:v></c:pt>'; }).join('') + '</c:strCache></c:strRef>';
  }
  // o: { title, type: 'bar'|'line', series: [{ name, nameRef, ref, values, color, dash }], lines（棒に重ねる折れ線）, cats: { ref, values, str }, skip, unit }
  function chartXml(o) {
    var catXml = '<c:cat>' + (o.cats.str ? strRefs(o.cats.ref, o.cats.values) : numRef(o.cats.ref, o.cats.values)) + '</c:cat>';
    var head = function (s, i) { return '<c:idx val="' + i + '"/><c:order val="' + i + '"/><c:tx>' + strRef(s.nameRef, s.name) + '</c:tx>'; };
    var val = function (s) { return '<c:val>' + numRef(s.ref, s.values, '#,##0') + '</c:val>'; };
    var lineSer = function (s, i) {
      return '<c:ser>' + head(s, i) + '<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="' + s.color + '"/></a:solidFill>' + (s.dash ? '<a:prstDash val="dash"/>' : '') + '<a:round/></a:ln></c:spPr>' +
        '<c:marker><c:symbol val="none"/></c:marker>' + catXml + val(s) + '<c:smooth val="0"/></c:ser>';
    };
    var lineChart = function (list, from) {
      return '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' + list.map(function (s, i) { return lineSer(s, from + i); }).join('') + '<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>';
    };
    var plot = o.type === 'bar'
      ? '<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>' + o.series.map(function (s, i) {
          return '<c:ser>' + head(s, i) + '<c:spPr><a:solidFill><a:srgbClr val="' + s.color + '"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>' + catXml + val(s) + '</c:ser>';
        }).join('') + '<c:gapWidth val="' + (o.gap || 40) + '"/><c:overlap val="100"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>' +
        (o.lines && o.lines.length ? lineChart(o.lines, o.series.length) : '')
      : lineChart(o.series, 0);
    var allSeries = o.series.concat(o.lines || []);
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
          '<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/>' + (allSeries.every(function (s) { return s.values.every(function (v) { return !(v < 0); }); }) ? '<c:min val="0"/>' : '') + '</c:scaling><c:delete val="0"/><c:axPos val="l"/>' +
            '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="F3E6EC"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
            '<c:title><c:tx><c:rich><a:bodyPr rot="0" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900" b="0"/></a:pPr><a:r><a:rPr lang="ja-JP" sz="900" b="0"><a:solidFill><a:srgbClr val="' + C.muted + '"/></a:solidFill></a:rPr><a:t>' + x(o.unit || '万円') + '</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>' +
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

  // ---- 表のシート（見出しの行＋区分・行） ----
  //
  // t: { title, note, headLabel, heads（年や月）, pre: [{ label, values }]（年齢など）, blocks: [ { group } | { label, values, key, total, text } ],
  //      widths: [項目の列, 値の列] }
  // 返り値 { sheet, rowOf（key → 行の番号）, headRow, freezeRow, n }
  function tableSheet(name, t) {
    var n = t.heads.length;
    var sh = new Sheet(name);
    sh.cols = [[1, 1, (t.widths || [24])[0]], [2, n + 1, (t.widths || [24, 8.6])[1]]];
    sh.set(0, 0, t.title, S.title); sh.height(0, 30);
    if (t.note) sh.set(1, 0, t.note, S.note);
    var r = 2;
    sh.set(r, 0, t.headLabel || '年', S.headLabel);
    t.heads.forEach(function (h, i) { sh.set(r, i + 1, h, S.head); });
    sh.height(r, 22);
    var headRow = r++;
    (t.pre || []).forEach(function (a) {
      sh.set(r, 0, a.label, S.ageLabel);
      a.values.forEach(function (v, i) { sh.set(r, i + 1, v === null || v === undefined ? '' : v, S.age); });
      r++;
    });
    var freezeRow = r, rowOf = {};
    t.blocks.forEach(function (b) {
      if (b.group) {
        sh.set(r, 0, b.group, S.secLabel);
        for (var i = 1; i <= n; i++) sh.set(r, i, '', S.sec);
      } else {
        sh.set(r, 0, b.total ? b.label : '　' + b.label, b.total ? S.totLabel : S.label);
        b.values.forEach(function (v, i) { sh.set(r, i + 1, v === null || v === undefined ? '' : v, b.text ? S.text : b.total ? S.totNum : S.num); });
        if (b.key) rowOf[b.key] = r;
      }
      r++;
    });
    return { sheet: sh, rowOf: rowOf, headRow: headRow, freezeRow: freezeRow, n: n, lastRow: r - 1 };
  }
  // グラフの系列（表の行を参照）
  function seriesOf(tb, key, name, color, o) {
    var row = tb.rowOf[key], vals = [];
    for (var i = 1; i <= tb.n; i++) { var c = tb.sheet.cells[row + ',' + i]; vals.push(c && typeof c.v === 'number' ? c.v : NaN); }
    var q = "'" + tb.sheet.name + "'!";
    return Object.assign({ name: name, nameRef: q + '$A$' + (row + 1), ref: q + '$B$' + (row + 1) + ':$' + col(tb.n) + '$' + (row + 1), values: vals, color: color }, o || {});
  }
  function catsOf(tb, str) {
    var vals = [];
    for (var i = 1; i <= tb.n; i++) vals.push(tb.sheet.cells[tb.headRow + ',' + i].v);
    return { ref: "'" + tb.sheet.name + "'!$B$" + (tb.headRow + 1) + ':$' + col(tb.n) + '$' + (tb.headRow + 1), values: vals, str: !!str };
  }
  function printTitles(tb, index) {
    return { sheet: index, ref: "'" + tb.sheet.name + "'!$A:$A,'" + tb.sheet.name + "'!$" + (tb.headRow + 1) + ':$' + tb.freezeRow };
  }
  function dateText(dt) { return dt.getFullYear() + '年' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日に作成'; }

  // まとめのシート：タイトル、ポイント（見出し・値・単位）、表、グラフの場所
  // m: { title, note, keys: [[見出し, 値, 単位, 赤字]], tables: [{ label, head: [...], rows: [[...]], styles: [...] }], widths }
  function summarySheet(name, m) {
    var sm = new Sheet(name);
    sm.cols = m.widths || [[1, 1, 30], [2, 2, 16], [3, 3, 8], [4, 9, 11]];
    sm.set(0, 0, m.title, S.title); sm.height(0, 34);
    sm.set(1, 0, m.note, S.note);
    var k = 3;
    if (m.keys && m.keys.length) {
      sm.set(k, 0, m.keysLabel || 'ポイント', S.secLabel); sm.set(k, 1, '', S.sec); sm.set(k, 2, '', S.sec); k++;
      m.keys.forEach(function (row) {
        sm.set(k, 0, row[0], S.keyBox);
        sm.set(k, 1, row[1], typeof row[1] === 'number' ? (row[3] ? S.bigNeg : S.big) : S.keyBox);
        sm.set(k, 2, row[2] || '', S.unit);
        sm.height(k, 30);
        k++;
      });
      k++;
    }
    (m.tables || []).forEach(function (t) {
      var w = t.head.length;
      sm.set(k, 0, t.label, S.secLabel); for (var j = 1; j < w; j++) sm.set(k, j, '', S.sec); k++;
      t.head.forEach(function (h, i) { sm.set(k, i, h, i ? S.head : S.headLabel); }); k++;
      t.rows.forEach(function (row, ri) {
        var tot = t.total && ri === t.rows.length - 1;
        row.forEach(function (v, i) {
          var st = typeof v === 'number'
            ? (tot ? S.totNum : (t.ageCols || []).indexOf(i) >= 0 ? S.age : (t.plainCols || []).indexOf(i) >= 0 ? S.plain : S.num)
            : i ? (tot ? S.totNum : S.date) : (tot ? S.totLabel : S.text);
          sm.set(k, i, v, st);
        });
        k++;
      });
      k++;
    });
    return { sheet: sm, next: k };
  }

  // ---- ライフプラン（未来の表）の書き出し ----
  //
  // d: { plan, date, years, ages: [{ label, values }], groups: [{ label, rows: [{ label, values, key }], total: { label, values, key } }],
  //      balance: { label, values }, assets: { label, rows, total }, keys: [[見出し, 値, 単位, 赤字]], family: [[続柄, 名前, 生年月日, 年齢]] }
  // 行の key：income（収入計）、expense（支出計）、deposit（普通預金等）、investTotal（投資資産計）
  function cfBlocks(d) {
    var blocks = [];
    var put = function (g) {
      blocks.push({ group: g.label });
      g.rows.forEach(function (r) { blocks.push(r); });
      if (g.total) blocks.push(Object.assign({ total: true }, g.total));
    };
    d.groups.forEach(put);
    blocks.push(Object.assign({ total: true }, d.balance));
    put(d.assets);
    (d.extra || []).forEach(put);
    return blocks;
  }
  function lifeplanWorkbook(d) {
    var dt = d.date || new Date();
    var tb = tableSheet('CF表', { title: 'キャッシュフロー表　' + d.plan, note: '単位：万円（年末の残高）。この表は入力した条件にもとづく試算です。', heads: d.years, pre: d.ages, blocks: cfBlocks(d) });
    var sm = summarySheet('サマリー', {
      title: 'ライフプラン表　' + d.plan, note: dateText(dt) + '。入力した条件にもとづく試算で、将来を約束するものではありません。',
      keys: d.keys, tables: [{ label: '家族', head: ['続柄', '名前', '生年月日', '年齢'], rows: d.family, ageCols: [3] }]
    });
    var top = sm.next, cats = catsOf(tb), skip = d.years.length > 40 ? 5 : d.years.length > 20 ? 2 : 1;
    var charts = [
      { title: '金融資産残高の推移', type: 'bar', cats: cats, skip: skip, series: [seriesOf(tb, 'deposit', '普通預金等', C.deposit), seriesOf(tb, 'investTotal', '投資資産', C.invest)] },
      { title: '収入と支出', type: 'line', cats: cats, skip: skip, series: [seriesOf(tb, 'income', '収入計', C.income), seriesOf(tb, 'expense', '支出計', C.expense)] }
    ];
    sm.sheet.set(top + 42, 0, '詳しい数字は「CF表」のシートにあります。グラフは「CF表」のセルを参照しているので、表の数字を書き換えるとグラフも変わります。', S.note);
    return workbook([
      { sheet: sm.sheet, opts: { tab: C.deposit, portrait: true, fitWidth: 1, fitHeight: 1 }, charts: charts, anchors: [{ from: [0, top], to: [9, top + 20] }, { from: [0, top + 21], to: [9, top + 41] }] },
      { sheet: tb.sheet, opts: { tab: C.invest, freeze: [tb.freezeRow, 1], fitWidth: Math.max(1, Math.ceil(tb.n / 20)), fitHeight: 1 } }
    ], { title: 'ライフプラン表　' + d.plan, date: dt, printTitles: [printTitles(tb, 1)] });
  }

  // ---- 保障（もしもの場合）の書き出し ----
  //
  // d: { plan, date, title（「夫が2026年（35歳）に亡くなったら」）, keys, conds: [[見出し, 値, 単位]], steps: [[年, 配偶者の年齢, 額]],
  //      cf: lifeplanWorkbook の d と同じ形（もしもの場合のCF。extra に比較の行 base・risk・covered と遺族年金の行）,
  //      simple: { need, income: [[見出し, 額]], expense: [[見出し, 額]], table: [[年齢, 子, 基礎, 厚生, 子の加算, 65歳から, 計]] } | null }
  function riskWorkbook(d) {
    var dt = d.date || new Date();
    var tb = tableSheet('もしものCF表', { title: 'もしもの場合のキャッシュフロー表　' + d.plan, note: d.title + '。単位：万円（年末の残高）。', heads: d.cf.years, pre: d.cf.ages, blocks: cfBlocks(d.cf) });
    var sm = summarySheet('保障サマリー', {
      title: 'もしもの保障　' + d.plan, note: dateText(dt) + '。' + d.title + '。入力した条件にもとづく試算で、特定の保険商品をすすめるものではありません。',
      keysLabel: '結果', keys: d.keys,
      tables: [
        { label: '条件', head: ['項目', '値', '単位'], rows: d.conds },
        { label: '遺族年金など（年額・手取り）', head: ['年から', '配偶者の年齢', '万円'], rows: d.steps, plainCols: [0], ageCols: [1] }
      ],
      widths: [[1, 1, 34], [2, 2, 16], [3, 3, 10], [4, 9, 11]]
    });
    var top = sm.next, cats = catsOf(tb), skip = d.cf.years.length > 40 ? 5 : d.cf.years.length > 20 ? 2 : 1;
    var lines = [seriesOf(tb, 'base', 'いつも', C.invest), seriesOf(tb, 'risk', 'もしも', 'C0392B')];
    if (tb.rowOf.covered !== undefined) lines.push(seriesOf(tb, 'covered', '保険で備えた場合', C.income, { dash: true }));
    var charts = [{ title: '金融資産の推移（いつも・もしも）', type: 'line', cats: cats, skip: skip, series: lines }];
    var anchors = [{ from: [0, top], to: [9, top + 22] }];
    sm.sheet.set(top + 23, 0, '「もしものCF表」のシートに、もしもの場合の年ごとの収入・支出・遺族年金があります。', S.note);
    var sheets = [
      { sheet: sm.sheet, opts: { tab: 'C0392B', portrait: true, fitWidth: 1, fitHeight: 1 }, charts: charts, anchors: anchors },
      { sheet: tb.sheet, opts: { tab: C.deposit, freeze: [tb.freezeRow, 1], fitWidth: Math.max(1, Math.ceil(tb.n / 20)), fitHeight: 1 } }
    ];
    if (d.simple) {
      var s = d.simple;
      var ss = summarySheet('かんたん計算', {
        title: '必要保障額のかんたん計算　' + d.plan, note: 'Excel「必要保障額」シートの考え方（支出の合計−収入の合計）。' + (s.note || ''),
        keysLabel: '結果', keys: [['必要保障額', s.need, '万円']],
        tables: [
          { label: '支出', head: ['項目', '万円'], rows: s.expense, total: true },
          { label: '収入', head: ['項目', '万円'], rows: s.income, total: true },
          { label: '遺族年金など（配偶者の年齢ごと・年額）', head: ['年齢', '18歳以下の子', '遺族基礎年金', '遺族厚生年金', '子の加算', '65歳から', '計'], rows: s.table, ageCols: [0], plainCols: [1] }
        ],
        widths: [[1, 1, 30], [2, 7, 13]]
      });
      sheets.push({ sheet: ss.sheet, opts: { tab: C.invest, portrait: true, fitWidth: 1, fitHeight: 0 } });
    }
    return workbook(sheets, { title: 'もしもの保障　' + d.plan, date: dt, printTitles: [printTitles(tb, 1)] });
  }

  // ---- 家計簿（1年の表）の書き出し ----
  //
  // d: { year, date, blocks（tableSheet の blocks。key: cat1〜cat6・income・expense）, cats: [{ key, label, color }], keys: [[見出し, 値, 単位]] }
  function bookWorkbook(d) {
    var dt = d.date || new Date();
    var heads = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '年計'];
    var tb = tableSheet(d.year + '年', { title: d.year + '年の家計簿（年間収支）', note: '単位：円。Excel「家計簿（年間収支）」シートと同じ並びです。', headLabel: '項目', heads: heads, blocks: d.blocks, widths: [26, 11] });
    var sm = summarySheet('まとめ', { title: d.year + '年の家計簿', note: dateText(dt) + '。', keys: d.keys });
    var top = sm.next;
    // グラフは1〜12月（年計の列は含めない）
    var month = function (srs) { srs.ref = srs.ref.replace(/\$N\$/, '$M$'); srs.values = srs.values.slice(0, 12); return srs; };
    var cats = catsOf(tb, true); cats.ref = cats.ref.replace(/\$N\$/, '$M$'); cats.values = cats.values.slice(0, 12);
    var bars = d.cats.filter(function (c) { return tb.rowOf[c.key] !== undefined; }).map(function (c) { return month(seriesOf(tb, c.key, c.label, c.color)); });
    var charts = [{ title: '月ごとの支出（区分別）と収入', type: 'bar', cats: cats, skip: 1, unit: '円', gap: 60, series: bars, lines: [month(seriesOf(tb, 'income', '収入', C.ink))] }];
    return workbook([
      { sheet: sm.sheet, opts: { tab: C.deposit, portrait: true, fitWidth: 1, fitHeight: 1 }, charts: charts, anchors: [{ from: [0, top], to: [9, top + 22] }] },
      { sheet: tb.sheet, opts: { tab: C.invest, freeze: [tb.freezeRow, 1], fitWidth: 1, fitHeight: 0 } }
    ], { title: d.year + '年の家計簿', date: dt, printTitles: [printTitles(tb, 1)] });
  }

  return { zip: zip, crc32: crc32, Sheet: Sheet, workbook: workbook, tableSheet: tableSheet, lifeplanWorkbook: lifeplanWorkbook, riskWorkbook: riskWorkbook, bookWorkbook: bookWorkbook, col: col };
}));
