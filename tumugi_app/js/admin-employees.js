// =========================================
// 管理者ダッシュボードの「社員」タブ
//   左：社員の一覧（探す・選ぶ）　右：詳しい欄（登録・直す・リセット・退職・消す）
//
// 右の欄は、場面（mode）を切り替えて出す。
//   none               何も選んでいない
//   new                登録
//   detail             社員を選んだとき（直す・各操作のボタン）
//   password           ① 仮のパスワードの表示（登録・リセットのあと）
//   confirmReset       ② リセットの確認
//   confirmDeactivate  退職の確認
//   confirmDelete      ③ 消すときの確認
//
// 決まり
//   - 名前など DB から来た文字は、必ず textContent（h() の文字の子）で出す。innerHTML は使わない。
//   - 仮のパスワードは、画面に出すだけ。console にも、ほかの変数にも残さない（閉じたら捨てる）。
//   - ①を出しているあいだと、サーバーに送っているあいだは、「← チャットに戻る」・集計のタブ・一覧を押せなくする。
//     ①を出しているあいだは、一覧も読み直さない（読み直しで 401 になるとログアウトでウィンドウが閉じ、
//     仮のパスワードが消えるため）。一覧は「伝えたので閉じる」を押したときに読み直す。
//   - 入力の確かめや「今できる操作」の判定は employee-rules.js に任せる（ここには書かない）。
//     サーバーが最終的に確かめるので、ここは理由を先に出すため。
//   - 確認は画面の中で行う（confirm()・alert() は使わない）。
// =========================================

(function () {
  "use strict";

  const Rules = globalThis.TumugiEmployeeRules;

  const MSG_NO_CONNECTION = "サーバーに接続できませんでした";
  const MSG_FAILED = "操作できませんでした。もう一度お試しください";
  const MSG_SELF = "自分自身は、リセット・退職にする・管理者から外すことができません。自分のパスワードは、チャットの『設定』から変えてください。";
  const MSG_LAST_ADMIN = "この人は在籍の管理者の最後の1人のため、退職にすることも、管理者から外すこともできません。";
  const MSG_TAB_LOCKED = "仮のパスワードを閉じてから切り替えてください";
  const MSG_BACK_LOCKED = "仮のパスワードを閉じてから戻ってください";
  const NEW_DEPARTMENT_LABEL = "新しい部署…";

  // 選んだ社員が要る場面
  const MODES_WITH_TARGET = new Set(["detail", "confirmReset", "confirmDeactivate", "confirmDelete"]);

  // ----- 状態 -----
  let employees = [];       // サーバーから読んだ全社員
  let departments = [];     // 部署の候補（在籍の社員の部署）
  let selfCode = "";        // 操作している管理者の社員ID
  let listError = "";       // 一覧を読めなかったときの理由
  let loading = false;      // 一覧を読んでいる途中
  let showLoadingNote = false;  // 読んでいるあいだ、一覧に「読み込み中…」を出す
  let loadedOnce = false;   // 一覧を一度でも読めた（読めるまでは登録を始められない。部署の候補がないため）
  let loadSeq = 0;          // 一覧を読む呼び出しの番号（古い応答を捨てるため）

  let mode = "none";
  let selectedCode = null;  // 選んでいる社員ID（登録中・何も選んでいないときは null）
  let shown = null;         // password の場面で出す { kind: "create" | "reset", code, name, password }
  let message = { text: "", kind: "error" };  // 右の欄に出す知らせ（kind: "error" | "ok"）
  let busy = false;         // サーバーに送っている途中
  let busyToken = 0;        // 送るたびに増やす番号（あとから始めた操作の「送っている途中」を、前の操作が終わらせないため）

  // 画面の部品（init() で取る）
  let searchEl, newBtn, listEl, detailEl, summaryTabBtn, backBtn;
  let msgEl = null;         // 今の場面の知らせの欄
  let focusEl = null;       // 場面を描いたあとに文字を入れる欄

  // ----- 部品を作る道具 -----
  // 文字は textContent と同じ扱い（子に文字を渡すと文字の節になり、HTML としては読まれない）
  const PROPERTY_KEYS = new Set(["value", "checked", "disabled", "hidden", "selected"]);

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (PROPERTY_KEYS.has(key)) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false));
    return node;
  }

  function findEmployee(code) {
    if (code === null) return null;
    return employees.find((e) => e.employee_code === code) || null;
  }

  // =========================================
  // サーバーとのやりとり
  // =========================================

  // 期限切れなどで認証できないときは、ログイン画面に戻して { loggedOut: true } を返す
  async function callServer(path, method, body) {
    try {
      const token = await requireAuthOrRedirect();
      if (!token) return { ok: false, loggedOut: true };
      return await window.electronAPI.netServer({ path, method, body, token });
    } catch {
      return { ok: false, reason: "unknown" };
    }
  }

  // 失敗した応答を、右の欄に出す文章にする。ログイン画面に戻すときは null を返す
  async function explainFailure(res) {
    if (res.loggedOut) return null;
    if (res.status === 401) {
      await logout();
      return null;
    }
    if (res.reason === "connection_refused") return MSG_NO_CONNECTION;
    // DB のデッドロックなどで JSON ではない 500 が返ると、data は null になる
    const text = res.data && typeof res.data.error === "string" ? res.data.error : "";
    return text || MSG_FAILED;
  }

  // 一覧を読み直して、左の一覧を描き直す。読めたら true
  //   announce : 「読み込み中…」を出す（「もう一度読み込む」を押したとき）。
  //              一覧が空のあいだは、いつも出す。操作のあとの読み直しでは出さない（一覧が一瞬ずれるため）
  async function reloadEmployees(announce = false) {
    const seq = ++loadSeq;
    loading = true;
    showLoadingNote = announce || employees.length === 0;
    if (showLoadingNote) renderList();

    const res = await callServer("/admin_employees.php", "GET");
    // もっと新しい読み込みが始まっている。この応答は古いので捨てる（新しい方が描く）
    if (seq !== loadSeq) return true;
    loading = false;

    if (!res.ok) {
      const text = await explainFailure(res);
      if (text !== null) {
        listError = text;
        renderList();
      }
      return false;
    }

    const data = res.data;
    if (!data || !Array.isArray(data.employees)) {
      listError = MSG_FAILED;
      renderList();
      return false;
    }

    employees = data.employees;
    departments = Array.isArray(data.departments) ? data.departments : [];
    selfCode = typeof data.self_code === "string" ? data.self_code : "";
    listError = "";
    loadedOnce = true;
    renderList();
    syncControls();
    return true;
  }

  // サーバーに送る操作の共通の流れ。
  // 送っているあいだは右の欄のボタンをすべて押せなくする（ダブルクリックで2回送らないため）。
  //   request   : サーバーに送る処理（callServer の結果を返す）
  //   onSuccess : 成功したときの処理（一覧の読み直しと、右の欄の描き直し）
  async function perform(request, onSuccess) {
    if (busy) return;
    showMessage("");
    lockPanel();
    const myToken = busyToken;

    let res;
    let failure = null;   // 失敗したときに右の欄へ出す文章
    let listIsStale = false;   // 404・409：ほかの管理者が先に変えたかもしれない（一覧が古い）
    try {
      res = await request();
      if (!res.ok) {
        listIsStale = res.status === 404 || res.status === 409;
        failure = await explainFailure(res);
        if (failure === null) return;   // ログイン画面に戻る。画面は押せないままにしておく
      }
    } catch {
      // 認証の確かめ・ログアウト・中継のどこかで例外が出た。
      // 理由は記録しない（応答や仮のパスワードが記録に入らないように、ここでは何も出さない）
      failure = MSG_FAILED;
    }

    if (failure !== null) {
      // あとから始めた操作がある（番号が違う）ときは、その操作の「送っている途中」を触らない
      if (busyToken === myToken) unlockPanel();
      showMessage(failure, "error");
      // 一覧だけを読み直す。右の欄は描き直さない（出した知らせも、入れた中身も残すため）
      if (listIsStale) await reloadEmployees();
      return;
    }

    try {
      await onSuccess(res);
    } finally {
      // あとから始めた操作がある（番号が違う）ときは、その操作の「送っている途中」は触らない
      if (busyToken === myToken) endBusy();
    }
  }

  function endBusy() {
    busy = false;
    syncControls();
  }

  // 右の欄の部品をすべて押せなくする。元から押せなかったものは、あとで押せないまま戻す
  function lockPanel() {
    busy = true;
    busyToken++;
    for (const el of detailEl.querySelectorAll("button, input, select")) {
      el.dataset.prevDisabled = el.disabled ? "1" : "";
      el.disabled = true;
    }
    syncControls();
  }

  function unlockPanel() {
    for (const el of detailEl.querySelectorAll("button, input, select")) {
      // lockPanel が印を付けていない部品（そのあとに描き直された部品）は、元の状態のままにする
      if (!("prevDisabled" in el.dataset)) continue;
      el.disabled = el.dataset.prevDisabled === "1";
      delete el.dataset.prevDisabled;
    }
    endBusy();
  }

  // 「＋ 新しい社員」・タブの切り替え・「← チャットに戻る」を、押せるかどうか合わせる。
  // 送っている途中と、①の表示中は、右の欄を替えさせず、ウィンドウも閉じさせない（仮のパスワードは二度と出せないため）。
  // （ウィンドウの × は止められない。beforeunload で止めると、ウィンドウを閉じられなくなるため）
  function syncControls() {
    const passwordShown = mode === "password";
    newBtn.disabled = !loadedOnce || busy || passwordShown;
    summaryTabBtn.disabled = busy || passwordShown;
    summaryTabBtn.title = passwordShown ? MSG_TAB_LOCKED : "";
    backBtn.disabled = busy || passwordShown;
    backBtn.title = passwordShown ? MSG_BACK_LOCKED : "";
    listEl.classList.toggle("locked", passwordShown);
  }

  // =========================================
  // 場面の切り替え
  // =========================================

  function clearMessage() {
    message = { text: "", kind: "error" };
  }

  function selectEmployee(code) {
    if (busy || mode === "password") return;
    if (code === selectedCode && mode === "detail") return;
    selectedCode = code;
    mode = "detail";
    clearMessage();
    markSelected();
    renderDetail();
  }

  function startNew() {
    if (busy || mode === "password") return;
    if (mode === "new") return;   // 入れかけの中身を消さない
    selectedCode = null;
    mode = "new";
    clearMessage();
    markSelected();
    renderDetail();
  }

  // 選んだ社員のまま、別の場面（確認など）に移る
  function goTo(nextMode) {
    if (busy) return;
    mode = nextMode;
    clearMessage();
    renderDetail();
  }

  // ①：仮のパスワードを出す。「伝えたので閉じる」を押すまで、この場面のまま
  function openPasswordPanel(kind, code, name, password) {
    shown = { kind, code, name, password };
    selectedCode = code;
    mode = "password";
    clearMessage();
    markSelected();
    renderDetail();
  }

  // 「伝えたので閉じる」：仮のパスワードを捨てて、一覧を読み直し、対象の社員の詳しい欄を出す。
  // ①の表示中は一覧を読み直していないので、登録したばかりの社員は、ここで初めて一覧に出る。
  // 読み直しのあいだ、右の欄は「社員を選んでください」にしておく（その間に別の社員を選んでもよい）
  async function closePasswordPanel() {
    if (mode !== "password" || shown === null) return;
    const code = shown.code;
    shown = null;   // 仮のパスワードを捨てる
    selectedCode = code;
    mode = "none";
    clearMessage();
    markSelected();
    renderDetail();

    // 読めなかったときは、reloadEmployees が一覧にその理由と「もう一度読み込む」を出す。
    // 401 のときはログアウトでウィンドウが閉じる（①はもう閉じているので、仮のパスワードは失われない）
    await reloadEmployees();

    // 読み直しのあいだに、別の社員を選んだり、登録を始めたり、操作を始めたりしていたら、右の欄は触らない
    if (selectedCode !== code || mode !== "none" || busy) return;
    mode = findEmployee(code) ? "detail" : "none";
    if (mode === "none") selectedCode = null;
    markSelected();
    renderDetail();
    revealSelected();
  }

  // 操作が成功したあとの共通の流れ：一覧を読み直し、対象の社員を選んだままにする
  // （code が null なら「何も選んでいない」。kind は知らせの種類で、ふつうは "ok"）
  async function finishWith(code, text, kind = "ok") {
    selectedCode = code;
    mode = code === null ? "none" : "detail";
    const reloaded = await reloadEmployees();
    message = reloaded
      ? { text, kind }
      : { text: `${text}（一覧は読み直せませんでした）`, kind: "error" };
    markSelected();
    renderDetail();
    revealSelected();
  }

  // 登録・リセットのあと。仮のパスワードは、この応答でしか手に入らない。
  // 応答から先に出し、①の表示中は一覧を読み直さない（読み直しで 401 になると、ログアウトで
  // ウィンドウが閉じて、仮のパスワードが失われるため）。一覧は「伝えたので閉じる」で読み直す
  async function finishWithPassword(res, kind, code, name) {
    const password = res.data && typeof res.data.temp_password === "string" ? res.data.temp_password : "";
    if (password === "") {
      // サーバーの不具合で、仮のパスワードが入っていない。操作は済んでいるので、やり直しを案内する
      await finishWith(code, "操作はできましたが、仮のパスワードを受け取れませんでした。もう一度「パスワードをリセット」を押してください", "error");
      return;
    }
    // 「送っている途中」は、呼び出し元の perform が終わらせる（①のボタンは描き直した新しい部品なので押せる）
    openPasswordPanel(kind, code, name, password);
  }

  // =========================================
  // 左の一覧
  // =========================================

  function tag(text, kind) {
    return h("span", { class: `emp-tag ${kind}` }, text);
  }

  function rowFor(e) {
    const tags = [];
    if (e.is_new_grad) tags.push(tag("新卒", "grad"));
    if (e.is_admin) tags.push(tag("管理者", "adm"));
    if (!e.is_active) tags.push(tag("退職", "off"));
    if (e.must_change_password) tags.push(tag("仮のパスワード", "temp"));

    const classes = ["emp-row"];
    if (e.employee_code === selectedCode) classes.push("sel");
    if (!e.is_active) classes.push("off");

    return h("button", { type: "button", class: classes.join(" "), "data-code": e.employee_code },
      h("span", { class: "emp-id" }, e.employee_code),
      h("span", { class: "emp-name", title: e.display_name }, e.display_name),
      h("span", { class: "emp-dept", title: e.department }, e.department),
      h("span", { class: "emp-tags" }, tags)
    );
  }

  function renderList() {
    const nodes = [];
    if (listError) {
      nodes.push(h("div", { class: "emp-list-note error" },
        h("div", {}, listError),
        h("button", { type: "button", class: "emp-btn sub", onclick: () => loadEmployeesTab() }, "もう一度読み込む")
      ));
    } else if (loading && showLoadingNote) {
      nodes.push(h("div", { class: "emp-list-note" }, "読み込み中…"));
    } else if (employees.length === 0) {
      nodes.push(h("div", { class: "emp-list-note" }, "社員がいません"));
    }

    const rows = Rules.filterEmployees(Rules.sortEmployees(employees), searchEl.value);
    if (rows.length === 0 && employees.length > 0) {
      nodes.push(h("div", { class: "emp-list-note" }, "該当する社員がいません"));
    }
    for (const e of rows) nodes.push(rowFor(e));

    const top = listEl.scrollTop;
    listEl.replaceChildren(...nodes);
    listEl.scrollTop = top;
  }

  // 一覧を描き直さずに、選んでいる行の色だけ替える（押した行からフォーカスが外れないように）
  function markSelected() {
    for (const row of listEl.querySelectorAll(".emp-row")) {
      row.classList.toggle("sel", row.dataset.code === selectedCode);
    }
  }

  function revealSelected() {
    listEl.querySelector(".emp-row.sel")?.scrollIntoView({ block: "nearest" });
  }

  // =========================================
  // 右の欄
  // =========================================

  function makeMessageEl() {
    msgEl = h("p", { class: "emp-msg", role: "status" });
    return msgEl;
  }

  function applyMessage() {
    if (!msgEl) return;
    msgEl.textContent = message.text;
    msgEl.className = `emp-msg ${message.kind}`;
    msgEl.hidden = message.text === "";
  }

  // 描き直さずに知らせだけ替える（入力した中身を消さないため）
  function showMessage(text, kind = "error") {
    message = { text, kind };
    applyMessage();
  }

  function renderDetail() {
    detailEl.replaceChildren();
    msgEl = null;
    focusEl = null;

    const target = findEmployee(selectedCode);
    // 選んでいた社員が、読み直したらいなくなっていた（別の管理者が消したなど）
    if (MODES_WITH_TARGET.has(mode) && !target) {
      selectedCode = null;
      mode = "none";
      markSelected();
    }

    let nodes;
    switch (mode) {
      case "new":               nodes = formView(null); break;
      case "detail":            nodes = formView(target); break;
      case "password":          nodes = passwordView(); break;
      case "confirmReset":      nodes = resetConfirmView(target); break;
      case "confirmDeactivate": nodes = deactivateConfirmView(target); break;
      case "confirmDelete":     nodes = deleteConfirmView(target); break;
      default:                  nodes = noneView(); break;
    }

    detailEl.append(...nodes.flat(Infinity).filter(Boolean));
    applyMessage();
    syncControls();
    if (focusEl) focusEl.focus();
  }

  function noneView() {
    return [
      h("p", { class: "emp-empty" }, "社員を選んでください"),
      makeMessageEl(),
    ];
  }

  function field(label, control) {
    return h("label", { class: "emp-field" }, h("span", { class: "emp-label" }, label), control);
  }

  // 部署の欄：今ある部署から選ぶか、「新しい部署…」を選んで入れる
  // （打ち間違いで部署が分かれると、集計の人数が足りずに表示されなくなるため、まず選ばせる）
  function departmentField(current, isNew) {
    const names = departments.filter((d) => typeof d === "string");
    // 退職者だけの部署の社員を直すときも、今の部署を選んだままにする
    if (!isNew && current !== "" && !names.includes(current)) names.push(current);

    const select = h("select", { class: "emp-input" },
      isNew ? h("option", { value: "", selected: true }, "部署を選んでください") : null,
      names.map((name) => h("option", { value: name, selected: !isNew && name === current }, name)),
      h("option", { "data-new": "1" }, NEW_DEPARTMENT_LABEL)
    );
    const typed = h("input", {
      type: "text", class: "emp-input", placeholder: "新しい部署の名前", autocomplete: "off", hidden: true,
    });

    const usingNew = () => select.selectedOptions[0]?.dataset.new === "1";
    select.addEventListener("change", () => {
      typed.hidden = !usingNew();
      if (usingNew()) typed.focus();
    });

    return {
      node: h("label", { class: "emp-field" }, h("span", { class: "emp-label" }, "部署"), select, typed),
      read: () => (usingNew() ? typed.value : select.value),
    };
  }

  // 登録（target が null）と、社員を選んだとき
  function formView(target) {
    const isNew = target === null;
    const actions = isNew ? null : Rules.allowedActions(target, selfCode, Rules.countActiveAdmins(employees));

    const codeInput = isNew
      ? h("input", { type: "text", class: "emp-input", maxlength: "20", autocomplete: "off", spellcheck: "false" })
      : null;
    const nameInput = h("input", {
      type: "text", class: "emp-input", autocomplete: "off", value: isNew ? "" : target.display_name,
    });
    const dept = departmentField(isNew ? "" : target.department, isNew);
    const newGradBox = h("input", { type: "checkbox", checked: !isNew && Boolean(target.is_new_grad) });

    // 最後の在籍の管理者・自分自身は、管理者から外せない（チェックを外せなくする）
    const lockAdmin = !isNew && Boolean(target.is_admin) && !actions.unsetAdmin;
    const adminBox = h("input", {
      type: "checkbox", checked: !isNew && Boolean(target.is_admin), disabled: lockAdmin,
    });

    const form = { codeInput, nameInput, dept, newGradBox, adminBox };
    const saveBtn = h("button", {
      type: "button",
      class: "emp-btn",
      onclick: () => (isNew ? submitCreate(form) : submitUpdate(target, form)),
    }, isNew ? "登録する" : "保存する");

    if (isNew) focusEl = codeInput;

    return [
      h("div", { class: "emp-title" }, isNew ? "新しい社員を登録" : `${target.employee_code} ${target.display_name}`),
      isNew
        ? field("社員ID", codeInput)
        : h("div", { class: "emp-field" }, h("span", { class: "emp-label" }, "社員ID"), h("div", { class: "emp-fixed" }, target.employee_code)),
      field("名前", nameInput),
      dept.node,
      h("div", { class: "emp-checks" },
        h("label", { class: "emp-check" }, newGradBox, "新卒"),
        h("label", { class: "emp-check" },
          adminBox,
          "管理者",
          lockAdmin ? h("span", { class: "emp-hint" }, actions.isSelf ? "（自分自身は外せません）" : "（最後の1人のため外せません）") : null
        )
      ),
      makeMessageEl(),
      h("div", { class: "emp-actions" }, saveBtn),
      isNew ? null : operationsView(target, actions),
    ];
  }

  // 在籍中なら「パスワードをリセット」「退職にする」、退職中なら「在籍に戻す」「消す」。
  // できない操作は押せなくして、理由を出す
  function operationsView(target, actions) {
    const buttons = target.is_active
      ? [
          h("button", { type: "button", class: "emp-btn sub", disabled: !actions.reset, onclick: () => goTo("confirmReset") }, "パスワードをリセット"),
          h("button", { type: "button", class: "emp-btn warn", disabled: !actions.deactivate, onclick: () => goTo("confirmDeactivate") }, "退職にする"),
        ]
      : [
          h("button", { type: "button", class: "emp-btn sub", disabled: !actions.reactivate, onclick: () => reactivate(target) }, "在籍に戻す"),
          h("button", { type: "button", class: "emp-btn warn", disabled: !actions.remove, onclick: () => goTo("confirmDelete") }, "消す"),
        ];

    let reason = "";
    if (actions.isSelf) reason = MSG_SELF;
    else if (target.is_active && target.is_admin && !actions.deactivate) reason = MSG_LAST_ADMIN;

    return [
      h("div", { class: "emp-actions spaced" }, buttons),
      reason ? h("p", { class: "emp-note" }, reason) : null,
    ];
  }

  // ①：仮のパスワード
  function passwordView() {
    const title = shown.kind === "create"
      ? `${shown.code} ${shown.name} を登録しました`
      : `${shown.code} ${shown.name} のパスワードをリセットしました`;
    return [
      h("div", { class: "emp-title" }, title),
      h("p", { class: "emp-hint" }, "仮のパスワード（この画面を閉じると、二度と表示されません）"),
      h("div", { class: "emp-pw" }, shown.password),
      h("p", { class: "emp-note" }, "本人に直接伝えてください。最初のログインで、本人が新しいパスワードに変えます。"),
      h("div", { class: "emp-actions right spaced" },
        h("button", { type: "button", class: "emp-btn", onclick: closePasswordPanel }, "伝えたので閉じる")
      ),
    ];
  }

  // 確認の場面の共通の形：見出し・何が起きるか・（間に入れるもの）・知らせ・ボタン
  function confirmView(title, lines, middle, buttons) {
    return [
      h("div", { class: "emp-title" }, title),
      h("div", { class: "emp-alert" }, lines.map((line) => h("p", {}, line))),
      middle,
      makeMessageEl(),
      h("div", { class: "emp-actions right" }, buttons),
    ];
  }

  function cancelButton() {
    return h("button", { type: "button", class: "emp-btn sub", onclick: () => goTo("detail") }, "やめる");
  }

  // ②：リセットの確認
  function resetConfirmView(target) {
    return confirmView(
      `${target.employee_code} ${target.display_name} のパスワードをリセットしますか？`,
      [
        "・この人のログインは、すべて切れます。",
        "・この人のつむぎの記憶は読めなくなり、消えます（元に戻せません）。",
      ],
      null,
      [cancelButton(), h("button", { type: "button", class: "emp-btn warn", onclick: () => resetPassword(target) }, "リセットする")]
    );
  }

  // 退職の確認
  function deactivateConfirmView(target) {
    return confirmView(
      `${target.employee_code} ${target.display_name} を退職にしますか？`,
      [
        "・この人は、すぐにログインできなくなります。",
        "・いまログインしているものも、すべて切れます。",
        "・あとで「在籍に戻す」と、同じパスワードでまたログインできます。",
      ],
      null,
      [cancelButton(), h("button", { type: "button", class: "emp-btn warn", onclick: () => deactivate(target) }, "退職にする")]
    );
  }

  // ③：消すときの確認。社員IDを打ち込むと、初めて「消す」が押せる
  function deleteConfirmView(target) {
    const typed = h("input", {
      type: "text", class: "emp-input", autocomplete: "off", spellcheck: "false", "aria-label": "確かめのための社員ID",
    });
    const removeBtn = h("button", {
      type: "button", class: "emp-btn danger", disabled: true, onclick: () => remove(target, typed),
    }, "消す");
    typed.addEventListener("input", () => {
      removeBtn.disabled = !Rules.canConfirmDelete(target, typed.value);
    });
    focusEl = typed;

    return confirmView(
      `${target.employee_code} ${target.display_name} を消しますか？`,
      [
        "この人の社員の情報と、感情ログがすべて消えます。元に戻せません。",
        "集計の数字も変わります。",
      ],
      h("div", { class: "emp-field" },
        h("span", { class: "emp-hint" }, `確かめるため、社員ID「${target.employee_code}」を入れてください`),
        typed
      ),
      [cancelButton(), removeBtn]
    );
  }

  // =========================================
  // 操作（送る前に確かめ、送って、終わったら一覧を読み直す）
  // =========================================

  function submitCreate(form) {
    const check = Rules.validateEmployeeForm({
      code: form.codeInput.value,
      name: form.nameInput.value,
      department: form.dept.read(),
      isNew: true,
    });
    if (!check.ok) {
      showMessage(check.message, "error");
      return;
    }
    const v = check.values;
    perform(
      () => callServer("/admin_employee_create.php", "POST", {
        employee_code: v.code,
        display_name: v.name,
        department: v.department,
        is_new_grad: form.newGradBox.checked,
        is_admin: form.adminBox.checked,
      }),
      (res) => finishWithPassword(res, "create", v.code, v.name)
    );
  }

  function submitUpdate(target, form) {
    const check = Rules.validateEmployeeForm({
      code: target.employee_code,
      name: form.nameInput.value,
      department: form.dept.read(),
      isNew: false,
    });
    if (!check.ok) {
      showMessage(check.message, "error");
      return;
    }
    const v = check.values;
    perform(
      () => callServer("/admin_employee_update.php", "POST", {
        employee_code: target.employee_code,
        display_name: v.name,
        department: v.department,
        is_new_grad: form.newGradBox.checked,
        is_admin: form.adminBox.checked,
      }),
      () => finishWith(target.employee_code, "保存しました")
    );
  }

  function resetPassword(target) {
    perform(
      () => callServer("/admin_employee_reset.php", "POST", { employee_code: target.employee_code }),
      (res) => finishWithPassword(res, "reset", target.employee_code, target.display_name)
    );
  }

  function deactivate(target) {
    perform(
      () => callServer("/admin_employee_status.php", "POST", { employee_code: target.employee_code, is_active: false }),
      () => finishWith(target.employee_code, "退職にしました")
    );
  }

  function reactivate(target) {
    perform(
      () => callServer("/admin_employee_status.php", "POST", { employee_code: target.employee_code, is_active: true }),
      () => finishWith(target.employee_code, "在籍に戻しました")
    );
  }

  function remove(target, typed) {
    if (!Rules.canConfirmDelete(target, typed.value)) return;
    const confirmCode = typed.value.trim();
    perform(
      () => callServer("/admin_employee_delete.php", "POST", { employee_code: target.employee_code, confirm_code: confirmCode }),
      () => finishWith(null, `${target.employee_code} ${target.display_name} を消しました`)
    );
  }

  // =========================================
  // 入口
  // =========================================

  // 「社員」タブを初めて開いたときに admin-dashboard.js が呼ぶ。
  // 一覧を読めなかったときの「もう一度読み込む」も、これを呼ぶ
  async function loadEmployeesTab() {
    // 送っている途中・読んでいる途中・①の表示中の押し直しは受けない
    // （送っている途中に読み直すと、操作のあとの描き直しが古い一覧で行われるため。
    //   ①の表示中は、読み直しで 401 になるとログアウトして①ごと消えるため。①を閉じたときに読み直す）
    if (busy || loading || mode === "password") return;
    listError = "";   // 前の失敗を消す（「読み込み中…」を出し、「もう一度読み込む」を押し直せなくする）
    await reloadEmployees(true);
    // 選んでいた社員がいなくなっていたら、何も選んでいない場面に戻す（①の表示中は触らない）
    if (mode !== "password" && selectedCode !== null && !findEmployee(selectedCode)) {
      selectedCode = null;
      mode = "none";
      markSelected();
      renderDetail();
    }
  }

  function init() {
    searchEl = document.getElementById("employeeSearch");
    newBtn = document.getElementById("employeeNewBtn");
    listEl = document.getElementById("employeeList");
    detailEl = document.getElementById("employeeDetail");
    summaryTabBtn = document.getElementById("tabSummaryBtn");
    backBtn = document.getElementById("adminBackBtn");

    searchEl.addEventListener("input", renderList);
    newBtn.addEventListener("click", startNew);
    listEl.addEventListener("click", (event) => {
      const row = event.target.closest(".emp-row");
      if (row) selectEmployee(row.dataset.code);
    });

    renderDetail();   // 「社員を選んでください」（newBtn も、一覧を読めるまでは押せない）
  }

  window.loadEmployeesTab = loadEmployeesTab;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
