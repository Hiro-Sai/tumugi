// =========================================
// 管理者ダッシュボード：直近7日間の部署別・新卒別ネガティブスコア、
// および全社ひとまとまりのハラスメント傾向（受けた/言ってしまった）
//
// 認可はdashboard_data.php側でis_admin+is_activeを見て行っている。
// 非管理者トークンで叩いた場合は403が返り、下のloadDashboard()内で
// エラーメッセージとして表示される（このページの表示制御はUIの都合のみ）。
// =========================================

// ハラスメントに関する発言の、表に出す順番と名前
const HARASSMENT_LABELS = {
  received: "受けたという発言",
  said: "言ってしまったという発言",
};

// 棒の幅・点数の文・まれな事象の文は、js/dashboard-view.js にある（値を返すだけの関数）
const { barPercent, scoreText, rareEventText } = TumugiDashboardView;

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
      ? '<p class="admin-error" role="alert">サーバーに接続できませんでした。サーバーが起動しているか確認してください。</p>'
      : `<p class="admin-error" role="alert">${escapeHtml(res.data?.error || "集計データを取得できませんでした。")}</p>`;
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

  const sectionTitle = '<h2 class="admin-section-title">直近7日間の平均ネガティブスコア</h2>';

  const min = escapeHtml(String(minDeptSize));
  // 説明の文。出せるグループが無いときも出す（なぜ出ないかが分かるように）
  const leadHtml = `<p class="lead">数値（0〜100）が大きいほど、ネガティブな感情の記録が多いことを示します。社員ごとの平均値を、グループ単位で平均しています。個人の特定を防ぐため、直近7日間に記録のある社員が${min}名未満のグループは表示しません。危機的な発言は、該当する社員が${min}名未満のときは件数を表示せず「あり」とだけ表示します。管理者の記録と、仮のパスワードを変えてから（在籍に戻したとき・管理者の権限を外したときは、そこから）7日間の記録は、集計に入りません。退職した社員の記録は、7日たつまで集計に残ります。</p>`;

  if (chartBars.length === 0) {
    // 出せるグループが1つも無いとき。理由（サーバーの note）を、1つの面にまとめて出す
    content.innerHTML = `
      ${sectionTitle}
      ${leadHtml}
      <div class="panel empty">
        <h3>現在、表示できるグループがありません</h3>
        <p>${escapeHtml(data.note || "現在表示できる部署がありません。")}</p>
        ${data.new_grad_note ? `<p>${escapeHtml(data.new_grad_note)}</p>` : ""}
      </div>
      ${renderHarassmentCard(harassment, minDeptSize)}
    `;
    return;
  }

  const notesHtml = [
    (departments.length === 0 && data.note) ? `<div class="admin-note">${escapeHtml(data.note)}</div>` : "",
    (!newGrad && data.new_grad_note) ? `<div class="admin-note">${escapeHtml(data.new_grad_note)}</div>` : "",
  ].join("");

  // 棒の幅は barPercent（0〜100 の数）。CSP は style 属性を許している（style-src 'unsafe-inline'）
  const barsHtml = chartBars.map(d => `
    <span class="bar-name">${escapeHtml(d.department)}</span>
    <div class="track"><div class="fill${d.isNewGrad ? " grad" : ""}" style="width:${barPercent(d.avg_score)}%"></div></div>
    <span class="num">${escapeHtml(scoreText(d.avg_score))}</span>
  `).join("");

  const rowsHtml = chartBars.map(d => `
    <tr>
      <td class="name">${escapeHtml(d.department)}</td>
      <td class="n">${escapeHtml(scoreText(d.avg_score))}</td>
      <td class="n">${escapeHtml(d.log_count ?? 0)}</td>
      <td>${renderRareTag(d.crisis)}</td>
    </tr>
  `).join("");

  content.innerHTML = `
    ${sectionTitle}
    ${leadHtml}
    ${notesHtml}
    <div class="panel">
      <h3>部署別・新卒</h3>
      <div class="bars">${barsHtml}</div>
    </div>
    <div class="panel">
      <h3>詳細データ</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">グループ</th>
            <th scope="col" class="n">平均スコア</th>
            <th scope="col" class="n">記録件数</th>
            <th scope="col">危機的な発言</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    ${renderHarassmentCard(harassment, minDeptSize)}
  `;
}

// まれな事象の欄。サーバーが該当人数で3段階に分けて返す（dashboard_data.php の rareEventDisplay）
//   count → 件数、flag_only → 「あり（人数は非表示）」、none → 「なし」
// 文は dashboard-view.js の rareEventText。count と flag_only は目立つ色の札にする
function renderRareTag(event) {
  const display = event?.display ?? "none";
  const warn = display === "count" || display === "flag_only";
  return `<span class="tag${warn ? " warn" : ""}">${escapeHtml(rareEventText(display, event?.count))}</span>`;
}

// ハラスメントの欄のHTML断片を組み立てる。
// 種類ごとに display が "count"（件数を出す） / "flag_only"（あるとだけ出す） / "none"（なし）に分かれる。
function renderHarassmentCard(harassment, minDeptSize) {
  const min = escapeHtml(String(minDeptSize));
  const rowsHtml = Object.keys(HARASSMENT_LABELS).map(key => `
    <tr>
      <td>${escapeHtml(HARASSMENT_LABELS[key])}</td>
      <td>${renderRareTag(harassment[key])}</td>
    </tr>
  `).join("");

  return `
    <div class="panel">
      <h3>ハラスメントに関する発言（全社・直近7日間）</h3>
      <p class="hint">部署別ではなく、全社をまとめて集計しています（部署別に出すと、少人数の部署で個人が特定されるおそれがあるためです）。「受けたという発言」はハラスメントを受けたと述べた件数、「言ってしまったという発言」は自分がハラスメントに当たる言動をしてしまったと述べた件数です。</p>
      <table>
        <thead><tr><th scope="col">種類</th><th scope="col">状況</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p class="hint">件数は、同じ種類の発言をした社員が${min}名以上の場合にのみ表示します。${min}名未満のときは、個人の特定を防ぐため「あり」とだけ表示し、件数は表示しません。</p>
    </div>
  `;
}

window.onload = loadDashboard;

// -----------------------------------------
// タブ（集計／社員）
// 開いたときは「集計」。「社員」の中身は js/admin-employees.js が描く。
// 「社員」を初めて開いたときに、一覧を読み込む。
// 仮のパスワードの表示中・サーバーに送っている途中は、admin-employees.js が
// 「集計」のタブを押せなくする（右の欄を替えさせないため）。ここでは何もしなくてよい。
// -----------------------------------------
let employeesTabOpened = false;

function setTabState(buttonId, isOn) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.classList.toggle("on", isOn);
  button.setAttribute("aria-selected", String(isOn));
}

function showTab(name) {
  const showEmployees = name === "employees";
  document.getElementById("adminContent").hidden = showEmployees;
  document.getElementById("employeesPanel").hidden = !showEmployees;
  setTabState("tabSummaryBtn", !showEmployees);
  setTabState("tabEmployeesBtn", showEmployees);

  if (showEmployees && !employeesTabOpened) {
    employeesTabOpened = true;
    loadEmployeesTab();
  }
}

// 「チャットに戻る」ボタン・タブ（CSP で HTML の onclick が動かないため、ここで登録する）
// ダッシュボードはチャットとは別のウィンドウなので、閉じればチャットに戻る（main.js の admin:open）
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("adminBackBtn")?.addEventListener("click", () => {
    window.close();
  });

  document.getElementById("tabSummaryBtn")?.addEventListener("click", () => showTab("summary"));
  document.getElementById("tabEmployeesBtn")?.addEventListener("click", () => showTab("employees"));

  // 展示モードでは「社員」タブを出さない（来場者が共用のアカウントで社員を消せないように）。
  // 展示モードかどうか確かめられなかったときも出さない
  window.electronAPI.isExhibitMode()
    .catch(() => true)
    .then((exhibit) => {
      if (!exhibit) document.getElementById("tabEmployeesBtn").hidden = false;
    });
});
