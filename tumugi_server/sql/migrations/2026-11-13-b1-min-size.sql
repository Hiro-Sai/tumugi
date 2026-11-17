-- =========================================
-- 最低人数の守りのすり抜け対策（B1）のための移行（2026-11-13）
-- 今ある DB に、1回だけ流す。
-- 社員に、集計に入れ始める時刻（counted_from）を足し、今いる社員は登録の時刻（created_at）にする。
-- 感情ログに、記録した時点の部署・新卒の印・集計に入れるかの印を足し、
-- 今までの記録には、今の所属を写す（集計に入れるかは、管理者か、登録から7日以内の記録を 0 にする）。
-- あわせて、本人あての知らせのテーブルを作る。
-- 2回目に流すと、最初の文（①）が "Duplicate column" で止まる。
-- ただし、これは「もう済んでいる」とは限らない（途中で止まったときも、2回目は ① で同じエラーになる）。
-- 済んだかどうかは、下の「全部済んだかの見分け方」で確かめる。止まっていたら、止まった所から後ろの文を手で流す。
-- 手順は README の「今ある DB に、最低人数の守りの修正を足すとき」を見る。
-- schema.sql にも同じ内容が入っている（新しく作る DB は、最初からこの形になる）。
--
-- 全部済んだかの見分け方：いちばん最後に流す文（⑥ 知らせのテーブル）が作る表と、
-- いちばん最初に流す文（① counted_from）が作る列が、どちらもあれば済んでいる。
--   SHOW TABLES LIKE 'employee_notices';
--   SHOW COLUMNS FROM employees LIKE 'counted_from';
-- 表が出ないときは、⑥ まで流れていない（途中で止まっている）。
--
-- 社員が使っていない時間に、コードの更新とあわせて続けて流すこと。
-- コードだけ新しい間（列がまだない間）は、記録の保存などが失敗する。
-- =========================================

SET NAMES utf8mb4;

-- ① 社員に、集計に入れ始める時刻を足す（schema.sql と同じ型・既定・位置）
ALTER TABLE employees
  ADD COLUMN counted_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER created_at;

-- ② 今いる社員は、登録の時刻から数える
UPDATE employees SET counted_from = created_at;

-- ③ 感情ログに3つの列を足す（department は、写し終わるまで NULL を許す）
ALTER TABLE emotion_logs
  ADD COLUMN department  VARCHAR(50) NULL AFTER harassment_type,
  ADD COLUMN is_new_grad TINYINT(1)  NOT NULL DEFAULT 0 AFTER department,
  ADD COLUMN is_counted  TINYINT(1)  NOT NULL DEFAULT 1 AFTER is_new_grad;

-- ④ 今までの記録に、今の所属を写す。
--    管理者の記録と、その社員の登録から7日以内の記録は、集計に入れない
UPDATE emotion_logs l
  JOIN employees e ON e.id = l.employee_id
SET l.department  = e.department,
    l.is_new_grad = e.is_new_grad,
    l.is_counted  = IF(e.is_admin = 1 OR l.recorded_at < e.created_at + INTERVAL 7 DAY, 0, 1);

-- ⑤ department を必須にする
ALTER TABLE emotion_logs
  MODIFY COLUMN department VARCHAR(50) NOT NULL;

-- ⑥ 本人あての知らせ（いちばん最後に流す文）
CREATE TABLE IF NOT EXISTS employee_notices (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  employee_id  INT         NOT NULL,
  kind         VARCHAR(20) NOT NULL,
  old_value    VARCHAR(50) NULL,
  new_value    VARCHAR(50) NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_at      DATETIME    NULL,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_employee_created (employee_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
