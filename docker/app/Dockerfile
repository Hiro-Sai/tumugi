# =========================================
# つむぎ API サーバー（PHP 8.4 + Apache）
# app サービスと seed サービスの両方がこのイメージを使う。
# =========================================
FROM php:8.4-apache

RUN docker-php-ext-install pdo_mysql

# 本番用の php.ini（display_errors=Off）を使う。
# 公式イメージは何も指定しないとエラーの内容を画面に出してしまうため。
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && echo "date.timezone = Asia/Tokyo" > "$PHP_INI_DIR/conf.d/zz-tumugi.ini"

# /api だけを公開する Apache 設定
COPY apache.conf /etc/apache2/sites-available/000-default.conf
RUN mkdir -p /var/www/empty \
 && echo "ServerName localhost" > /etc/apache2/conf-available/servername.conf \
 && a2enconf servername
