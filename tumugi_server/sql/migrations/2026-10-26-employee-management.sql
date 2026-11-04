-- =========================================
-- 社員の管理のための移行（2026-10-26）
-- 今ある DB に、1回だけ流す。
-- 2回目に流すと、最初の ALTER が "Duplicate column" で止まる。
-- それは「もう済んでいる」という意味なので、そのままでよい。
-- 流し方は README の「今ある DB に社員の管理を足すとき」に書いてある。
-- schema.sql にも同じ内容が入っている（新しく作る DB は、最初からこの形になる）。
-- =========================================

SET NAMES utf8mb4;

-- 仮のパスワードのままの社員の印（1：次のログインで変える）
ALTER TABLE employees
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER is_admin;

-- -----------------------------------------
-- 管理者の操作の記録（社員の管理）
-- 社員を消しても記録が残るよう、外部キーにせず社員IDを文字で持つ。
-- 仮のパスワードや、変えた値は入れない。
-- -----------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  admin_code   VARCHAR(20)  NOT NULL,   -- 操作した管理者の社員ID
  action       VARCHAR(20)  NOT NULL,   -- create / update / reset_password / deactivate / reactivate / delete
  target_code  VARCHAR(20)  NOT NULL,   -- 対象の社員ID
  detail       VARCHAR(255) NULL,       -- update のとき、変えた項目の名前（例：department,is_admin）。値は入れない
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
