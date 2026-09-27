-- 部署时清掉 admin 的登录失败计数（流水线「Clear admin lockout」一步执行，test/cr-auth-limits.sh 也跑这一份）。
--
-- 连错 5 次会锁 10 分钟，人在网页上试错几次就足以让整条流水线登不进去，所以每次部署先清。
-- CR-M3 之后计数按「用户名|来源 IP」记，admin 在每个 IP 上各有一行，要按前缀清；
-- 等号那一条清的是之前按纯用户名记下的旧行。用 substr 比前缀，不用 LIKE（下划线是通配符）。
DELETE FROM login_attempts
 WHERE username = 'admin' OR substr(username, 1, 6) = 'admin|';
