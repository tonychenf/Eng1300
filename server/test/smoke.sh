#!/usr/bin/env bash
# End-to-end smoke test for the MVP auth/permission server.
# Boots a throwaway instance against a temp DB, exercises the login and
# role-based access flows, and asserts on the responses.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TMP_DIR="$(mktemp -d)"
export DB_PATH="$TMP_DIR/test.db"
export JWT_SECRET="test-secret-do-not-use-in-prod"
export SUPERADMIN_USERNAME="admin"
export SUPERADMIN_PASSWORD="admin-test-pass-123"
export PORT=8799
BASE="http://localhost:$PORT/api"

PASS=0
FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1))
    echo "  OK   $desc"
  else
    FAIL=$((FAIL+1))
    echo "  FAIL $desc (expected $want, got $got)"
  fi
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "== seeding super admin =="
node src/seed.js

echo "== starting server on :$PORT =="
node src/server.js > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 20); do
  curl -s -o /dev/null "$BASE/health" && break
  sleep 0.2
done

echo "== 1. super admin login =="
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$SUPERADMIN_USERNAME\",\"password\":\"$SUPERADMIN_PASSWORD\"}")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check "super admin login returns 200" "$CODE" "200"
ADMIN_TOKEN=$(echo "$BODY" | jq -r '.token')
check "super admin role in login response" "$(echo "$BODY" | jq -r '.user.role')" "SUPER_ADMIN"

echo "== 2. normal user cannot log in with wrong password =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"wrong"}')
check "wrong password rejected (401)" "$CODE" "401"

echo "== 3. super admin creates a normal user =="
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/admin/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"username":"student1"}')
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check "create user returns 201" "$CODE" "201"
STUDENT_PASS=$(echo "$BODY" | jq -r '.initialPassword')
STUDENT_ID=$(echo "$BODY" | jq -r '.user.id')

echo "== 4. normal user logs in =="
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"student1\",\"password\":\"$STUDENT_PASS\"}")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check "student login returns 200" "$CODE" "200"
STUDENT_TOKEN=$(echo "$BODY" | jq -r '.token')
check "student role in login response" "$(echo "$BODY" | jq -r '.user.role')" "USER"

echo "== 5. normal user is denied admin routes =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/users" \
  -H "Authorization: Bearer $STUDENT_TOKEN")
check "student blocked from /admin/users (403)" "$CODE" "403"

echo "== 6. normal user can read own profile via /me =="
RESP=$(curl -s -w '\n%{http_code}' "$BASE/me" -H "Authorization: Bearer $STUDENT_TOKEN")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check "/me returns 200 for student" "$CODE" "200"
check "/me reflects USER role" "$(echo "$BODY" | jq -r '.user.role')" "USER"

echo "== 7. no token at all is rejected =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/me")
check "missing token rejected (401)" "$CODE" "401"

echo "== 8. super admin can list users and sees student1 =="
RESP=$(curl -s -w '\n%{http_code}' "$BASE/admin/users" -H "Authorization: Bearer $ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check "admin list users returns 200" "$CODE" "200"
FOUND=$(echo "$BODY" | jq -r '.users[] | select(.username=="student1") | .username')
check "student1 present in user list" "$FOUND" "student1"

echo "== 9. super admin resets student1's password =="
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE/admin/users/$STUDENT_ID/reset-password" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
CODE=$(echo "$RESP" | tail -1); BODY=$(echo "$RESP" | sed '$d')
check "reset password returns 200" "$CODE" "200"
NEW_PASS=$(echo "$BODY" | jq -r '.newPassword')

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"student1\",\"password\":\"$STUDENT_PASS\"}")
check "old password no longer works" "$CODE" "401"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"student1\",\"password\":\"$NEW_PASS\"}")
check "new password works" "$CODE" "200"

echo "== 10. super admin disables student1 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/admin/users/$STUDENT_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"disabled":true}')
check "disable user returns 200" "$CODE" "200"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"student1\",\"password\":\"$NEW_PASS\"}")
check "disabled account cannot log in (403)" "$CODE" "403"

echo "== 11. super admin account cannot be disabled via API =="
ADMIN_ID=$(curl -s "$BASE/admin/users" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.users[] | select(.username=="admin") | .id')
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/admin/users/$ADMIN_ID/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"disabled":true}')
check "disabling super admin rejected (400)" "$CODE" "400"

echo
echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
