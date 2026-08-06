const SETUP_TOKEN_PROPERTY = 'SHIDATUBE_SETUP_TOKEN';
const SHEET_NAME = 'Shorts一覧';

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
    .addSeparator()
    .addItem('投稿管理に新しい行を追加', 'addPostingRow')
    .addItem('切り抜き候補に新しい行を追加', 'addClipRow')
    .addToUi();
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

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'ShidaTube Shorts Sheet Receiver'
  });
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
    '確認状況', 'メモ'
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
  styleHeader_(sheet, '#1565C0');
  setWidths_(sheet, [60,120,360,280,120,100,110,110,150,150,110,110,260]);
  setValidation_(sheet, 12, ['未確認', '確認中', '確認済み', '要確認']);
  applyFilter_(sheet, headers.length);
}

function setupClipSheet_(ss) {
  const headers = [
    'No.', '登録日', '元配信', '配信URL', '開始時間', '終了時間',
    '内容・オチ', '種類', '優先度', '編集状況', '担当', '投稿予定日',
    '投稿済URL', 'メモ'
  ];
  const sheet = getOrCreateSheet_(ss, '切り抜き候補', headers);
  styleHeader_(sheet, '#6A1B9A');
  setWidths_(sheet, [60,110,280,260,90,90,360,120,90,110,110,120,260,260]);
  setValidation_(sheet, 8, ['爆笑', '神プレイ', '絶叫', '感動', '情報', 'その他']);
  setValidation_(sheet, 9, ['S', 'A', 'B', 'C']);
  setValidation_(sheet, 10, ['未着手', '編集中', '確認待ち', '完成', '保留']);
  applyFilter_(sheet, headers.length);
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

  // 既存の結合状態をすべて解除してから作り直す
  sheet
    .getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns())
    .breakApart();

  sheet.clear();
  sheet.getCharts().forEach(chart => sheet.removeChart(chart));
  sheet.setHiddenGridlines(true);

  // タイトル
  sheet.getRange('A1:K1').merge()
    .setValue('ShidaTube 運営ダッシュボード')
    .setBackground('#C62828')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setFontSize(20)
    .setHorizontalAlignment('center');

  // KPI
  sheet.getRange('A3:B3').setValues([['指標', '現在値']]);
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
  sheet.getRange('A4:A13').setFontWeight('bold');

  // 次にやること
  sheet.getRange('D3:H3').merge()
    .setValue('次にやること')
    .setBackground('#EF6C00')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.getRange('D4:H8').setValues([
    ['1', '投稿管理で「確認待ち」を確認', '', '', ''],
    ['2', 'S評価の切り抜き候補から着手', '', '', ''],
    ['3', '公開済みShortsの再生数を更新', '', '', ''],
    ['4', '次週分の投稿予定日を入力', '', '', ''],
    ['5', 'ネタ帳から次企画を選定', '', '', '']
  ]).setBorder(true, true, true, true, true, true);

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
  sheet.getRange('G14:J14').merge()
    .setValue('カテゴリ別平均再生数')
    .setBackground('#6A1B9A')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.getRange('G15:H15').setValues([['カテゴリ', '平均再生数']]);
  styleHeaderRange_(sheet.getRange('G15:H15'), '#263238');

  const cats = [
    ['Minecraft'],
    ['龍が如く'],
    ['AEW・プロレス'],
    ['雑談'],
    ['その他']
  ];

  sheet.getRange('G16:G20').setValues(cats);

  for (let row = 16; row <= 20; row++) {
    sheet.getRange(row, 8).setFormula(
      `=IFERROR(AVERAGEIF('Shorts一覧'!J:J,G${row},'Shorts一覧'!G:G),0)`
    );
  }

  sheet.getRange('H16:H20').setNumberFormat('#,##0');

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

  setWidths_(dashboard, [60, 130, 330, 100, 110, 110, 105, 115, 105, 110]);
  dashboard.setFrozenRows(2);
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('切り抜き候補');
  const row = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(row, 1).setValue(row - 1);
  sheet.getRange(row, 2).setValue(new Date()).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, 9).setValue('A');
  sheet.getRange(row, 10).setValue('未着手');
  sheet.activate();
  sheet.setActiveRange(sheet.getRange(row, 3));
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

  const columnCount = 13;
  const lastRow = sheet.getLastRow();
  const existingValues = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, columnCount).getValues()
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
  const seen = {};

  streams.forEach(stream => {
    const videoId = String(stream.videoId || '');
    if (!videoId) return;

    seen[videoId] = true;
    const existing = rowsByVideoId[videoId];

    let category = stream.suggestedCategory || 'その他';
    let collaborator = '';
    let clipCount = 0;
    let reviewStatus = '未確認';
    let memo = '';

    if (existing) {
      category = existing.values[8] || category;
      collaborator = existing.values[9] || '';
      clipCount = Number(existing.values[10] || 0);
      reviewStatus = existing.values[11] || '未確認';
      memo = existing.values[12] || '';
    }

    const row = [
      '',
      parseYouTubeDate_(stream.publishedAt),
      stream.title || '',
      stream.url || '',
      videoId,
      Math.round(Number(stream.durationSeconds || 0) / 6) / 10,
      Number(stream.viewCount || 0),
      Number(stream.likeCount || 0),
      category,
      collaborator,
      clipCount,
      reviewStatus,
      memo
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
      sheet.getRange(rowNumber, 12).setValue('要確認');
    }
  });

  const updatedLastRow = sheet.getLastRow();
  if (updatedLastRow >= 2) {
    sheet.getRange(2, 1, updatedLastRow - 1, columnCount)
      .sort([{ column: 2, ascending: false }]);

    const numbers = [];
    for (let i = 1; i <= updatedLastRow - 1; i++) {
      numbers.push([i]);
    }
    sheet.getRange(2, 1, numbers.length, 1).setValues(numbers);

    sheet.getRange(2, 2, updatedLastRow - 1, 1)
      .setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, 6, updatedLastRow - 1, 1)
      .setNumberFormat('0.0');
    sheet.getRange(2, 7, updatedLastRow - 1, 2)
      .setNumberFormat('#,##0');
    sheet.getRange(2, 11, updatedLastRow - 1, 1)
      .setNumberFormat('0');
  }

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
