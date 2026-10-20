-- =========================================
-- つむぎ DBスキーマ（MySQL 8.4）
-- db コンテナの初回起動時（ボリュームが空のとき）だけ自動で実行される。
-- 構造を変えたら `docker compose down -v` で作り直すこと
-- （デモデータは seed が自動で再投入する）。
-- DB 自体は compose.yaml の MYSQL_DATABASE で作られるため、
-- CREATE DATABASE / USE はここに書かない。
-- =========================================

SET NAMES utf8mb4;

-- -----------------------------------------
-- 社員
-- -----------------------------------------
CREATE TABLE employees (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  employee_code  VARCHAR(20)  NOT NULL UNIQUE,      -- 社員ID（ログインID）
  password_hash  VARCHAR(255) NOT NULL,             -- password_hash() の結果
  display_name   VARCHAR(50)  NOT NULL,             -- 表示名（ダッシュボードには出さない）
  department     VARCHAR(50)  NOT NULL,             -- 部署名（集計単位）
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,   -- 在籍フラグ
  is_new_grad    TINYINT(1)   NOT NULL DEFAULT 0,   -- 新卒フラグ（新卒集計に使う）
  is_admin       TINYINT(1)   NOT NULL DEFAULT 0    -- 管理者フラグ（ダッシュボードを閲覧できる）
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------
-- 感情ログ（1回のAI応答ごとに1レコード）
-- -----------------------------------------
CREATE TABLE emotion_logs (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  employee_id       INT          NOT NULL,
  emotion           VARCHAR(20)  NOT NULL,                  -- ユーザーの気持ち happy/normal/tired/anxious/angry/sad（2026-10-15 より前は surprised/troubled もある）
  negativity_score  INT          NOT NULL,                  -- 0-100（includes/emotion_scores.php）
  is_crisis         TINYINT(1)   NOT NULL DEFAULT 0,        -- 危機検知フラグ
  recorded_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  harassment_type   ENUM('none','received','said') NOT NULL DEFAULT 'none',
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_employee_date (employee_id, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------
-- ログイン用トークン
-- -----------------------------------------
CREATE TABLE auth_tokens (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  employee_id  INT         NOT NULL,
  token        VARCHAR(64) NOT NULL UNIQUE,
  expires_at   DATETIME    NOT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX employee_id (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- -----------------------------------------
-- ログイン試行履歴（ブルートフォース対策）
-- -----------------------------------------
CREATE TABLE login_attempts (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  employee_code  VARCHAR(50) NOT NULL,
  succeeded      TINYINT(1)  NOT NULL DEFAULT 0,
  attempted_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_employee_time (employee_code, succeeded, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
