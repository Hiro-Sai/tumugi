"use strict";
// 5.6 ダッシュボード（dashboard_data.php）
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  api,
  fixture,
  resetDb,
  randomValue,
  ensureEnvironment,
  loginAs,
  seedAdmin,
} = require("./helpers");

before(ensureEnvironment);
beforeEach(resetDb);

// 社員は fixture で直接入れる（ログインしない）。パスワードは全員同じ
const PW = randomValue();

// 社員を1人入れる命令（と、ログがあればログの命令）
// countedDaysAgo は、集計に入れ始める時刻（counted_from）からの日数（省略すると fixture の既定の30日）、
// admin は管理者の印。logs の is_counted を省くと、fixture が本番と同じ決め方（管理者か、
// counted_from から7日以内なら 0）で入れる
function person(
  code,
  department,
  { logs = [], grad = false, active = true, countedDaysAgo, admin = false } = {}
) {
  const add = {
    op: "add_employee",
    code,
    department,
    pw: PW,
    is_new_grad: grad,
    is_active: active,
    is_admin: admin,
  };
  if (countedDaysAgo !== undefined) {
    add.counted_days_ago = countedDaysAgo;
  }
  const commands = [add];
  if (logs.length > 0) {
    commands.push({ op: "add_logs", code, logs });
  }
  return commands;
}

// 同じ部署に count 人。make(i) は i 番目（1から）の社員の設定
function group(prefix, department, count, make = () => ({})) {
  const commands = [];
  for (let i = 1; i <= count; i += 1) {
    commands.push(...person(`${prefix}${String(i).padStart(3, "0")}`, department, make(i)));
  }
  return commands;
}

// 管理者を入れてログインし、ダッシュボードを取る道具を返す
async function setup() {
  const admin = seedAdmin();
  const token = await loginAs(admin.code, admin.pw);
  return {
    token,
    async get() {
      const res = await api("GET", "/dashboard_data.php", { token });
      assert.equal(res.status, 200);
      return res.json;
    },
    // 管理者として、社員の部署と新卒の印を変える（API を通す）
    async update(code, department, isNewGrad = false) {
      const res = await api("POST", "/admin_employee_update.php", {
        token,
        body: {
          employee_code: code,
          display_name: `テスト${code}`,
          department,
          is_new_grad: isNewGrad,
          is_admin: false,
        },
      });
      assert.equal(res.status, 200);
    },
  };
}

const one = (log) => [log];

test("記録のある在籍社員が9名の部署は出ない（出せる部署がないので note が入る）。10名目が入ると出る", async () => {
  const dash = await setup();
  // 1人2行ずつ。記録は18行あるが、人は9名（記録の数ではなく、人数で数えることを確かめる）
  fixture(group("E", "営業部", 9, () => ({ logs: [{}, {}] })));
  const before10 = await dash.get();
  assert.deepEqual(before10.departments, []);
  assert.equal(typeof before10.note, "string");

  // 同じ部署に10名目が入ると、出る（note は null）
  fixture(person("E010", "営業部", { logs: one({}) }));
  const after10 = await dash.get();
  assert.equal(after10.departments.length, 1);
  assert.equal(after10.departments[0].department, "営業部");
  assert.equal(after10.note, null);
});

test("10名の部署は出る。min_dept_size は 10", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, () => ({ logs: one({}) })));
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  assert.equal(body.departments[0].department, "営業部");
  assert.equal(body.min_dept_size, 10);
  assert.equal(body.note, null);
});

test("記録のない社員は人数に入らない（在籍10名でも、記録のある人が9名なら出ない）", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, (i) => (i <= 9 ? { logs: one({}) } : {})));
  const body = await dash.get();
  assert.deepEqual(body.departments, []);
  assert.equal(typeof body.note, "string");
});

test("平均は社員ごとの平均の平均（1人が sad を10行、9人が happy を1行なら 7.0）", async () => {
  const dash = await setup();
  const sad = Array.from({ length: 10 }, () => ({ emotion: "sad", score: 70 }));
  const happy = [{ emotion: "happy", score: 0 }];
  fixture(group("E", "営業部", 10, (i) => ({ logs: i === 1 ? sad : happy })));
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  // 記録の数で重みを付けると 36.8 になる
  assert.equal(Number(body.departments[0].avg_score), 7);
});

test("avg_score は小数1桁（社員ごとの平均 6.67 と 0 の平均 0.666… は 0.7）", async () => {
  const dash = await setup();
  const mixed = [
    { emotion: "normal", score: 10 },
    { emotion: "normal", score: 10 },
    { emotion: "happy", score: 0 },
  ];
  const happy = [{ emotion: "happy", score: 0 }];
  fixture(group("E", "営業部", 10, (i) => ({ logs: i === 1 ? mixed : happy })));
  const body = await dash.get();
  assert.equal(body.departments[0].avg_score, "0.7");
  assert.equal(Number(body.departments[0].avg_score), 0.7);
});

test("log_count はその部署の記録の数", async () => {
  const dash = await setup();
  // 1人目は1行、2人目は2行、…10人目は10行 → 合計55
  fixture(
    group("E", "営業部", 10, (i) => ({
      logs: Array.from({ length: i }, () => ({})),
    }))
  );
  const body = await dash.get();
  assert.equal(body.departments[0].log_count, 55);
});

test("部署ごとに別々に数える（営業部10名と開発部9名なら、営業部だけ出る）", async () => {
  const dash = await setup();
  fixture([
    ...group("E", "営業部", 10, () => ({ logs: one({ score: 20 }) })),
    ...group("F", "開発部", 9, () => ({ logs: one({ score: 50 }) })),
  ]);
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  assert.equal(body.departments[0].department, "営業部");
  assert.equal(Number(body.departments[0].avg_score), 20);
});

test("8日前の記録は入らない（8日前だけの人がいると10名の部署が出ない）。6日前なら入る", async () => {
  const dash = await setup();
  fixture([
    ...group("E", "営業部", 9, () => ({ logs: one({}) })),
    ...person("E010", "営業部", { logs: one({ days_ago: 8 }) }),
  ]);
  const before6 = await dash.get();
  assert.deepEqual(before6.departments, []);

  // 同じ人に6日前の記録を足すと、部署が出る
  fixture([{ op: "add_logs", code: "E010", logs: one({ days_ago: 6 }) }]);
  const after6 = await dash.get();
  assert.equal(after6.departments.length, 1);
  assert.equal(after6.departments[0].department, "営業部");
});

test("8日前の記録は平均にも記録の数にも入らない。6日前の記録は入る", async () => {
  const dash = await setup();
  const first = [
    { score: 40, days_ago: 6 },
    { score: 100, days_ago: 8 },
  ];
  fixture(group("E", "営業部", 10, (i) => ({ logs: i === 1 ? first : one({ score: 0 }) })));
  const body = await dash.get();
  // 1人目の平均は 40（8日前の 100 は入らない）。全体は (40 + 0×9) / 10 = 4.0
  assert.equal(Number(body.departments[0].avg_score), 4);
  assert.equal(body.departments[0].log_count, 10);
});

test("退職にしても、その場では集計が変わらない（10名の部署は出たまま）。在籍に戻しても同じ", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, () => ({ logs: one({}) })));
  const active = await dash.get();
  assert.equal(active.departments.length, 1);

  // 退職にしても、記録した時点の所属で数えるので、人数は減らない（差から1人の値が分からない）
  fixture([{ op: "set_active", code: "E010", is_active: false }]);
  const retired = await dash.get();
  assert.deepEqual(retired.departments, active.departments);

  // 在籍に戻しても同じ
  fixture([{ op: "set_active", code: "E010", is_active: true }]);
  const back = await dash.get();
  assert.deepEqual(back.departments, active.departments);
});

test("退職にした社員の、直近7日の記録は、平均・記録の数・危機に入ったまま", async () => {
  const dash = await setup();
  const retiredLogs = [
    { score: 100, is_crisis: true },
    { score: 100, is_crisis: true },
    { score: 100, is_crisis: true },
  ];
  fixture([
    ...group("E", "営業部", 10, () => ({ logs: one({ score: 0 }) })),
    ...person("R001", "営業部", { logs: retiredLogs, active: false }),
  ]);
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  // 11人：社員ごとの平均は、10人が 0、退職の1人が 100 → 100 / 11 = 9.09… → 9.1
  assert.equal(body.departments[0].avg_score, "9.1");
  // 記録は 10 + 3 = 13 行
  assert.equal(body.departments[0].log_count, 13);
  // 危機の人は退職の1人だけ → 人数は出さない
  assert.deepEqual(body.departments[0].crisis, { display: "flag_only" });
});

test("管理者の記録は、人数に入らない（社員9名＋管理者1名の部署は出ない）", async () => {
  const dash = await setup();
  // 管理者と同じ部署（管理部）に、記録のある社員が9名。管理者にも記録があるが、人数には入らない
  fixture([
    ...group("G", "管理部", 9, () => ({ logs: one({}) })),
    { op: "add_logs", code: "A001", logs: one({}) },
  ]);
  const body = await dash.get();
  assert.deepEqual(body.departments, []);
  assert.equal(typeof body.note, "string");

  // 社員が10名目になると、出る（管理者の記録は数に入らないまま）
  fixture(person("G010", "管理部", { logs: one({}) }));
  const ten = await dash.get();
  assert.equal(ten.departments.length, 1);
  assert.equal(ten.departments[0].department, "管理部");
  assert.equal(ten.departments[0].log_count, 10);
});

test("部署の危機：該当者が0人なら none", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, () => ({ logs: one({}) })));
  const body = await dash.get();
  assert.deepEqual(body.departments[0].crisis, { display: "none" });
});

test("部署の危機：1人なら flag_only（件数は返らない。その人の記録が複数でも同じ）", async () => {
  const dash = await setup();
  const crisis = [
    { score: 100, is_crisis: true },
    { score: 100, is_crisis: true },
  ];
  fixture(group("E", "営業部", 10, (i) => ({ logs: i === 1 ? crisis : one({}) })));
  const body = await dash.get();
  const result = body.departments[0].crisis;
  assert.equal(result.display, "flag_only");
  assert.equal("count" in result, false);
  assert.deepEqual(result, { display: "flag_only" });
});

test("部署の危機：9人まで flag_only（件数は返らない）、10人で count（件数が返る）", async () => {
  const dash = await setup();
  const crisis = { score: 100, is_crisis: true };
  // 10名のうち9人が危機。1人目は2行（危機の記録は全部で10行）
  fixture(
    group("E", "営業部", 10, (i) => {
      if (i === 1) return { logs: [crisis, crisis] };
      return { logs: i <= 9 ? one(crisis) : one({}) };
    })
  );
  const nine = await dash.get();
  assert.deepEqual(nine.departments[0].crisis, { display: "flag_only" });

  // 10人目も危機にすると count になり、危機の記録の数（11）が返る
  fixture([{ op: "add_logs", code: "E010", logs: one(crisis) }]);
  const ten = await dash.get();
  assert.deepEqual(ten.departments[0].crisis, { display: "count", count: 11 });
});

test("新卒：記録のある新卒が9名なら new_grad は null で new_grad_note が入る。10名目で出る", async () => {
  const dash = await setup();
  // 新卒9名を3つの部署に分ける。新卒でない社員は人数に入らない
  // 1人2行ずつ。記録は18行あるが、人は9名（記録の数ではなく、人数で数えることを確かめる）
  fixture([
    ...group("E", "営業部", 3, () => ({ grad: true, logs: [{}, {}] })),
    ...group("F", "開発部", 3, () => ({ grad: true, logs: [{}, {}] })),
    ...group("G", "総務部", 3, () => ({ grad: true, logs: [{}, {}] })),
    ...person("H001", "総務部", { logs: one({}) }),
  ]);
  const nine = await dash.get();
  assert.equal(nine.new_grad, null);
  assert.equal(typeof nine.new_grad_note, "string");

  // 別の部署の新卒が1人増えて10名になると、出る
  fixture(person("I001", "人事部", { grad: true, logs: one({}) }));
  const ten = await dash.get();
  assert.notEqual(ten.new_grad, null);
  assert.equal(ten.new_grad_note, null);
});

test("新卒：10名なら、部署をまたいだ平均・記録の数・危機が返る", async () => {
  const dash = await setup();
  // 営業部の新卒6名（score 10 を2行ずつ）と開発部の新卒4名（score 20 を1行ずつ）。どちらの部署も10名未満
  // 新卒でない社員（score 100）は入らない
  fixture([
    ...group("E", "営業部", 6, (i) => ({
      grad: true,
      logs: i === 1 ? [{ score: 10, is_crisis: true }, { score: 10 }] : [{ score: 10 }, { score: 10 }],
    })),
    ...group("F", "開発部", 4, () => ({ grad: true, logs: one({ score: 20 }) })),
    ...person("H001", "営業部", { logs: one({ score: 100 }) }),
  ]);
  const body = await dash.get();
  assert.deepEqual(body.departments, []);
  assert.equal(body.new_grad_note, null);
  // 社員ごとの平均：営業部6人は 10、開発部4人は 20 → (60 + 80) / 10 = 14.0
  assert.equal(body.new_grad.avg_score, "14.0");
  assert.equal(body.new_grad.log_count, 16);
  // 危機は1人だけ → 人数は出さない
  assert.deepEqual(body.new_grad.crisis, { display: "flag_only" });
});

test("ハラスメント：受けた9人＋言った1人は、どちらも flag_only（件数は返らない）", async () => {
  const dash = await setup();
  // 受けた9人は2行ずつ（18行）、言った1人は10行。記録は10行以上あるが、人は9人と1人
  // （記録の数ではなく、人数で決めることを確かめる）
  fixture(
    group("E", "営業部", 10, (i) => ({
      logs:
        i <= 9
          ? [{ harassment: "received" }, { harassment: "received" }]
          : Array.from({ length: 10 }, () => ({ harassment: "said" })),
    }))
  );
  const body = await dash.get();
  assert.deepEqual(body.harassment.received, { display: "flag_only" });
  assert.deepEqual(body.harassment.said, { display: "flag_only" });
});

test("ハラスメント：8日前の記録は数えない（10人とも8日前だけなら none）。6日前なら count", async () => {
  const dash = await setup();
  // 全員、今日のふつうの記録と、8日前の「受けた」の記録
  fixture(
    group("E", "営業部", 10, () => ({
      logs: [{}, { harassment: "received", days_ago: 8 }],
    }))
  );
  const old = await dash.get();
  assert.deepEqual(old.harassment.received, { display: "none" });

  // 同じ10人に、6日前の「受けた」を足すと、数える
  fixture(
    Array.from({ length: 10 }, (_, i) => ({
      op: "add_logs",
      code: `E${String(i + 1).padStart(3, "0")}`,
      logs: [{ harassment: "received", days_ago: 6 }],
    }))
  );
  const recent = await dash.get();
  assert.deepEqual(recent.harassment.received, { display: "count", count: 10 });
});

test("ハラスメント：同じ種類が10人で count（記録の数が返る）。もう一方が0人なら none", async () => {
  const dash = await setup();
  fixture(
    group("E", "営業部", 10, (i) => ({
      logs: i === 1 ? [{ harassment: "received" }, { harassment: "received" }] : one({ harassment: "received" }),
    }))
  );
  const body = await dash.get();
  assert.deepEqual(body.harassment.received, { display: "count", count: 11 });
  assert.deepEqual(body.harassment.said, { display: "none" });
});

test("ハラスメント：記録がなければ、どちらも none", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, () => ({ logs: one({}) })));
  const body = await dash.get();
  assert.deepEqual(body.harassment, {
    received: { display: "none" },
    said: { display: "none" },
  });
});

test("ハラスメント：退職にしても、その場では変わらない（10人のうち1人が退職でも count のまま）", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, () => ({ logs: one({ harassment: "received" }) })));
  const active = await dash.get();
  assert.deepEqual(active.harassment.received, { display: "count", count: 10 });

  fixture([{ op: "set_active", code: "E010", is_active: false }]);
  const retired = await dash.get();
  assert.deepEqual(retired.harassment.received, { display: "count", count: 10 });

  // 在籍に戻しても同じ
  fixture([{ op: "set_active", code: "E010", is_active: true }]);
  const back = await dash.get();
  assert.deepEqual(back.harassment.received, { display: "count", count: 10 });
});

test("部署を変えても、その場では集計が変わらない（11名の部署から1人を開発部へ移しても同じ）", async () => {
  const dash = await setup();
  // 営業部11名。1人（E001）だけ score 100、ほかは 0
  fixture(group("E", "営業部", 11, (i) => ({ logs: one({ score: i === 1 ? 100 : 0 }) })));
  const before = await dash.get();
  assert.equal(before.departments.length, 1);
  // 社員ごとの平均：100 / 11 = 9.09… → 9.1。記録は11行
  assert.equal(before.departments[0].avg_score, "9.1");
  assert.equal(before.departments[0].log_count, 11);

  // 部署を変えても、記録に入った所属は変わらないので、営業部は11名のまま
  await dash.update("E001", "開発部");
  const after = await dash.get();
  assert.equal(after.departments.length, 1);
  assert.equal(after.departments[0].department, "営業部");
  assert.equal(after.departments[0].avg_score, "9.1");
  assert.equal(after.departments[0].log_count, 11);
  assert.deepEqual(after.departments, before.departments);
});

test("変えたあとの記録は、新しい部署に入る（前の記録は、前の部署に残る）", async () => {
  const dash = await setup();
  // 営業部：E001〜E009 と M001 の10名。開発部：F001〜F009 の9名。みんな記録は1行
  fixture([
    ...group("E", "営業部", 9, () => ({ logs: one({}) })),
    ...person("M001", "営業部", { logs: one({}) }),
    ...group("F", "開発部", 9, () => ({ logs: one({}) })),
  ]);
  const before = await dash.get();
  assert.deepEqual(
    before.departments.map((d) => d.department),
    ["営業部"]
  );

  // M001 を開発部へ移し、移したあとに1件記録する（記録の所属は開発部）
  await dash.update("M001", "開発部");
  fixture([{ op: "add_logs", code: "M001", logs: one({ department: "開発部" }) }]);
  const after = await dash.get();
  const byName = Object.fromEntries(after.departments.map((d) => [d.department, d]));
  // 開発部は F の9名＋M001 の10名になって出る。記録は10行
  assert.equal(byName["開発部"].log_count, 10);
  // 営業部にも、M001 の前の記録が残る（10名のまま）。記録は10行
  assert.equal(byName["営業部"].log_count, 10);
  assert.equal(after.departments.length, 2);
});

test("新卒の印を変えても、その場では新卒の集計が変わらない", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, () => ({ grad: true, logs: one({ score: 20 }) })));
  const before = await dash.get();
  assert.notEqual(before.new_grad, null);
  assert.equal(before.new_grad.avg_score, "20.0");
  assert.equal(before.new_grad.log_count, 10);

  // 新卒の印を外しても、記録に入った印は変わらないので、新卒は10名のまま
  await dash.update("E001", "営業部", false);
  const after = await dash.get();
  assert.equal(after.new_grad_note, null);
  assert.deepEqual(after.new_grad, before.new_grad);
});

test("集計に入れ始める時刻から6日の社員は、人数に入らない（9名＋6日の1名は出ない）。8日なら入る", async () => {
  const dash = await setup();
  fixture([
    // 営業部：9名＋集計に入れ始める時刻から6日の1名（記録はみんな1行）
    ...group("E", "営業部", 9, () => ({ logs: one({}) })),
    ...person("E010", "営業部", { logs: one({}), countedDaysAgo: 6 }),
    // 開発部：9名＋集計に入れ始める時刻から8日の1名
    ...group("F", "開発部", 9, () => ({ logs: one({}) })),
    ...person("F010", "開発部", { logs: one({}), countedDaysAgo: 8 }),
  ]);
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  assert.equal(body.departments[0].department, "開発部");
  assert.equal(body.departments[0].log_count, 10);
});

test("待ちの間に入れた記録は、待ちが明けても集計に入らない（counted_from が8日前になっても10人目にならない）", async () => {
  const dash = await setup();
  // 9名＋E010。E010 の記録は、待ちの間に入れた記録（is_counted が 0）。いまは待ちが明けている（8日前）
  fixture([
    ...group("E", "営業部", 9, () => ({ logs: one({}) })),
    ...person("E010", "営業部", { countedDaysAgo: 8, logs: one({ is_counted: false }) }),
  ]);
  const body = await dash.get();
  // 時間がたって待ちが明けても、記録した時点で決まった印は動かない。9名のまま
  assert.deepEqual(body.departments, []);
  assert.equal(typeof body.note, "string");
});

test("集計に入れ始める時刻から6日の社員の記録は、平均・記録の数・危機・ハラスメントに入らない", async () => {
  const dash = await setup();
  // 営業部10名（score 0）＋集計に入れ始める時刻から6日の1名（score 100・危機・受けた）
  fixture([
    ...group("E", "営業部", 10, () => ({ logs: one({ score: 0 }) })),
    ...person("N001", "営業部", {
      countedDaysAgo: 6,
      logs: one({ score: 100, is_crisis: true, harassment: "received" }),
    }),
  ]);
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  assert.equal(Number(body.departments[0].avg_score), 0);
  assert.equal(body.departments[0].log_count, 10);
  assert.deepEqual(body.departments[0].crisis, { display: "none" });
  assert.deepEqual(body.harassment.received, { display: "none" });
});

test("管理者の記録は、平均・記録の数・危機・ハラスメントに入らない", async () => {
  const dash = await setup();
  // 営業部10名（score 0）＋同じ部署の管理者1名（score 100・危機・受けた）
  fixture([
    ...group("E", "営業部", 10, () => ({ logs: one({ score: 0 }) })),
    ...person("B001", "営業部", {
      admin: true,
      logs: one({ score: 100, is_crisis: true, harassment: "received" }),
    }),
  ]);
  const body = await dash.get();
  assert.equal(body.departments.length, 1);
  assert.equal(Number(body.departments[0].avg_score), 0);
  assert.equal(body.departments[0].log_count, 10);
  assert.deepEqual(body.departments[0].crisis, { display: "none" });
  assert.deepEqual(body.harassment.received, { display: "none" });
});

test("管理者の印をあとから付けても、その場では集計が変わらない", async () => {
  const dash = await setup();
  fixture(group("E", "営業部", 10, (i) => ({ logs: one({ score: i === 1 ? 100 : 0 }) })));
  const before = await dash.get();
  assert.equal(before.departments.length, 1);
  assert.equal(before.departments[0].avg_score, "10.0");
  assert.equal(before.departments[0].log_count, 10);

  // 記録の is_counted は、記録した時点で決まっているので、あとから印を付けても動かない
  fixture([{ op: "set_admin", code: "E001", is_admin: true }]);
  const after = await dash.get();
  assert.deepEqual(after.departments, before.departments);
  assert.deepEqual(after.harassment, before.harassment);
});

test("is_counted が 0 の記録は、新卒の集計にも入らない", async () => {
  const dash = await setup();
  // 新卒10名。10人目（G010）の記録は、数えない記録（is_counted が 0）だけ
  fixture([
    ...group("G", "営業部", 9, () => ({ grad: true, logs: one({ score: 20 }) })),
    ...person("G010", "営業部", { grad: true, logs: one({ score: 100, is_counted: false }) }),
  ]);
  const nine = await dash.get();
  assert.equal(nine.new_grad, null);
  assert.equal(typeof nine.new_grad_note, "string");

  // 数える記録が1行入ると10名になって出る。数えない記録は、記録の数にも平均にも入らない
  fixture([{ op: "add_logs", code: "G010", logs: one({ score: 20 }) }]);
  const ten = await dash.get();
  assert.notEqual(ten.new_grad, null);
  assert.equal(ten.new_grad.log_count, 10);
  assert.equal(ten.new_grad.avg_score, "20.0");
});

test("新卒：途中で印が変わった人は、新卒だった記録だけで1人と数える", async () => {
  const dash = await setup();
  // 新卒9名と、G010（新卒だったときの記録が1行、印が外れたあとの記録が1行）
  fixture([
    ...group("G", "営業部", 9, () => ({ grad: true, logs: one({ score: 20 }) })),
    ...person("G010", "営業部", {
      grad: true,
      logs: [{ score: 20 }, { score: 100, is_new_grad: false }],
    }),
  ]);
  const body = await dash.get();
  // 二重に数えず10名。新卒でない記録（100）は、記録の数にも平均にも入らない
  assert.notEqual(body.new_grad, null);
  assert.equal(body.new_grad.log_count, 10);
  assert.equal(body.new_grad.avg_score, "20.0");
});
