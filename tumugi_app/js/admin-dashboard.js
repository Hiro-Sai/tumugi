// =========================================
// 管理者ダッシュボード：直近7日間の部署別・新卒別ネガティブスコア、
// および全社ひとまとまりのハラスメント傾向（受けた/言ってしまった）
//
// 認可はdashboard_data.php側でis_admin+is_activeを見て行っている。
// 非管理者トークンで叩いた場合は403が返り、下のloadDashboard()内で
// エラーメッセージとして表示される（このページの表示制御はUIの都合のみ）。
// =========================================

const HARASSMENT_LABELS = {
  received: "受けた",
  said: "言ってしまった",
};
const HARASSMENT_COLORS = {
  received: { from: "#e0a070", to: "#b8733f" },
  said:     { from: "#d4894a", to: "#b87333" },
};

// 最後に描いたグラフのデータ。グラフの大きさが変わったときの描き直しに使う
let lastChartBars = [];
let lastHarassmentCats = [];

// Canvasの絵は描いた時点の画素数で固定されるため、ウィンドウの大きさや
// 画面の拡大率（拡大率の違うモニターへの移動を含む）が変わると、描き直さない限り
// 引き伸ばされてぼやける。実際の画素数（device-pixel-content-box）の変化を見て描き直す。
const chartResizeObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    if (entry.target.id === "chartCanvas") drawBarChart(lastChartBars);
    else if (entry.target.id === "harassmentChartCanvas") drawHarassmentChart(lastHarassmentCats);
  }
});

function observeChartResize() {
  chartResizeObserver.disconnect();
  ["chartCanvas", "harassmentChartCanvas"].forEach(id => {
    const canvas = document.getElementById(id);
    if (canvas) chartResizeObserver.observe(canvas, { box: "device-pixel-content-box" });
  });
}

async function loadDashboard() {
  const content = document.getElementById("adminContent");

  const token = await requireAuthOrRedirect();
  if (!token) return;

  const res = await window.electronAPI.netServer({
    path: "/dashboard_data.php",
    method: "GET",
    token,
  });

  if (!res.ok) {
    if (res.status === 401) {
      await logout();
      return;
    }
    content.innerHTML = res.reason === "connection_refused"
      ? '<p class="admin-error">サーバーに接続できませんでした。サーバーが起動しているか確認してください</p>'
      : `<p class="admin-error">${escapeHtml(res.data?.error || "データの取得に失敗しました")}</p>`;
    return;
  }

  renderDashboard(res.data);
}

// -----------------------------------------
// XSS対策：department名・note文はDB/バックエンド由来のため、
// 表示時は必ずescapeHtml()を通す。
// -----------------------------------------
function renderDashboard(data) {
  const content = document.getElementById("adminContent");
  const departments = data.departments || [];
  const newGrad = data.new_grad || null;
  const harassment = data.harassment || { received: { display: "none" }, said: { display: "none" } };
  const minDeptSize = data.min_dept_size ?? 10;

  // 部署別バー＋新卒バーを1つの配列にまとめてチャートに渡す
  const chartBars = departments.map(d => ({ ...d, isNewGrad: false }));
  if (newGrad) {
    chartBars.push({
      department: "新卒（全社）",
      avg_score: newGrad.avg_score,
      log_count: newGrad.log_count,
      crisis: newGrad.crisis,
      isNewGrad: true,
    });
  }

  const harassmentCountCats = buildHarassmentCountCats(harassment);
  lastChartBars = chartBars;
  lastHarassmentCats = harassmentCountCats;

  if (chartBars.length === 0) {
    content.innerHTML = `
      <div class="admin-note">${escapeHtml(data.note || "現在表示できる部署がありません。")}</div>
      ${data.new_grad_note ? `<div class="admin-note">${escapeHtml(data.new_grad_note)}</div>` : ""}
      ${renderHarassmentCard(harassment, minDeptSize)}
    `;
    if (harassmentCountCats.length > 0) drawHarassmentChart(harassmentCountCats);
    observeChartResize();
    return;
  }

  const notesHtml = [
    (departments.length === 0 && data.note) ? `<div class="admin-note">${escapeHtml(data.note)}</div>` : "",
    (!newGrad && data.new_grad_note) ? `<div class="admin-note">${escapeHtml(data.new_grad_note)}</div>` : "",
  ].join("");

  content.innerHTML = `
    ${notesHtml}
    <div class="admin-note">
      直近7日間の部署別・新卒別 平均ネガティブスコア（0〜100）。社員ごとの平均を、グループで平均しています。個人特定リスク対策として、直近7日間に記録がある社員が${escapeHtml(String(minDeptSize))}名未満のグループは表示していません。危機検知は、該当者が${escapeHtml(String(minDeptSize))}名未満のときは件数を出さず「あり」とだけ表示します。
    </div>
    <div class="admin-card">
      <div class="admin-card-title">部署別・新卒別 平均スコア</div>
      <canvas id="chartCanvas"></canvas>
      <div class="chart-legend">
        <span><span class="legend-dot legend-dot-dept"></span>部署</span>
        <span><span class="legend-dot legend-dot-newgrad"></span>新卒（全社）</span>
      </div>
    </div>
    <div class="admin-card">
      <div class="admin-card-title">詳細データ</div>
      <table class="admin-table">
        <thead>
          <tr>
            <th>グループ</th>
            <th>平均スコア</th>
            <th>ログ件数</th>
            <th>危機検知</th>
          </tr>
        </thead>
        <tbody>
          ${chartBars.map(d => `
            <tr>
              <td>${escapeHtml(d.department)}${d.isNewGrad ? '<span class="new-grad-badge">新卒</span>' : ""}</td>
              <td>${escapeHtml(d.avg_score ?? "-")}</td>
              <td>${escapeHtml(d.log_count ?? 0)}</td>
              ${renderCrisisCell(d.crisis)}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${renderHarassmentCard(harassment, minDeptSize)}
  `;

  drawBarChart(chartBars);
  if (harassmentCountCats.length > 0) drawHarassmentChart(harassmentCountCats);
  observeChartResize();
}

// 危機検知の欄。サーバーが該当人数で3段階に分けて返す（dashboard_data.php の rareEventDisplay）
//   count → 件数、flag_only → 「あり（人数非公開）」、none → 0
function renderCrisisCell(crisis) {
  const display = crisis?.display ?? "none";
  if (display === "count") {
    return `<td class="crisis-cell">${escapeHtml(crisis.count ?? 0)}</td>`;
  }
  if (display === "flag_only") {
    return '<td class="crisis-cell">あり（人数非公開）</td>';
  }
  return "<td>0</td>";
}

// harassmentオブジェクトから、実際に棒グラフとして描画すべき
// （display === "count" の）カテゴリだけを抜き出す
function buildHarassmentCountCats(harassment) {
  return Object.keys(HARASSMENT_LABELS)
    .filter(key => harassment[key] && harassment[key].display === "count")
    .map(key => ({
      key,
      label: HARASSMENT_LABELS[key],
      value: harassment[key].count ?? 0,
    }));
}

// ハラスメントカードのHTML断片を組み立てる。
// カテゴリごとに display が "count"（棒グラフ表示） / "flag_only"
// （件数非公開・存在のみのバッジ） / "none"（何も出さない）に分かれる。
function renderHarassmentCard(harassment, minDeptSize) {
  const countCats = buildHarassmentCountCats(harassment);
  const flagKeys = Object.keys(HARASSMENT_LABELS)
    .filter(key => harassment[key] && harassment[key].display === "flag_only");

  if (countCats.length === 0 && flagKeys.length === 0) {
    return `
      <div class="admin-card">
        <div class="admin-card-title">ハラスメント傾向（全社・直近7日間）</div>
        <div class="admin-note" style="margin-bottom:0;">現在、ハラスメント関連の申告はありません。</div>
      </div>
    `;
  }

  const flagBadgesHtml = flagKeys.map(key => `
    <div class="harassment-flag-note">
      ⚠️ 「${escapeHtml(HARASSMENT_LABELS[key])}」に該当する申告が直近7日間であります。該当人数が${escapeHtml(String(minDeptSize))}名未満のため、個人特定防止の観点から具体的な件数は表示していません。
    </div>
  `).join("");

  const chartHtml = countCats.length > 0
    ? `<canvas id="harassmentChartCanvas"></canvas>`
    : "";

  return `
    <div class="admin-card">
      <div class="admin-card-title">ハラスメント傾向（全社・直近7日間）</div>
      <div class="admin-note" style="margin-bottom:16px;">
        部署別ではなく全社ひとまとまりで集計しています（まれな事象のため、部署別に出すと少人数部署で個人が特定されうるための対応です）。「受けた」はハラスメントを受けたと述べた件数、「言ってしまった」は自分がハラスメント的な言動をしてしまったと述べた件数です。
      </div>
      ${chartHtml}
      ${flagBadgesHtml}
    </div>
  `;
}

// シンプルな棒グラフをCanvasで描画（外部ライブラリ不使用）
// 新卒バーは isNewGrad フラグで色を差別化する
function drawBarChart(departments) {
  const canvas = document.getElementById("chartCanvas");
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth  = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = 260;
  canvas.width  = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = cssHeight + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 16, right: 16, bottom: 40, left: 36 };
  const chartW = cssWidth - padding.left - padding.right;
  const chartH = cssHeight - padding.top - padding.bottom;
  const maxScore = 100;
  const barGap = 24;
  const barW = Math.min(34, (chartW - barGap * (departments.length - 1)) / departments.length);

  const styles = getComputedStyle(document.documentElement);
  const amberGlow = styles.getPropertyValue("--amber-glow").trim() || "#C97A3D";
  const amberDim  = styles.getPropertyValue("--amber-dim").trim() || "#A8631E";
  const cream     = styles.getPropertyValue("--cream").trim() || "#2B2018";
  const divider   = "rgba(43,32,24,0.12)";
  // 新卒バー用の差別化カラー（既存パレットに寄せた寒色系アクセント）
  const newGradGlow = "#5a9bd4";
  const newGradDim  = "#3f6f99";

  // 横軸の基準線（0, 50, 100）
  ctx.strokeStyle = divider;
  ctx.fillStyle = cream;
  ctx.font = "10px 'DM Sans', sans-serif";
  ctx.globalAlpha = 0.5;
  [0, 50, 100].forEach(val => {
    const y = padding.top + chartH - (val / maxScore) * chartH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
    ctx.stroke();
    ctx.fillText(String(val), 6, y + 3);
  });
  ctx.globalAlpha = 1;

  // 棒本体
  const totalBarsWidth = barW * departments.length + barGap * (departments.length - 1);
  let x = padding.left + Math.max(0, (chartW - totalBarsWidth) / 2);

  departments.forEach(d => {
    const score = Math.max(0, Math.min(100, Number(d.avg_score) || 0));
    const barH = (score / maxScore) * chartH;
    const y = padding.top + chartH - barH;

    const gradient = ctx.createLinearGradient(0, y, 0, y + barH);
    if (d.isNewGrad) {
      gradient.addColorStop(0, newGradGlow);
      gradient.addColorStop(1, newGradDim);
    } else {
      gradient.addColorStop(0, amberGlow);
      gradient.addColorStop(1, amberDim);
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 4) : ctx.rect(x, y, barW, barH);
    ctx.fill();

    // スコア数値
    ctx.fillStyle = cream;
    ctx.globalAlpha = 0.85;
    ctx.font = "11px 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(score.toFixed(1), x + barW / 2, y - 6);
    ctx.globalAlpha = 1;

    // 部署名／グループ名ラベル（Canvasの描画はHTMLパースしないためescapeHtml不要）
    ctx.font = "11px 'Noto Sans JP', sans-serif";
    ctx.fillText(d.department, x + barW / 2, padding.top + chartH + 18);

    x += barW + barGap;
  });

  ctx.textAlign = "left";
}

// ハラスメント傾向の棒グラフ。display==="count"のカテゴリだけが渡される
// （0本・1本・2本のいずれもあり得る）。件数（生の整数）なので、
// drawBarChartの0-100スケール前提とは別の専用描画関数にしている。
function drawHarassmentChart(countCats) {
  const canvas = document.getElementById("harassmentChartCanvas");
  if (!canvas || countCats.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth  = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = 220;
  canvas.width  = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = cssHeight + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 28, right: 16, bottom: 40, left: 16 };
  const chartW = cssWidth - padding.left - padding.right;
  const chartH = cssHeight - padding.top - padding.bottom;

  const bars = countCats.map(c => ({
    label: c.label,
    value: c.value,
    colorFrom: (HARASSMENT_COLORS[c.key] || HARASSMENT_COLORS.said).from,
    colorTo:   (HARASSMENT_COLORS[c.key] || HARASSMENT_COLORS.said).to,
  }));

  const maxValue = Math.max(1, ...bars.map(b => b.value));
  const barW = 50;
  const barGap = 48;

  const styles = getComputedStyle(document.documentElement);
  const cream = styles.getPropertyValue("--cream").trim() || "#2B2018";

  const totalBarsWidth = barW * bars.length + barGap * (bars.length - 1);
  let x = padding.left + Math.max(0, (chartW - totalBarsWidth) / 2);

  bars.forEach(b => {
    const barH = Math.max((b.value / maxValue) * chartH, b.value > 0 ? 4 : 0);
    const y = padding.top + chartH - barH;

    const gradient = ctx.createLinearGradient(0, y, 0, y + Math.max(barH, 1));
    gradient.addColorStop(0, b.colorFrom);
    gradient.addColorStop(1, b.colorTo);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, barW, Math.max(barH, 1), 4);
    } else {
      ctx.rect(x, y, barW, Math.max(barH, 1));
    }
    ctx.fill();

    ctx.fillStyle = cream;
    ctx.globalAlpha = 0.9;
    ctx.font = "13px 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(b.value), x + barW / 2, y - 8);
    ctx.globalAlpha = 1;

    ctx.font = "11px 'Noto Sans JP', sans-serif";
    ctx.fillText(b.label, x + barW / 2, padding.top + chartH + 20);

    x += barW + barGap;
  });

  ctx.textAlign = "left";
}

window.onload = loadDashboard;

// 「チャットに戻る」ボタン（CSP で HTML の onclick が動かないため、ここで登録する）
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("adminBackBtn")?.addEventListener("click", () => {
    location.href = "index.html";
  });
});
