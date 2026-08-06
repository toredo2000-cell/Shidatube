const SETUP_TOKEN_PROPERTY = 'SHIDATUBE_SETUP_TOKEN';
const SHEET_NAME = 'Shorts一覧';
const ANALYTICS_FOLDER_ID = '1tcNK-v0rdVBGdN-GXq_g5PYravTjHzWZ';
const ZIP_ANALYTICS_SHEET_PREFIX = '分析_';

const ZIP_ANALYTICS_CONFIG = [
  { key: 'チャンネル登録状況', title: '登録済み／未登録' },
  { key: 'チャンネル登録元', title: 'チャンネル登録元' },
  { key: '地域', title: '地域 TOP10' },
  { key: 'デバイスのタイプ', title: 'デバイス構成' },
  { key: '視聴者の性別', title: '視聴者の性別' },
  { key: '字幕', title: '字幕利用' },
  { key: '翻訳版の使用', title: '翻訳版の使用' },
  { key: '終了画面要素', title: '終了画面' }
];

const HEADERS = [
  'No.',
  '公開日時',
  'タイトル',
  'URL',
  '動画ID',
  '長さ（秒）',
  '再生回数',
  '高評価数',
  'コメント数',
  'カテゴリ',
  'ステータス',
  '元配信',
  '評価',
  'メモ',
  '最終更新'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ShidaTube管理')
    .addItem('運営シートを初期設定', 'setupDailyOperations')
    .addItem('認証トークンを設定', 'setSetupToken')
    .addItem('ダッシュボードを更新', 'refreshDashboard')
    .addItem('分析CSVシートを準備', 'setupAnalyticsSheets')
    .addItem('90日分析を更新', 'refreshAnalyticsDashboard')
    .addItem('YouTube分析ZIPを取り込む', 'importAnalyticsZips')
    .addSeparator()
    .addItem('投稿管理に新しい行を追加', 'addPostingRow')
    .addItem('切り抜き候補に新しい行を追加', 'addClipRow')
    .addItem('選択中のライブから候補を追加', 'addClipFromSelectedLive')
    .addItem('切り抜き管理を更新', 'refreshClipManagement')
    .addToUi();
}

function onEdit(e) {
  if (!e || !e.range) return;

  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== '切り抜き候補' || range.getRow() < 2) return;

  const firstColumn = range.getColumn();
  const lastColumn = range.getLastColumn();
  if (firstColumn <= 5 && lastColumn >= 4) {
    applyClipStartTimeLinks_(sheet, range.getRow(), range.getNumRows());
  }
}

function setupDailyOperations() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  setupShortsSheet_(ss);
  setupNormalVideosSheet_(ss);
  setupLiveSheet_(ss);
  setupClipSheet_(ss);
  setupPostingSheet_(ss);
  setupIdeaSheet_(ss);
  setupMasterSheet_(ss);
  setupAnalyticsSheets_(ss);
  setupZipAnalyticsSheets_(ss);
  setupDashboard_(ss);
  setupAnalyticsDashboard_(ss);

  ss.setActiveSheet(ss.getSheetByName('Dashboard'));
  SpreadsheetApp.getUi().alert('ShidaTube運営管理シートの初期設定が完了しました。');
}

function setSetupToken() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '認証トークンを設定',
    '外部の取得スクリプトと共通で使用する、推測されにくい文字列を入力してください。',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) return;

  const token = response.getResponseText().trim();
  if (!token) {
    ui.alert('トークンが空のため、設定を中止しました。');
    return;
  }

  PropertiesService.getScriptProperties().setProperty(SETUP_TOKEN_PROPERTY, token);
  ui.alert('認証トークンを保存しました。コードやシート上には表示されません。');
}

function getSetupToken_() {
  return PropertiesService.getScriptProperties().getProperty(SETUP_TOKEN_PROPERTY) || '';
}

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (params.mode === 'clip') {
    return buildClipPlayerHtml_(params.videoId, params.start);
  }

  return jsonResponse_({
    ok: true,
    service: 'ShidaTube Shorts Sheet Receiver'
  });
}

function buildClipPlayerHtml_(videoIdValue, startValue) {
  const videoId = extractYouTubeVideoId_(videoIdValue);
  const start = Math.max(Math.floor(Number(startValue) || 0), 0);
  if (!videoId) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><html><body><p>動画IDを確認できませんでした。</p></body></html>'
    ).setTitle('ShidaTube 再生位置エラー');
  }

  const embedUrl = 'https://www.youtube-nocookie.com/embed/' + videoId
    + '?start=' + start + '&autoplay=1&playsinline=1&rel=0';
  const watchUrl = 'https://www.youtube.com/watch?v=' + videoId + '&t=' + start + 's';
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{margin:0;background:#111;color:#fff;font-family:Arial,sans-serif}'
    + '.wrap{max-width:1200px;margin:0 auto;padding:16px}.player{position:relative;padding-top:56.25%}'
    + 'iframe{position:absolute;inset:0;width:100%;height:100%;border:0}'
    + 'p{margin:12px 0 0}a{color:#90caf9}</style></head><body><div class="wrap">'
    + '<div class="player"><iframe src="' + embedUrl + '" allow="autoplay; encrypted-media; picture-in-picture" '
    + 'referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>'
    + '<p>指定位置: ' + start + '秒　<a href="' + watchUrl + '" target="_blank" rel="noopener">通常のYouTubeで開く</a></p>'
    + '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('ShidaTube 指定位置プレーヤー');
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');

    const setupToken = getSetupToken_();
    if (!setupToken || !payload.token || payload.token !== setupToken) {
      return jsonResponse_({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    const normalVideos = Array.isArray(payload.normalVideos) ? payload.normalVideos : [];
    const streams = Array.isArray(payload.streams) ? payload.streams : [];

    const shortsResult = updateShortsSheet_(videos);
    const normalResult = updateNormalVideosSheet_(normalVideos);
    const streamResult = updateLiveSheet_(streams);
    refreshDashboard();

    return jsonResponse_({
      ok: true,
      videoCount: videos.length,
      addedCount: shortsResult.addedCount,
      updatedCount: shortsResult.updatedCount,
      normalVideoCount: normalVideos.length,
      normalAddedCount: normalResult.addedCount,
      normalUpdatedCount: normalResult.updatedCount,
      streamCount: streams.length,
      streamAddedCount: streamResult.addedCount,
      streamUpdatedCount: streamResult.updatedCount
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error && error.message ? error.message : error)
    });
  }
}

function setupShortsSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  prepareSheet_(sheet);
  formatSheet_(sheet);
  applyShortsValidations_(sheet);
}

function setupNormalVideosSheet_(ss) {
  const headers = [
    'No.', '公開日時', 'タイトル', 'URL', '動画ID', '長さ（分）',
    '再生回数', '高評価数', 'コメント数', 'カテゴリ', 'ステータス',
    'シリーズ・企画', 'サムネ確認', '評価', 'メモ', '最終更新'
  ];

  const sheet = getOrCreateSheet_(ss, '通常動画一覧', headers);
  styleHeader_(sheet, '#00838F');
  setWidths_(sheet, [60,140,360,280,120,100,110,110,110,140,100,180,110,70,260,140]);
  setValidation_(sheet, 10, ['Minecraft', '龍が如く', 'AEW・プロレス', '雑談', 'コラボ', 'その他']);
  setValidation_(sheet, 11, ['公開中', '非公開', '要確認', 'リメイク候補']);
  setValidation_(sheet, 13, ['未確認', '確認済み']);
  setValidation_(sheet, 14, ['S', 'A', 'B', 'C']);
  applyFilter_(sheet, headers.length);
}

function setupLiveSheet_(ss) {
  const headers = [
    'No.', '配信日', 'タイトル', 'URL', '動画ID', '長さ（分）',
    '再生回数', '高評価数', 'ゲーム・カテゴリ', 'コラボ相手', '切り抜き候補数',
    '確認状況', 'メモ', 'Shorts化済み本数', '通常切り抜き化済み本数', '公開化率'
  ];
  let sheet = ss.getSheetByName('ライブ一覧');
  if (!sheet) sheet = ss.insertSheet('ライブ一覧');

  // 旧版には高評価数列がなかったため、既存の手入力列を壊さずに1列追加する。
  const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 12)).getValues()[0];
  if (currentHeaders[6] === '再生回数' && currentHeaders[7] === 'ゲーム・カテゴリ') {
    sheet.insertColumnAfter(7);
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  styleHeaderRange_(sheet.getRange(1, 1, 1, headers.length), '#1565C0');
  setWidths_(sheet, [60,120,360,280,120,100,110,110,150,150,110,110,260,120,150,100]);
  setValidation_(sheet, 12, ['未確認', '確認中', '確認済み', '要確認']);
  applyFilter_(sheet, headers.length);
}

function setupClipSheet_(ss) {
  // 既存列は位置を変えず、連動・分析用の列を右側に追加する。
  // AI順位と長さ（秒）も末尾へ追加し、入力済みデータの列ずれを防ぐ。
  const headers = [
    'No.', '登録日', '元配信', '配信URL', '開始時間', '終了時間',
    '内容・オチ', '種類', '優先度', '編集状況', '担当', '投稿予定日',
    '投稿済URL', 'メモ', '元配信動画ID', 'AI選定理由', '用途', '採用判定',
    '修正開始', '修正終了', 'タイトル案', '見どころ要素',
    '公開後再生数', '公開後高評価数', '登録者獲得', '最終実績更新',
    'AI順位', '長さ（秒）'
  ];
  const sheet = getOrCreateSheet_(ss, '切り抜き候補', headers);
  styleHeaderRange_(sheet.getRange(1, 1, 1, headers.length), '#6A1B9A');
  setWidths_(sheet, [
    60,110,280,260,90,90,360,120,90,110,110,120,260,260,
    125,300,120,110,90,90,300,220,120,130,110,140,80,100
  ]);
  setValidation_(sheet, 8, ['爆笑', '神プレイ', '絶叫', '感動', '情報', 'その他']);
  setValidation_(sheet, 9, ['S', 'A', 'B', 'C']);
  setValidation_(sheet, 10, ['未着手', '編集中', '確認待ち', '完成', '保留']);
  setValidation_(sheet, 17, ['Shorts', '通常切り抜き', '両方']);
  setValidation_(sheet, 18, ['採用', '保留', '不採用']);
  applyFilter_(sheet, headers.length);
  applyClipStartTimeLinks_(sheet, 2, Math.max(sheet.getLastRow() - 1, 0));
}

function setupPostingSheet_(ss) {
  const headers = [
    'No.', '種別', 'ステータス', '投稿予定日', '投稿時間', '日本語タイトル',
    '英語タイトル', '元配信・素材', '担当', 'サムネ・タイトル画像',
    '説明文確認', '公開URL', '公開日', '初動24時間再生', '7日再生',
    '評価', 'メモ'
  ];
  const sheet = getOrCreateSheet_(ss, '投稿管理', headers);
  styleHeader_(sheet, '#EF6C00');
  setWidths_(sheet, [60,90,110,120,90,320,320,260,110,220,110,260,120,120,110,80,260]);
  setValidation_(sheet, 2, ['Shorts', '通常動画', 'ライブ', '告知']);
  setValidation_(sheet, 3, ['企画中', '素材待ち', '編集中', '確認待ち', '予約済み', '公開済み', '保留']);
  setValidation_(sheet, 11, ['未確認', '確認済み']);
  setValidation_(sheet, 16, ['S', 'A', 'B', 'C']);
  applyFilter_(sheet, headers.length);

  const rules = sheet.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('公開済み')
      .setBackground('#C8E6C9')
      .setRanges([sheet.getRange('C2:C1000')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('確認待ち')
      .setBackground('#FFF9C4')
      .setRanges([sheet.getRange('C2:C1000')])
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('保留')
      .setBackground('#EEEEEE')
      .setRanges([sheet.getRange('C2:C1000')])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

function setupIdeaSheet_(ss) {
  const headers = [
    'No.', '登録日', '企画・ネタ', 'カテゴリ', '形式', '優先度',
    '参考URL', '採用状況', 'メモ'
  ];
  const sheet = getOrCreateSheet_(ss, 'ネタ帳', headers);
  styleHeader_(sheet, '#2E7D32');
  setWidths_(sheet, [60,110,360,150,110,90,280,110,300]);
  setValidation_(sheet, 4, ['Minecraft', '龍が如く', 'AEW・プロレス', '雑談', 'コラボ', 'その他']);
  setValidation_(sheet, 5, ['Shorts', '通常動画', 'ライブ', '告知']);
  setValidation_(sheet, 6, ['S', 'A', 'B', 'C']);
  setValidation_(sheet, 8, ['未検討', '検討中', '採用', '見送り']);
  applyFilter_(sheet, headers.length);
}

function setupMasterSheet_(ss) {
  const sheet = getOrCreateSheet_(ss, 'マスタ', ['項目', '値']);
  styleHeader_(sheet, '#455A64');
  setWidths_(sheet, [180,300]);

  if (sheet.getLastRow() < 2) {
    const values = [
      ['チャンネル', 'ShidaHikaru'],
      ['Shorts URL', 'https://www.youtube.com/@ShidaHikaru/shorts'],
      ['管理開始日', new Date()],
      ['運用メモ', '自動取得列は直接変更せず、手入力列を使用してください。']
    ];
    sheet.getRange(2, 1, values.length, 2).setValues(values);
    sheet.getRange('B4').setNumberFormat('yyyy-mm-dd');
  }
}

function setupDashboard_(ss) {
  let sheet = ss.getSheetByName('Dashboard');
  if (!sheet) sheet = ss.insertSheet('Dashboard', 0);

  // 手入力の週次チェックは、ダッシュボード更新後も保持する。
  const weeklyCheckValues = sheet.getRange('D85:M89').getValues().map(row => row[0]);

  // 既存の結合状態をすべて解除してから作り直す
  sheet
    .getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns())
    .breakApart();

  sheet.clear();
  sheet.getCharts().forEach(chart => sheet.removeChart(chart));
  sheet.setHiddenGridlines(true);

  // タイトル
  sheet.getRange('A1:M1').merge()
    .setValue('ShidaTube 運営ダッシュボード')
    .setBackground('#C62828')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(20)
    .setHorizontalAlignment('center');

  // KPI
  sheet.getRange('A3:B3').setValues([['主要KPI', '現在値']]);
  styleHeaderRange_(sheet.getRange('A3:B3'), '#263238');

  const kpis = [
    ['公開Shorts本数', '=COUNTA(\'Shorts一覧\'!E2:E)'],
    ['Shorts総再生数', '=SUM(\'Shorts一覧\'!G2:G)'],
    ['Shorts平均再生数', '=IFERROR(AVERAGE(\'Shorts一覧\'!G2:G),0)'],
    ['通常動画本数', '=COUNTA(\'通常動画一覧\'!E2:E)'],
    ['通常動画総再生数', '=SUM(\'通常動画一覧\'!G2:G)'],
    ['ライブ配信本数', '=COUNTA(\'ライブ一覧\'!E2:E)'],
    [
      '今月のShorts投稿数',
      '=COUNTIFS(\'Shorts一覧\'!B2:B,">="&EOMONTH(TODAY(),-1)+1,\'Shorts一覧\'!B2:B,"<"&EOMONTH(TODAY(),0)+1)'
    ],
    [
      '投稿予定（未公開）',
      '=COUNTIFS(\'投稿管理\'!C2:C,"<>公開済み",\'投稿管理\'!F2:F,"<>")'
    ],
    ['編集中の切り抜き', '=COUNTIF(\'切り抜き候補\'!J2:J,"編集中")'],
    ['S評価の切り抜き候補', '=COUNTIF(\'切り抜き候補\'!I2:I,"S")']
  ];

  sheet.getRange(4, 1, kpis.length, 2).setValues(kpis);
  sheet.getRange('B4:B13').setNumberFormat('#,##0');
  sheet.getRange('A4:B13').setBorder(true, true, true, true, true, true);
  sheet.getRange('A4:A13').setFontWeight('bold').setBackground('#F5F7F8');
  sheet.getRange('B4:B13').setBackground('#FFFFFF').setHorizontalAlignment('right');
  sheet.getRange('A3:B13').setVerticalAlignment('middle');

  // 次にやること
  sheet.getRange('D3:M3').merge()
    .setValue('次にやること')
    .setBackground('#EF6C00')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const nextActions = [
    '投稿管理で「確認待ち」を確認',
    'S評価の切り抜き候補から着手',
    '公開済みShortsの再生数を更新',
    '次週分の投稿予定日を入力',
    'ネタ帳から次企画を選定'
  ];
  nextActions.forEach((action, index) => {
    const row = 4 + index;
    sheet.getRange(row, 4)
      .setValue(index + 1)
      .setBackground('#FFF3E0')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
    sheet.getRange(row, 5, 1, 9).merge()
      .setValue(action)
      .setBackground('#FFFFFF')
      .setWrap(true);
    sheet.getRange(row, 4, 1, 10)
      .setBorder(true, true, true, true, true, true)
      .setVerticalAlignment('middle');
    sheet.setRowHeight(row, 32);
  });

  // 再生数 TOP10（サムネイル・YouTubeリンク付き）
  sheet.getRange('A14:F14').merge()
    .setValue('Shorts 再生数 TOP10')
    .setBackground('#1565C0')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange('A15:F15').setValues([['順位', 'サムネイル', 'タイトル', '投稿日', '再生回数', '高評価数']]);
  styleHeaderRange_(sheet.getRange('A15:F15'), '#263238');
  writeDashboardTop10_(sheet, 'Shorts一覧', 16, 1);

  sheet.getRange('A27:F27').merge()
    .setValue('通常動画 再生数 TOP10')
    .setBackground('#00838F')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange('A28:F28').setValues([['順位', 'サムネイル', 'タイトル', '投稿日', '再生回数', '高評価数']]);
  styleHeaderRange_(sheet.getRange('A28:F28'), '#263238');
  writeDashboardTop10_(sheet, '通常動画一覧', 29, 1);

  sheet.getRange('H27:M27').merge()
    .setValue('ライブ配信 再生数 TOP10')
    .setBackground('#1565C0')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  sheet.getRange('H28:M28').setValues([['順位', 'サムネイル', 'タイトル', '投稿日', '再生回数', '高評価数']]);
  styleHeaderRange_(sheet.getRange('H28:M28'), '#263238');
  writeDashboardTop10_(sheet, 'ライブ一覧', 29, 8);

  // カテゴリ別平均再生数
  sheet.getRange('H14:M14').merge()
    .setValue('カテゴリ別平均再生数')
    .setBackground('#6A1B9A')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.getRange('H15:K15').merge().setValue('カテゴリ');
  sheet.getRange('L15:M15').merge().setValue('平均再生数');
  styleHeaderRange_(sheet.getRange('H15:M15'), '#263238');

  const cats = [
    ['Minecraft'],
    ['龍が如く'],
    ['AEW・プロレス'],
    ['雑談'],
    ['その他']
  ];

  cats.forEach((category, index) => {
    const row = 16 + index;
    sheet.getRange(row, 8, 1, 4).merge().setValue(category[0]);
    sheet.getRange(row, 12, 1, 2).merge();
  });

  for (let row = 16; row <= 20; row++) {
    sheet.getRange(row, 12).setFormula(
      `=IFERROR(AVERAGEIF('Shorts一覧'!J:J,H${row},'Shorts一覧'!G:G),0)`
    );
  }

  sheet.getRange('L16:L20').setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange('H16:M20')
    .setBorder(true, true, true, true, true, true)
    .setVerticalAlignment('middle');
  sheet.getRange('H16:K20').setBackground('#F7F3FA').setFontWeight('bold');

  // 最近の傾向：直近90日以内に公開された動画を、公開後1日平均再生数で比較
  sheet.getRange('A41:I41').merge()
    .setValue('最近の傾向（直近90日公開・1日平均再生数 TOP10）')
    .setBackground('#AD1457')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(14)
    .setHorizontalAlignment('center');
  sheet.getRange('A42:I42').merge()
    .setValue('注：過去90日間に増えた再生数ではなく、直近90日以内に公開された動画の累計値を公開後日数で割った比較です。')
    .setBackground('#FCE4EC')
    .setFontColor('#880E4F')
    .setWrap(true);

  writeRecentTop10Section_(sheet, 'Shorts一覧', 'Shorts 最近の勢い TOP10', 44, '#C62828');
  writeRecentTop10Section_(sheet, '通常動画一覧', '通常動画 最近の勢い TOP10', 57, '#00838F');
  writeRecentTop10Section_(sheet, 'ライブ一覧', 'ライブ配信 最近の勢い TOP10', 70, '#1565C0');

  // 今週の運営チェック（手入力内容は次回更新時も保持）
  sheet.getRange('A83:M83').merge()
    .setValue('今週の運営チェック')
    .setBackground('#2E7D32')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(14)
    .setHorizontalAlignment('center');

  const weeklyCheckLabels = [
    '今週伸びた動画',
    '伸びた理由',
    '次に作るShorts',
    '次に作る通常動画',
    '公開予定日'
  ];

  weeklyCheckLabels.forEach((label, index) => {
    const row = 85 + index;
    sheet.getRange(row, 1, 1, 3).merge()
      .setValue(label)
      .setBackground('#E8F5E9')
      .setFontWeight('bold')
      .setVerticalAlignment('middle');
    sheet.getRange(row, 4, 1, 10).merge()
      .setValue(weeklyCheckValues[index] || '')
      .setBackground('#FFFFFF')
      .setWrap(true)
      .setVerticalAlignment('middle');
    sheet.getRange(row, 1, 1, 13)
      .setBorder(true, true, true, true, true, true);
    sheet.setRowHeight(row, row === 86 ? 56 : 40);
  });
  sheet.getRange('D89').setNumberFormat('yyyy-mm-dd');

  setWidths_(sheet, [60, 130, 300, 105, 110, 100, 90, 120, 90, 300, 105, 110, 100]);
  sheet.setFrozenRows(1);
}


function writeDashboardTop10_(dashboard, sourceSheetName, startRow, startColumn) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const source = ss.getSheetByName(sourceSheetName);
  const outputRange = dashboard.getRange(startRow, startColumn, 10, 6);
  outputRange.clearContent();

  if (!source || source.getLastRow() < 2) return;

  // B:H = 投稿日、タイトル、URL、動画ID、長さ、再生回数、高評価数
  const rows = source.getRange(2, 2, source.getLastRow() - 1, 7)
    .getValues()
    .filter(row => row[1] && row[3])
    .sort((a, b) => Number(b[5] || 0) - Number(a[5] || 0))
    .slice(0, 10);

  rows.forEach((row, index) => {
    const targetRow = startRow + index;
    const publishedAt = row[0];
    const title = String(row[1] || '');
    const url = String(row[2] || '');
    const videoId = String(row[3] || '');
    const viewCount = Number(row[5] || 0);
    const likeCount = Number(row[6] || 0);

    dashboard.getRange(targetRow, startColumn).setValue(index + 1);
    dashboard.getRange(targetRow, startColumn + 1).setFormula(
      '=IFERROR(IMAGE("https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg",4,68,120),"")'
    );

    const titleCell = dashboard.getRange(targetRow, startColumn + 2);
    if (url) {
      titleCell.setRichTextValue(
        SpreadsheetApp.newRichTextValue().setText(title).setLinkUrl(url).build()
      );
    } else {
      titleCell.setValue(title);
    }

    dashboard.getRange(targetRow, startColumn + 3, 1, 3)
      .setValues([[publishedAt, viewCount, likeCount]]);
    dashboard.setRowHeight(targetRow, 75);
  });

  dashboard.getRange(startRow, startColumn + 3, 10, 1).setNumberFormat('yyyy-mm-dd');
  dashboard.getRange(startRow, startColumn + 4, 10, 2).setNumberFormat('#,##0');
  outputRange
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(true, true, true, true, true, true);
}

function writeRecentTop10Section_(dashboard, sourceSheetName, title, titleRow, color) {
  dashboard.getRange(titleRow, 1, 1, 9).merge()
    .setValue(title)
    .setBackground(color)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const headerRow = titleRow + 1;
  const startRow = titleRow + 2;
  dashboard.getRange(headerRow, 1, 1, 9).setValues([[
    '順位', 'サムネイル', 'タイトル', '投稿日', '再生回数',
    '高評価数', '公開後日数', '1日平均再生数', '高評価率'
  ]]);
  styleHeaderRange_(dashboard.getRange(headerRow, 1, 1, 9), '#263238');

  const outputRange = dashboard.getRange(startRow, 1, 10, 9);
  outputRange.clearContent();

  const source = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sourceSheetName);
  if (!source || source.getLastRow() < 2) return;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 90);

  // B:H = 投稿日、タイトル、URL、動画ID、長さ、再生回数、高評価数
  const rows = source.getRange(2, 2, source.getLastRow() - 1, 7)
    .getValues()
    .map(row => {
      const publishedAt = row[0] instanceof Date ? row[0] : new Date(row[0]);
      if (isNaN(publishedAt.getTime()) || publishedAt < cutoff || publishedAt > now) return null;
      const publishedDate = new Date(
        publishedAt.getFullYear(), publishedAt.getMonth(), publishedAt.getDate()
      );
      const daysSincePublished = Math.max(
        1,
        Math.floor((today.getTime() - publishedDate.getTime()) / 86400000) + 1
      );
      const viewCount = Number(row[5] || 0);
      const likeCount = Number(row[6] || 0);
      return {
        publishedAt: publishedAt,
        title: String(row[1] || ''),
        url: String(row[2] || ''),
        videoId: String(row[3] || ''),
        viewCount: viewCount,
        likeCount: likeCount,
        days: daysSincePublished,
        viewsPerDay: viewCount / daysSincePublished,
        likeRate: viewCount > 0 ? likeCount / viewCount : 0
      };
    })
    .filter(item => item && item.title && item.videoId)
    .sort((a, b) => b.viewsPerDay - a.viewsPerDay)
    .slice(0, 10);

  rows.forEach((item, index) => {
    const targetRow = startRow + index;
    dashboard.getRange(targetRow, 1).setValue(index + 1);
    dashboard.getRange(targetRow, 2).setFormula(
      '=IFERROR(IMAGE("https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg",4,68,120),"")'
    );

    const titleCell = dashboard.getRange(targetRow, 3);
    if (item.url) {
      titleCell.setRichTextValue(
        SpreadsheetApp.newRichTextValue()
          .setText(item.title)
          .setLinkUrl(item.url)
          .build()
      );
    } else {
      titleCell.setValue(item.title);
    }

    dashboard.getRange(targetRow, 4, 1, 6).setValues([[
      item.publishedAt,
      item.viewCount,
      item.likeCount,
      item.days,
      item.viewsPerDay,
      item.likeRate
    ]]);
    dashboard.setRowHeight(targetRow, 75);
  });

  dashboard.getRange(startRow, 4, 10, 1).setNumberFormat('yyyy-mm-dd');
  dashboard.getRange(startRow, 5, 10, 3).setNumberFormat('#,##0');
  dashboard.getRange(startRow, 8, 10, 1).setNumberFormat('#,##0.0');
  dashboard.getRange(startRow, 9, 10, 1).setNumberFormat('0.0%');
  outputRange
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(true, true, true, true, true, true);
}


const ANALYTICS_VIDEO_SHEET = 'Analytics_動画別';
const ANALYTICS_DAILY_SHEET = 'Analytics_日別';
const ANALYTICS_TREND_SHEET = 'Analytics_上位動画推移';

function setupAnalyticsSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupAnalyticsSheets_(ss);
  SpreadsheetApp.getUi().alert(
    'CSV貼り付け用の3シートを準備しました。\n' +
    '各CSVを、対応するシートのA1セルから貼り付けてください。'
  );
}

function setupAnalyticsSheets_(ss) {
  const definitions = [
    {
      name: ANALYTICS_VIDEO_SHEET,
      color: '#AD1457',
      headers: [
        'コンテンツ', '動画のタイトル', '動画公開時刻', '長さ', '視聴回数',
        '総再生時間（単位: 時間）', 'チャンネル登録者', '推定収益 (JPY)',
        'インプレッション数', 'インプレッションのクリック率 (%)'
      ],
      widths: [130, 420, 150, 90, 110, 160, 120, 130, 130, 180]
    },
    {
      name: ANALYTICS_DAILY_SHEET,
      color: '#6A1B9A',
      headers: ['日付', '視聴回数'],
      widths: [140, 120]
    },
    {
      name: ANALYTICS_TREND_SHEET,
      color: '#1565C0',
      headers: ['日付', 'コンテンツ', '動画のタイトル', '動画公開時刻', '長さ', '視聴回数'],
      widths: [140, 130, 420, 150, 90, 110]
    }
  ];

  definitions.forEach(def => {
    let sheet = ss.getSheetByName(def.name);
    if (!sheet) sheet = ss.insertSheet(def.name);
    if (sheet.getLastRow() === 0 || sheet.getRange(1, 1).getValue() === '') {
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    }
    styleHeaderRange_(sheet.getRange(1, 1, 1, def.headers.length), def.color);
    setWidths_(sheet, def.widths);
    sheet.setFrozenRows(1);
  });
}

function refreshAnalyticsDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupAnalyticsSheets_(ss);
  setupAnalyticsDashboard_(ss);
  ss.setActiveSheet(ss.getSheetByName('Analytics Dashboard'));
  SpreadsheetApp.getUi().alert('90日分析を更新しました。');
}

/** Driveフォルダ内のYouTube Studio分析ZIPから最新8種類を取り込む。 */
function importAnalyticsZips() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  try {
    setupZipAnalyticsSheets_(ss);
    const files = findLatestAnalyticsZipFiles_();
    const imported = [];
    const missing = [];

    ZIP_ANALYTICS_CONFIG.forEach(config => {
      const fileInfo = files[config.key];
      if (!fileInfo) {
        missing.push(config.key);
        return;
      }
      const table = extractAnalyticsZipTable_(fileInfo.file);
      writeZipAnalyticsSheet_(
        ss.getSheetByName(ZIP_ANALYTICS_SHEET_PREFIX + config.key),
        config,
        fileInfo,
        table
      );
      imported.push(config.key);
    });

    setupAnalyticsDashboard_(ss);
    ss.setActiveSheet(ss.getSheetByName('Analytics Dashboard'));
    let message = imported.length + '種類の分析データを取り込みました。';
    if (missing.length) message += '\n未検出: ' + missing.join('、');
    ui.alert(message);
  } catch (error) {
    ui.alert('分析ZIPの取り込みに失敗しました。\n' + String(error && error.message ? error.message : error));
    throw error;
  }
}

function setupZipAnalyticsSheets_(ss) {
  ZIP_ANALYTICS_CONFIG.forEach(config => {
    const name = ZIP_ANALYTICS_SHEET_PREFIX + config.key;
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.setFrozenRows(6);
    sheet.setTabColor('#546E7A');
  });
}

function findLatestAnalyticsZipFiles_() {
  const folder = DriveApp.getFolderById(ANALYTICS_FOLDER_ID);
  const iterator = folder.getFiles();
  const latest = {};

  while (iterator.hasNext()) {
    const file = iterator.next();
    const name = file.getName();
    if (!/\.zip$/i.test(name)) continue;
    const config = ZIP_ANALYTICS_CONFIG.find(item =>
      name.indexOf(item.key + ' ') === 0 || name.indexOf(item.key + '_') === 0
    );
    if (!config) continue;
    const period = parseAnalyticsZipPeriod_(name);
    const rank = (period.end || '') + '|' + Utilities.formatDate(file.getLastUpdated(), 'UTC', 'yyyyMMddHHmmss');
    if (!latest[config.key] || rank > latest[config.key].rank) {
      latest[config.key] = { file: file, name: name, start: period.start, end: period.end, rank: rank };
    }
  }
  return latest;
}

function parseAnalyticsZipPeriod_(fileName) {
  const match = fileName.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  return match ? { start: match[1], end: match[2] } : { start: '', end: '' };
}

function extractAnalyticsZipTable_(file) {
  const blobs = Utilities.unzip(file.getBlob());
  const tableBlob = blobs.find(blob => /(^|\/)表データ\.csv$/.test(blob.getName()));
  if (!tableBlob) throw new Error(file.getName() + ' に「表データ.csv」がありません。');
  const csv = tableBlob.getDataAsString('UTF-8').replace(/^\uFEFF/, '');
  const values = Utilities.parseCsv(csv);
  if (!values.length || !values[0].length) throw new Error(file.getName() + ' の「表データ.csv」が空です。');
  return values;
}

function writeZipAnalyticsSheet_(sheet, config, fileInfo, table) {
  sheet.clear();
  sheet.getCharts().forEach(chart => sheet.removeChart(chart));
  sheet.getRange('A1:D1').merge().setValue(config.title)
    .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(14);
  sheet.getRange('A2:B4').setValues([
    ['対象期間', fileInfo.start && fileInfo.end ? fileInfo.start + ' ～ ' + fileInfo.end : 'ファイル名から取得できず'],
    ['取込元', fileInfo.name],
    ['取込日時', new Date()]
  ]);
  sheet.getRange('A2:A4').setFontWeight('bold').setBackground('#ECEFF1');
  sheet.getRange('B4').setNumberFormat('yyyy-mm-dd hh:mm');
  const width = Math.max.apply(null, table.map(row => row.length));
  const normalized = table.map(row => row.concat(new Array(width - row.length).fill('')));
  sheet.getRange(6, 1, normalized.length, width).setValues(normalized);
  styleHeaderRange_(sheet.getRange(6, 1, 1, width), '#546E7A');
  if (normalized.length > 1 && width > 1) {
    sheet.getRange(7, 2, normalized.length - 1, width - 1).setNumberFormat('#,##0.00');
  }
  sheet.autoResizeColumns(1, width);
  sheet.setColumnWidth(1, Math.max(sheet.getColumnWidth(1), 180));
  sheet.setFrozenRows(6);
}

function setupAnalyticsDashboard_(ss) {
  let dashboard = ss.getSheetByName('Analytics Dashboard');
  if (!dashboard) dashboard = ss.insertSheet('Analytics Dashboard', 1);

  dashboard.getRange(1, 1, dashboard.getMaxRows(), dashboard.getMaxColumns()).breakApart();
  dashboard.clear();
  dashboard.getCharts().forEach(chart => dashboard.removeChart(chart));
  dashboard.setHiddenGridlines(true);

  dashboard.getRange('A1:J1').merge()
    .setValue('ShidaTube 90日アナリティクス')
    .setBackground('#AD1457')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(20)
    .setHorizontalAlignment('center');

  dashboard.getRange('A2:J2').merge()
    .setValue('YouTube StudioのCSVを貼り付け、「ShidaTube管理」→「90日分析を更新」で再集計します。')
    .setBackground('#FCE4EC')
    .setFontColor('#880E4F')
    .setWrap(true);

  const videoSheet = ss.getSheetByName(ANALYTICS_VIDEO_SHEET);
  const analyticsRows = readAnalyticsVideoRows_(videoSheet);
  const typeByVideoId = buildVideoTypeMap_(ss);
  const items = analyticsRows
    .filter(row => row.videoId && row.title)
    .map(row => {
      row.type = typeByVideoId[row.videoId] || '未分類';
      row.url = 'https://www.youtube.com/watch?v=' + row.videoId;
      row.avgViewSeconds = row.views > 0 ? row.watchHours * 3600 / row.views : 0;
      row.subsPerThousand = row.views > 0 ? row.subscribers * 1000 / row.views : 0;
      row.rpm = row.views > 0 ? row.revenue * 1000 / row.views : 0;
      return row;
    });

  const total = items.reduce((sum, item) => {
    sum.views += item.views;
    sum.watchHours += item.watchHours;
    sum.subscribers += item.subscribers;
    sum.revenue += item.revenue;
    sum.impressions += item.impressions;
    sum.ctrWeighted += item.impressions * item.ctr;
    return sum;
  }, { views: 0, watchHours: 0, subscribers: 0, revenue: 0, impressions: 0, ctrWeighted: 0 });

  const period = getAnalyticsPeriod_(ss.getSheetByName(ANALYTICS_DAILY_SHEET));
  const periodLabel = period.start && period.end
    ? Utilities.formatDate(period.start, Session.getScriptTimeZone(), 'yyyy-MM-dd') + ' ～ ' +
      Utilities.formatDate(period.end, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : 'CSVの日付を確認してください';

  dashboard.getRange('A4:B4').setValues([['集計期間', periodLabel]]);
  dashboard.getRange('A5:B10').setValues([
    ['対象動画数', items.length],
    ['視聴回数', total.views],
    ['総再生時間（時間）', total.watchHours],
    ['登録者獲得', total.subscribers],
    ['推定収益（JPY）', total.revenue],
    ['加重平均CTR', total.impressions > 0 ? total.ctrWeighted / total.impressions / 100 : 0]
  ]);
  styleHeaderRange_(dashboard.getRange('A4:A10'), '#455A64');
  dashboard.getRange('A4:B10').setBorder(true, true, true, true, true, true);
  dashboard.getRange('B5:B8').setNumberFormat('#,##0');
  dashboard.getRange('B9').setNumberFormat('¥#,##0');
  dashboard.getRange('B10').setNumberFormat('0.00%');

  writeAnalyticsTypeSummary_(dashboard, items, 4, 4);
  writeAnalyticsRanking_(dashboard, items, '直近90日 再生数 TOP10', 13, 'views', '#C62828');
  writeAnalyticsRanking_(dashboard, items, '登録者獲得 TOP10', 26, 'subscribers', '#2E7D32');
  writeAnalyticsRanking_(dashboard, items, '総再生時間 TOP10', 39, 'watchHours', '#1565C0');
  writeAnalyticsDailyChart_(dashboard, ss.getSheetByName(ANALYTICS_DAILY_SHEET), 53);
  renderZipAnalyticsDashboard_(ss, dashboard);

  setWidths_(dashboard, [60, 130, 330, 100, 110, 110, 105, 115, 105, 110]);
  dashboard.setFrozenRows(2);
}

function renderZipAnalyticsDashboard_(ss, dashboard) {
  const startRow = 76;
  dashboard.getRange(startRow, 1, 1, 9).merge()
    .setValue('YouTube Studio 詳細分析')
    .setBackground('#37474F').setFontColor('#FFFFFF').setFontWeight('bold')
    .setFontSize(12).setHorizontalAlignment('center');
  dashboard.setRowHeight(startRow, 24);

  const period = getZipAnalyticsPeriod_(ss);
  dashboard.getRange(startRow + 1, 1, 1, 9).merge()
    .setValue(period ? '対象期間: ' + period : '「YouTube分析ZIPを取り込む」を実行してください')
    .setBackground('#ECEFF1').setFontColor('#455A64')
    .setFontSize(9).setHorizontalAlignment('center');
  dashboard.setRowHeight(startRow + 1, 20);

  // 既存ダッシュボードの中央幅に合わせ、左右2列のカードとして配置する。
  // 各カードは4列幅（項目名3列＋数値1列）とし、長い項目名も読みやすくする。
  renderZipAnalyticsBlock_(ss, dashboard, 'チャンネル登録状況', 79, 1, 4);
  renderZipAnalyticsBlock_(ss, dashboard, 'チャンネル登録元', 79, 6, 6);
  renderZipAnalyticsBlock_(ss, dashboard, 'デバイスのタイプ', 88, 1, 6);
  renderZipAnalyticsBlock_(ss, dashboard, '視聴者の性別', 88, 6, 4);
  renderZipAnalyticsBlock_(ss, dashboard, '地域', 97, 1, 10);
  renderZipAnalyticsBlock_(ss, dashboard, '字幕', 97, 6, 8);
  renderZipAnalyticsBlock_(ss, dashboard, '翻訳版の使用', 110, 1, 5);
  renderZipAnalyticsBlock_(ss, dashboard, '終了画面要素', 110, 6, 8);

  // E列をカード間の余白として固定し、追加分析部分だけが横に間延びしないようにする。
  dashboard.setColumnWidth(5, 28);
}

function getZipAnalyticsPeriod_(ss) {
  for (let i = 0; i < ZIP_ANALYTICS_CONFIG.length; i++) {
    const source = ss.getSheetByName(ZIP_ANALYTICS_SHEET_PREFIX + ZIP_ANALYTICS_CONFIG[i].key);
    if (source && source.getRange('B2').getDisplayValue()) return source.getRange('B2').getDisplayValue();
  }
  return '';
}

function renderZipAnalyticsBlock_(ss, dashboard, key, row, column, maxRows) {
  const config = ZIP_ANALYTICS_CONFIG.find(item => item.key === key);
  const cardWidth = 4;
  const labelWidth = 3;
  dashboard.getRange(row, column, 1, cardWidth).merge().setValue(config ? config.title : key)
    .setBackground('#455A64').setFontColor('#FFFFFF').setFontWeight('bold')
    .setFontSize(11).setHorizontalAlignment('left').setVerticalAlignment('middle');
  dashboard.setRowHeight(row, 25);

  const source = ss.getSheetByName(ZIP_ANALYTICS_SHEET_PREFIX + key);
  if (!source || source.getLastRow() < 7) {
    dashboard.getRange(row + 1, column, 1, cardWidth).merge().setValue('データ未取込')
      .setBackground('#FAFAFA').setFontColor('#78909C').setHorizontalAlignment('center')
      .setBorder(true, true, true, true, false, false, '#CFD8DC', SpreadsheetApp.BorderStyle.SOLID);
    return;
  }

  const values = source.getRange(6, 1, source.getLastRow() - 5, source.getLastColumn()).getDisplayValues();
  const header = values[0] || [];
  const body = values.slice(1).filter(item => item[0] && item[0] !== '合計').slice(0, maxRows);
  const headerLabel = dashboard.getRange(row + 1, column, 1, labelWidth).merge();
  const headerValue = dashboard.getRange(row + 1, column + labelWidth);
  headerLabel.setValue(header[0] || key);
  headerValue.setValue(header[1] || '値');
  styleHeaderRange_(dashboard.getRange(row + 1, column, 1, cardWidth), '#90A4AE');
  dashboard.getRange(row + 1, column, 1, cardWidth).setFontSize(9);
  dashboard.setRowHeight(row + 1, 20);

  const outputRows = [];
  if (key === '終了画面要素') {
    const total = values.slice(1).find(item => item[0] === '合計');
    if (total) {
      outputRows.push.apply(outputRows, [
        ['表示回数', total[1] || '0'],
        ['クリック数', total[2] || '0'],
        ['クリック率', (total[3] || '0') + '%']
      ]);
    }
  } else if (body.length) {
    body.forEach(item => outputRows.push([item[0], item[1]]));
  }

  outputRows.forEach((item, index) => {
    const outputRow = row + 2 + index;
    dashboard.getRange(outputRow, column, 1, labelWidth).merge().setValue(item[0]);
    dashboard.getRange(outputRow, column + labelWidth).setValue(item[1]).setHorizontalAlignment('right');
  });

  const displayedRows = Math.max(outputRows.length + 1, 2);
  dashboard.getRange(row + 1, column, displayedRows, cardWidth)
    .setBorder(true, true, true, true, true, true, '#B0BEC5', SpreadsheetApp.BorderStyle.SOLID)
    .setFontSize(9).setVerticalAlignment('middle').setWrap(true);

  for (let offset = 1; offset <= displayedRows; offset++) {
    dashboard.setRowHeight(row + offset, offset === 1 ? 20 : 23);
    if (offset > 1 && offset % 2 === 1) {
      dashboard.getRange(row + offset, column, 1, cardWidth).setBackground('#F5F7F8');
    }
  }
}

function readAnalyticsVideoRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues()
    .filter(row => String(row[0] || '').trim() && String(row[0] || '').trim() !== '合計')
    .map(row => ({
      videoId: String(row[0] || '').trim(),
      title: String(row[1] || ''),
      publishedAt: parseAnalyticsDate_(row[2]),
      durationSeconds: toNumber_(row[3]),
      views: toNumber_(row[4]),
      watchHours: toNumber_(row[5]),
      subscribers: toNumber_(row[6]),
      revenue: toNumber_(row[7]),
      impressions: toNumber_(row[8]),
      ctr: toNumber_(row[9])
    }));
}

function buildVideoTypeMap_(ss) {
  const map = {};
  [
    ['Shorts一覧', 'Shorts'],
    ['通常動画一覧', '通常動画'],
    ['ライブ一覧', 'ライブ配信']
  ].forEach(pair => {
    const sheet = ss.getSheetByName(pair[0]);
    if (!sheet || sheet.getLastRow() < 2) return;
    sheet.getRange(2, 5, sheet.getLastRow() - 1, 1).getValues().forEach(row => {
      const id = String(row[0] || '').trim();
      if (id) map[id] = pair[1];
    });
  });
  return map;
}

function writeAnalyticsTypeSummary_(dashboard, items, startRow, startColumn) {
  const headers = [
    '種類', '動画数', '再生回数', '総再生時間', '登録者',
    '登録者/千再生', '平均視聴時間', '推定収益', 'RPM', '加重平均CTR'
  ];
  dashboard.getRange(startRow, startColumn, 1, headers.length).setValues([headers]);
  styleHeaderRange_(dashboard.getRange(startRow, startColumn, 1, headers.length), '#263238');

  const types = ['Shorts', '通常動画', 'ライブ配信', '未分類'];
  const rows = types.map(type => {
    const selected = items.filter(item => item.type === type);
    const totals = selected.reduce((sum, item) => {
      sum.views += item.views;
      sum.watchHours += item.watchHours;
      sum.subscribers += item.subscribers;
      sum.revenue += item.revenue;
      sum.impressions += item.impressions;
      sum.ctrWeighted += item.impressions * item.ctr;
      return sum;
    }, { views: 0, watchHours: 0, subscribers: 0, revenue: 0, impressions: 0, ctrWeighted: 0 });
    return [
      type,
      selected.length,
      totals.views,
      totals.watchHours,
      totals.subscribers,
      totals.views > 0 ? totals.subscribers * 1000 / totals.views : 0,
      totals.views > 0 ? totals.watchHours * 3600 / totals.views : 0,
      totals.revenue,
      totals.views > 0 ? totals.revenue * 1000 / totals.views : 0,
      totals.impressions > 0 ? totals.ctrWeighted / totals.impressions / 100 : 0
    ];
  });

  dashboard.getRange(startRow + 1, startColumn, rows.length, headers.length).setValues(rows)
    .setBorder(true, true, true, true, true, true);
  dashboard.getRange(startRow + 1, startColumn + 1, rows.length, 5).setNumberFormat('#,##0.0');
  dashboard.getRange(startRow + 1, startColumn + 6, rows.length, 1).setNumberFormat('0.0"秒"');
  dashboard.getRange(startRow + 1, startColumn + 7, rows.length, 2).setNumberFormat('¥#,##0.00');
  dashboard.getRange(startRow + 1, startColumn + 9, rows.length, 1).setNumberFormat('0.00%');
}

function writeAnalyticsRanking_(dashboard, items, title, titleRow, sortKey, color) {
  dashboard.getRange(titleRow, 1, 1, 10).merge()
    .setValue(title)
    .setBackground(color)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  const headerRow = titleRow + 1;
  const startRow = titleRow + 2;
  dashboard.getRange(headerRow, 1, 1, 10).setValues([[
    '順位', 'サムネイル', 'タイトル', '種類', '視聴回数',
    '総再生時間', '登録者', '登録者/千再生', 'CTR', '平均視聴時間'
  ]]);
  styleHeaderRange_(dashboard.getRange(headerRow, 1, 1, 10), '#263238');

  const rows = items.slice()
    .sort((a, b) => Number(b[sortKey] || 0) - Number(a[sortKey] || 0))
    .slice(0, 10);

  const output = dashboard.getRange(startRow, 1, 10, 10);
  output.clearContent();

  rows.forEach((item, index) => {
    const row = startRow + index;
    dashboard.getRange(row, 1).setValue(index + 1);
    dashboard.getRange(row, 2).setFormula(
      '=IFERROR(IMAGE("https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg",4,68,120),"")'
    );
    dashboard.getRange(row, 3).setRichTextValue(
      SpreadsheetApp.newRichTextValue().setText(item.title).setLinkUrl(item.url).build()
    );
    dashboard.getRange(row, 4, 1, 7).setValues([[
      item.type, item.views, item.watchHours, item.subscribers,
      item.subsPerThousand, item.ctr / 100, item.avgViewSeconds
    ]]);
    dashboard.setRowHeight(row, 75);
  });

  dashboard.getRange(startRow, 5, 10, 3).setNumberFormat('#,##0.0');
  dashboard.getRange(startRow, 8, 10, 1).setNumberFormat('0.00');
  dashboard.getRange(startRow, 9, 10, 1).setNumberFormat('0.00%');
  dashboard.getRange(startRow, 10, 10, 1).setNumberFormat('0.0"秒"');
  output.setVerticalAlignment('middle').setWrap(true)
    .setBorder(true, true, true, true, true, true);
}

function writeAnalyticsDailyChart_(dashboard, dailySheet, titleRow) {
  dashboard.getRange(titleRow, 1, 1, 10).merge()
    .setValue('チャンネル全体 日別再生数')
    .setBackground('#6A1B9A')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  if (!dailySheet || dailySheet.getLastRow() < 2) {
    dashboard.getRange(titleRow + 1, 1).setValue('Analytics_日別シートに合計.csvを貼り付けてください。');
    return;
  }

  const chart = dashboard.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(dailySheet.getRange(1, 1, dailySheet.getLastRow(), 2))
    .setPosition(titleRow + 1, 1, 0, 0)
    .setOption('title', '日別再生数の推移')
    .setOption('legend', { position: 'none' })
    .setOption('width', 900)
    .setOption('height', 360)
    .build();
  dashboard.insertChart(chart);
}

function getAnalyticsPeriod_(dailySheet) {
  if (!dailySheet || dailySheet.getLastRow() < 2) return { start: null, end: null };
  const dates = dailySheet.getRange(2, 1, dailySheet.getLastRow() - 1, 1).getValues()
    .map(row => parseAnalyticsDate_(row[0]))
    .filter(date => date && !isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return {
    start: dates.length ? dates[0] : null,
    end: dates.length ? dates[dates.length - 1] : null
  };
}

function parseAnalyticsDate_(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function toNumber_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const number = Number(String(value || '').replace(/,/g, '').replace(/%/g, '').trim());
  return isFinite(number) ? number : 0;
}

function refreshDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupDashboard_(ss);
  setupAnalyticsSheets_(ss);
  setupAnalyticsDashboard_(ss);
}

function addPostingRow() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿管理');
  const row = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(row, 1).setValue(row - 1);
  sheet.getRange(row, 3).setValue('企画中');
  sheet.getRange(row, 4).setValue(new Date());
  sheet.getRange(row, 4).setNumberFormat('yyyy-mm-dd');
  sheet.activate();
  sheet.setActiveRange(sheet.getRange(row, 6));
}

function addClipRow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupClipSheet_(ss);
  const sheet = ss.getSheetByName('切り抜き候補');
  const row = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(row, 1).setValue(row - 1);
  sheet.getRange(row, 2).setValue(new Date()).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, 9).setValue('A');
  sheet.getRange(row, 10).setValue('未着手');
  sheet.getRange(row, 18).setValue('保留');
  sheet.activate();
  sheet.setActiveRange(sheet.getRange(row, 3));
}

function addClipFromSelectedLive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const active = ss.getActiveSheet();
  const rowNumber = active.getActiveRange().getRow();
  if (active.getName() !== 'ライブ一覧' || rowNumber < 2) {
    SpreadsheetApp.getUi().alert('ライブ一覧で、候補を作りたい配信の行を選択してください。');
    return;
  }

  setupClipSheet_(ss);
  const live = active.getRange(rowNumber, 1, 1, 16).getValues()[0];
  const sheet = ss.getSheetByName('切り抜き候補');
  const row = Math.max(sheet.getLastRow() + 1, 2);
  const values = new Array(28).fill('');
  values[0] = row - 1;
  values[1] = new Date();
  values[2] = live[2];
  values[3] = live[3];
  values[8] = 'A';
  values[9] = '未着手';
  values[14] = live[4];
  values[17] = '保留';
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
  sheet.getRange(row, 2).setNumberFormat('yyyy-mm-dd');
  sheet.activate();
  sheet.setActiveRange(sheet.getRange(row, 5));
  refreshClipManagement_();
}

function refreshClipManagement() {
  const result = refreshClipManagement_();
  SpreadsheetApp.getUi().alert(
    '切り抜き管理を更新しました。候補 ' + result.clipCount + '件、ライブ ' + result.liveCount + '件。'
  );
}

function refreshClipManagement_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  setupClipSheet_(ss);
  setupLiveSheet_(ss);

  const clipSheet = ss.getSheetByName('切り抜き候補');
  const liveSheet = ss.getSheetByName('ライブ一覧');
  const liveByUrl = {};
  const liveByTitle = {};
  const liveRows = liveSheet.getLastRow() >= 2
    ? liveSheet.getRange(2, 1, liveSheet.getLastRow() - 1, 16).getValues()
    : [];

  liveRows.forEach(row => {
    const item = { title: String(row[2] || ''), url: String(row[3] || ''), videoId: String(row[4] || '') };
    if (item.url) liveByUrl[item.url] = item;
    if (item.title) liveByTitle[item.title] = item;
  });

  const performance = buildPublishedPerformanceMap_(ss);
  const clipLastRow = clipSheet.getLastRow();
  const clipRows = clipLastRow >= 2
    ? clipSheet.getRange(2, 1, clipLastRow - 1, 28).getValues()
    : [];
  const summary = {};

  clipRows.forEach((row, index) => {
    let sourceId = String(row[14] || '').trim();
    const sourceUrl = String(row[3] || '').trim();
    const sourceTitle = String(row[2] || '').trim();
    const matched = liveByUrl[sourceUrl] || liveByTitle[sourceTitle];
    if (!sourceId && matched) sourceId = matched.videoId;

    const publishedUrl = String(row[12] || '').trim();
    const publishedId = extractYouTubeVideoId_(publishedUrl);
    const stats = publishedId && performance[publishedId] ? performance[publishedId] : null;
    const outputRow = index + 2;

    clipSheet.getRange(outputRow, 15).setValue(sourceId);
    clipSheet.getRange(outputRow, 23, 1, 4).setValues([[
      stats ? stats.views : '',
      stats ? stats.likes : '',
      stats ? stats.subscribers : '',
      stats ? new Date() : ''
    ]]);
    if (stats) clipSheet.getRange(outputRow, 26).setNumberFormat('yyyy-mm-dd hh:mm');

    if (!sourceId) return;
    if (!summary[sourceId]) summary[sourceId] = { total: 0, shorts: 0, normal: 0, published: 0 };
    summary[sourceId].total++;
    if (publishedUrl) {
      summary[sourceId].published++;
      const usage = String(row[16] || '');
      if (usage === 'Shorts' || usage === '両方') summary[sourceId].shorts++;
      if (usage === '通常切り抜き' || usage === '両方') summary[sourceId].normal++;
    }
  });

  liveRows.forEach((row, index) => {
    const videoId = String(row[4] || '');
    const counts = summary[videoId] || { total: 0, shorts: 0, normal: 0, published: 0 };
    const outputRow = index + 2;
    liveSheet.getRange(outputRow, 11).setValue(counts.total);
    liveSheet.getRange(outputRow, 14, 1, 3).setValues([[
      counts.shorts,
      counts.normal,
      counts.total > 0 ? counts.published / counts.total : 0
    ]]);
  });

  if (liveRows.length) {
    liveSheet.getRange(2, 11, liveRows.length, 1).setNumberFormat('0');
    liveSheet.getRange(2, 14, liveRows.length, 2).setNumberFormat('0');
    liveSheet.getRange(2, 16, liveRows.length, 1).setNumberFormat('0.0%');
  }
  // 元配信動画IDの補完後、既存候補の開始時間リンクを全行更新する。
  applyClipStartTimeLinks_(clipSheet, 2, clipRows.length);

  return { clipCount: clipRows.length, liveCount: liveRows.length };
}

function buildPublishedPerformanceMap_(ss) {
  const map = {};
  ['Shorts一覧', '通常動画一覧', 'ライブ一覧'].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) return;
    sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), 8))
      .getValues().forEach(row => {
        const id = String(row[4] || '').trim();
        if (!id) return;
        map[id] = {
          views: Number(row[6] || 0),
          likes: Number(row[7] || 0),
          subscribers: map[id] ? map[id].subscribers : 0
        };
      });
  });

  const analytics = ss.getSheetByName('Analytics_動画別');
  if (analytics && analytics.getLastRow() >= 2) {
    analytics.getRange(2, 1, analytics.getLastRow() - 1, 7).getValues().forEach(row => {
      const id = String(row[0] || '').trim();
      if (!id || id === '合計') return;
      if (!map[id]) map[id] = { views: 0, likes: 0, subscribers: 0 };
      map[id].subscribers = Number(row[6] || 0);
    });
  }
  return map;
}

function applyClipStartTimeLinks_(sheet, startRow, numRows) {
  const firstRow = Math.max(Number(startRow) || 2, 2);
  const availableRows = sheet.getLastRow() - firstRow + 1;
  const rowCount = Math.min(Number(numRows) || availableRows, availableRows);
  if (rowCount <= 0) return;

  // D列の配信URLが空の行は、O列の元配信動画IDを使ってリンクを作る。
  const sourceValues = sheet.getRange(firstRow, 4, rowCount, 12).getDisplayValues();
  sourceValues.forEach((row, index) => {
    const sourceUrl = String(row[0] || '').trim();
    const timeText = String(row[1] || '').trim();
    const sourceVideoId = String(row[11] || '').trim();
    const source = sourceUrl || sourceVideoId;
    const seconds = clipTimeToSeconds_(timeText);
    const timestampUrl = buildYouTubeTimestampUrl_(source, seconds);
    if (!timeText || !timestampUrl) return;

    const richText = SpreadsheetApp.newRichTextValue()
      .setText(timeText)
      .setLinkUrl(timestampUrl)
      .build();
    sheet.getRange(firstRow + index, 5).setRichTextValue(richText);
  });
}

function clipTimeToSeconds_(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.floor(Number(text));

  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  const seconds = parts.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
  return Math.floor(seconds);
}

function buildYouTubeTimestampUrl_(sourceUrl, seconds) {
  if (!sourceUrl || seconds === null || seconds < 0) return '';

  const videoId = extractYouTubeVideoId_(sourceUrl);
  if (!videoId) return '';

  const webAppUrl = ScriptApp.getService().getUrl();
  if (webAppUrl) {
    return webAppUrl
      + '?mode=clip&videoId=' + encodeURIComponent(videoId)
      + '&start=' + encodeURIComponent(seconds);
  }

  // Webアプリが未公開の場合だけ通常のYouTubeリンクへ戻す。
  return 'https://www.youtube.com/watch?v=' + videoId + '&t=' + seconds + 's';
}

function extractYouTubeVideoId_(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  return match ? match[1] : (/^[A-Za-z0-9_-]{11}$/.test(text) ? text : '');
}

function updateShortsSheet_(videos) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

  prepareSheet_(sheet);

  const lastRow = sheet.getLastRow();
  const existingValues = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues()
    : [];

  const rowsByVideoId = {};
  existingValues.forEach((row, index) => {
    const videoId = String(row[4] || '');
    if (videoId) {
      rowsByVideoId[videoId] = {
        rowNumber: index + 2,
        values: row
      };
    }
  });

  let addedCount = 0;
  let updatedCount = 0;
  const seenVideoIds = {};
  const now = new Date();

  videos.forEach(video => {
    const videoId = String(video.videoId || '');
    if (!videoId) return;

    seenVideoIds[videoId] = true;
    const existing = rowsByVideoId[videoId];

    let category = video.suggestedCategory || 'その他';
    let status = '公開中';
    let sourceLive = '';
    let rating = '';
    let memo = '';

    if (existing) {
      category = existing.values[9] || category;
      status = existing.values[10] || status;
      sourceLive = existing.values[11] || '';
      rating = existing.values[12] || '';
      memo = existing.values[13] || '';
    }

    const rowValues = [
      '',
      parseYouTubeDate_(video.publishedAt),
      video.title || '',
      video.url || '',
      videoId,
      Number(video.durationSeconds || 0),
      Number(video.viewCount || 0),
      Number(video.likeCount || 0),
      Number(video.commentCount || 0),
      category,
      status,
      sourceLive,
      rating,
      memo,
      now
    ];

    if (existing) {
      sheet.getRange(existing.rowNumber, 1, 1, HEADERS.length).setValues([rowValues]);
      updatedCount++;
    } else {
      sheet.appendRow(rowValues);
      addedCount++;
    }
  });

  Object.keys(rowsByVideoId).forEach(videoId => {
    if (!seenVideoIds[videoId]) {
      const rowNumber = rowsByVideoId[videoId].rowNumber;
      sheet.getRange(rowNumber, 11).setValue('要確認');
      sheet.getRange(rowNumber, 15).setValue(now);
    }
  });

  sortAndNumber_(sheet);
  formatSheet_(sheet);
  applyShortsValidations_(sheet);

  return { addedCount, updatedCount };
}


function updateNormalVideosSheet_(videos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('通常動画一覧') || ss.insertSheet('通常動画一覧');

  setupNormalVideosSheet_(ss);

  const columnCount = 16;
  const lastRow = sheet.getLastRow();
  const existingValues = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, columnCount).getValues()
    : [];

  const rowsByVideoId = {};
  existingValues.forEach((row, index) => {
    const videoId = String(row[4] || '');
    if (videoId) {
      rowsByVideoId[videoId] = { rowNumber: index + 2, values: row };
    }
  });

  let addedCount = 0;
  let updatedCount = 0;
  const seen = {};
  const now = new Date();

  videos.forEach(video => {
    const videoId = String(video.videoId || '');
    if (!videoId) return;

    seen[videoId] = true;
    const existing = rowsByVideoId[videoId];

    let category = video.suggestedCategory || 'その他';
    let status = '公開中';
    let series = '';
    let thumbnailCheck = '未確認';
    let rating = '';
    let memo = '';

    if (existing) {
      category = existing.values[9] || category;
      status = existing.values[10] || status;
      series = existing.values[11] || '';
      thumbnailCheck = existing.values[12] || '未確認';
      rating = existing.values[13] || '';
      memo = existing.values[14] || '';
    }

    const row = [
      '',
      parseYouTubeDate_(video.publishedAt),
      video.title || '',
      video.url || '',
      videoId,
      Math.round(Number(video.durationSeconds || 0) / 6) / 10,
      Number(video.viewCount || 0),
      Number(video.likeCount || 0),
      Number(video.commentCount || 0),
      category,
      status,
      series,
      thumbnailCheck,
      rating,
      memo,
      now
    ];

    if (existing) {
      sheet.getRange(existing.rowNumber, 1, 1, columnCount).setValues([row]);
      updatedCount++;
    } else {
      sheet.appendRow(row);
      addedCount++;
    }
  });

  Object.keys(rowsByVideoId).forEach(videoId => {
    if (!seen[videoId]) {
      const rowNumber = rowsByVideoId[videoId].rowNumber;
      sheet.getRange(rowNumber, 11).setValue('要確認');
      sheet.getRange(rowNumber, 16).setValue(now);
    }
  });

  const updatedLastRow = sheet.getLastRow();
  if (updatedLastRow >= 2) {
    sheet.getRange(2, 1, updatedLastRow - 1, columnCount)
      .sort([{ column: 2, ascending: false }]);

    const numbers = [];
    for (let i = 1; i <= updatedLastRow - 1; i++) numbers.push([i]);
    sheet.getRange(2, 1, numbers.length, 1).setValues(numbers);

    sheet.getRange(2, 2, updatedLastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, 6, updatedLastRow - 1, 1).setNumberFormat('0.0');
    sheet.getRange(2, 7, updatedLastRow - 1, 3).setNumberFormat('#,##0');
    sheet.getRange(2, 16, updatedLastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }

  return { addedCount, updatedCount };
}


function updateLiveSheet_(streams) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('ライブ一覧') || ss.insertSheet('ライブ一覧');
  setupLiveSheet_(ss);

  const columnCount = 16;
  const lastRow = sheet.getLastRow();
  const existingValues = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, columnCount).getValues()
    : [];
  const rowsByVideoId = {};
  existingValues.forEach((row, index) => {
    const videoId = String(row[4] || '');
    if (videoId) rowsByVideoId[videoId] = { rowNumber: index + 2, values: row };
  });

  let addedCount = 0;
  let updatedCount = 0;
  const seen = {};

  streams.forEach(stream => {
    const videoId = String(stream.videoId || '');
    if (!videoId) return;
    seen[videoId] = true;
    const existing = rowsByVideoId[videoId];
    const row = [
      '',
      parseYouTubeDate_(stream.publishedAt),
      stream.title || '',
      stream.url || '',
      videoId,
      Math.round(Number(stream.durationSeconds || 0) / 6) / 10,
      Number(stream.viewCount || 0),
      Number(stream.likeCount || 0),
      existing ? (existing.values[8] || stream.suggestedCategory || 'その他') : (stream.suggestedCategory || 'その他'),
      existing ? (existing.values[9] || '') : '',
      existing ? Number(existing.values[10] || 0) : 0,
      existing ? (existing.values[11] || '未確認') : '未確認',
      existing ? (existing.values[12] || '') : '',
      existing ? Number(existing.values[13] || 0) : 0,
      existing ? Number(existing.values[14] || 0) : 0,
      existing ? Number(existing.values[15] || 0) : 0
    ];

    if (existing) {
      sheet.getRange(existing.rowNumber, 1, 1, columnCount).setValues([row]);
      updatedCount++;
    } else {
      sheet.appendRow(row);
      addedCount++;
    }
  });

  Object.keys(rowsByVideoId).forEach(videoId => {
    if (!seen[videoId]) sheet.getRange(rowsByVideoId[videoId].rowNumber, 12).setValue('要確認');
  });

  const updatedLastRow = sheet.getLastRow();
  if (updatedLastRow >= 2) {
    sheet.getRange(2, 1, updatedLastRow - 1, columnCount).sort([{ column: 2, ascending: false }]);
    const numbers = [];
    for (let i = 1; i <= updatedLastRow - 1; i++) numbers.push([i]);
    sheet.getRange(2, 1, numbers.length, 1).setValues(numbers);
    sheet.getRange(2, 2, updatedLastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, 6, updatedLastRow - 1, 1).setNumberFormat('0.0');
    sheet.getRange(2, 7, updatedLastRow - 1, 2).setNumberFormat('#,##0');
  }

  refreshClipManagement_();
  return { addedCount, updatedCount };
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeader = headers.some((header, index) => current[index] !== header);
  if (needsHeader) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  sheet.setFrozenRows(1);
  return sheet;
}

function styleHeader_(sheet, color) {
  const columns = sheet.getLastColumn();
  styleHeaderRange_(sheet.getRange(1, 1, 1, columns), color);
}

function styleHeaderRange_(range, color) {
  range
    .setBackground(color)
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
}

function setWidths_(sheet, widths) {
  widths.forEach((width, index) => sheet.setColumnWidth(index + 1, width));
}

function setValidation_(sheet, column, values) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(true)
    .build();
  sheet.getRange(2, column, 1000, 1).setDataValidation(rule);
}

function applyFilter_(sheet, columnCount) {
  if (!sheet.getFilter()) {
    sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 2), columnCount).createFilter();
  }
}

function prepareSheet_(sheet) {
  const currentHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const needsHeaders = HEADERS.some((header, index) => currentHeaders[index] !== header);
  if (needsHeaders) sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.setFrozenRows(1);
}

function sortAndNumber_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  sheet.getRange(2, 1, lastRow - 1, HEADERS.length)
    .sort([{ column: 2, ascending: false }]);

  const numbers = [];
  for (let index = 1; index <= lastRow - 1; index++) numbers.push([index]);
  sheet.getRange(2, 1, numbers.length, 1).setValues(numbers);
}

function formatSheet_(sheet) {
  const lastRow = Math.max(sheet.getLastRow(), 2);

  styleHeaderRange_(sheet.getRange(1, 1, 1, HEADERS.length), '#C62828');

  sheet.getRange(2, 2, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(2, 7, lastRow - 1, 3).setNumberFormat('#,##0');
  sheet.getRange(2, 15, lastRow - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');

  sheet.getRange(1, 1, lastRow, HEADERS.length)
    .setVerticalAlignment('top')
    .setWrap(true);

  setWidths_(sheet, [60,140,360,280,120,90,110,110,110,130,100,220,70,260,140]);
  applyFilter_(sheet, HEADERS.length);
}

function applyShortsValidations_(sheet) {
  setValidation_(sheet, 10, ['Minecraft', '龍が如く', 'AEW・プロレス', '雑談', 'その他']);
  setValidation_(sheet, 11, ['公開中', '非公開', '要確認', 'リメイク候補']);
  setValidation_(sheet, 13, ['S', 'A', 'B', 'C']);
}

function parseYouTubeDate_(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date;
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
