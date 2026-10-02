#!/usr/bin/env python3
"""D1 整库导出文件的两件工具（CR-M6，2026-10-02）。只看结构，不打印任何数据。

  inspect <导出文件>          打印结构信息：语句种类和条数、各表在文件里的先后和位置、子表数据排在父表前面的、
                              最长的语句、超过 100 KB 的、触发器/视图、空字节/非法 UTF-8；再装进普通 SQLite
                              试几种导法：外键关着逐句执行、外键检查、完整性检查、外键开着整份一个事务（推迟到
                              提交时查）、外键开着每句单独提交（立刻查）。
  reorder <导出文件> <输出>   建表语句全放最前，数据按外键先父后子排；自己引用自己的表（knowledge_points 的
                              parent_tag_id），表里的行也先父后子。其余语句（建索引、自增计数、按原样补回的文本）
                              保持原来的相对顺序放在最后。输出前核对：语句一句不多一句不少。

为什么要重排：线上库跑过 N3 的旧表重建，questions、knowledge_points 被拆掉重建，在 sqlite_master 里排到了
它们的子表（作答、错题、题目-考点……）后面；导出按建表顺序写，备份里子表的数据就排在父表前面。导出文件开头的
PRAGMA defer_foreign_keys 只在一个事务里管用，导入要是分段提交，子表那段提交时父表的数据还没进来，外键对不上。
新建的库（本地测试、演练库）父表总在前面，所以从来碰不到。

为什么只打印结构：仓库是公开的，流水线日志谁都能看。表名、语句种类、字节数、行数可以打，任何一个值都不打；
SQLite 的报错里可能带出数据（unrecognized token: "'…"），引号里不像表名列名的东西一律涂掉。
"""
import collections
import re
import sqlite3
import sys

IDENT = re.compile(r'[A-Za-z0-9_]{1,64}')
HEAD = re.compile(r'(PRAGMA|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+TABLE|CREATE\s+TRIGGER|CREATE\s+VIEW'
                  r'|INSERT\s+INTO|DELETE\s+FROM|UPDATE|BEGIN|COMMIT)\b', re.I)
TABLE_OF = {
    'CREATE TABLE': re.compile(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z0-9_]+)', re.I),
    'INSERT': re.compile(r'INSERT\s+INTO\s+["`\[]?([A-Za-z0-9_]+)', re.I),
    'DELETE': re.compile(r'DELETE\s+FROM\s+["`\[]?([A-Za-z0-9_]+)', re.I),
    'UPDATE': re.compile(r'UPDATE\s+["`\[]?([A-Za-z0-9_]+)', re.I),
    'CREATE INDEX': re.compile(r'\bON\s+["`\[]?([A-Za-z0-9_]+)', re.I),
}


class Stmt:
    __slots__ = ('text', 'start', 'size', 'kind', 'table', 'pos')

    def __init__(self, text, start, size, pos):
        self.text, self.start, self.size, self.pos = text, start, size, pos
        body = '\n'.join(l for l in text.split('\n') if not l.lstrip().startswith('--')).strip()
        m = HEAD.match(body)
        kind = re.sub(r'\s+', ' ', m.group(1).upper()) if m else '其他'
        kind = {'INSERT INTO': 'INSERT', 'DELETE FROM': 'DELETE', 'CREATE UNIQUE INDEX': 'CREATE INDEX'}.get(kind, kind)
        self.kind = kind
        t = TABLE_OF.get(kind)
        tm = t.search(body) if t else None
        self.table = tm.group(1) if tm else ''


def read(path):
    raw = open(path, 'rb').read()
    text = raw.decode('utf-8', errors='surrogateescape')
    bad = sum(1 for ch in text if '\udc80' <= ch <= '\udcff')
    return raw, text, bad


def split(text):
    """按 SQLite 自己的判断切句：一行一行攒，攒到 complete_statement 为真就是一句（引号里的分号、触发器都对）。"""
    out, buf, start, off = [], [], 0, 0
    for line in text.splitlines(keepends=True):
        if not buf:
            start = off
        buf.append(line)
        off += len(line.encode('utf-8', errors='surrogateescape'))
        joined = ''.join(buf)
        if sqlite3.complete_statement(joined):
            out.append(Stmt(joined, start, off - start, len(out)))
            buf = []
    if buf and ''.join(buf).strip():
        joined = ''.join(buf)
        out.append(Stmt(joined, start, off - start, len(out)))
    return out


def clean(msg):
    msg = re.sub(r"'(?:[^']|'')*'?", "'…'", str(msg))
    msg = re.sub(r'"([^"]*)"', lambda m: m.group(0) if IDENT.fullmatch(m.group(1)) else '"…"', msg)
    return msg[:200]


def schema(stmts):
    """只执行建表语句，拿各表的外键：{表: [(本表列, 父表, 父表列), …]}"""
    db = sqlite3.connect(':memory:')
    ok = set()
    for s in stmts:
        if s.kind == 'CREATE TABLE':
            try:
                db.execute(s.text)
                ok.add(s.table)
            except sqlite3.Error:
                pass  # 建不出来的表没有外键信息；inspect 逐句执行那一步会照实报出来
    fks = {}
    for s in stmts:
        if s.kind == 'CREATE TABLE' and s.table in ok and IDENT.fullmatch(s.table):
            fks[s.table] = [(r[3], r[2], r[4]) for r in db.execute(f'PRAGMA foreign_key_list("{s.table}")')]
    return fks


def table_order(stmts, fks):
    """先父后子；没有先后关系的按原来的建表顺序。自己引用自己的边不算。"""
    created = [s.table for s in stmts if s.kind == 'CREATE TABLE']
    rank = {t: i for i, t in enumerate(created)}
    parents = {t: {p for (_, p, _) in fks.get(t, []) if p != t and p in rank} for t in created}
    order, done = [], set()
    while len(order) < len(created):
        ready = [t for t in created if t not in done and parents[t] <= done]
        if not ready:  # 有环：剩下的按原顺序（schema 里没有环，这里只是兜底，reorder 会照实报出来）
            ready = [t for t in created if t not in done][:1]
        t = min(ready, key=rank.get)
        order.append(t)
        done.add(t)
    return order


def self_ref_order(create_text, inserts, fk_cols):
    """自己引用自己的表：把这张表的插入语句单独装一遍，按 rowid 对上每一行，行之间先父后子排。"""
    db = sqlite3.connect(':memory:')
    db.execute(create_text)
    table = re.search(r'INSERT\s+INTO\s+["`\[]?([A-Za-z0-9_]+)', inserts[0].text, re.I).group(1)
    rowid_of = []
    for s in inserts:
        db.execute(s.text)
        rowid_of.append(db.execute('SELECT last_insert_rowid()').fetchone()[0])
    if len(set(rowid_of)) != len(inserts):  # 没有 rowid 的表对不上行：照原样，调用方会报"挪了 0 行"
        return inserts, 0
    cols_from = [c for (c, _, _) in fk_cols]
    cols_to = [c for (_, _, c) in fk_cols]
    sel = ', '.join(f'"{c}"' for c in cols_from + cols_to)
    vals = {r[0]: r[1:] for r in db.execute(f'SELECT rowid, {sel} FROM "{table}"')}
    n = len(cols_from)
    key_to_rowid = {tuple(v[n:]): rid for rid, v in vals.items()}
    parent = {}
    for rid, v in vals.items():
        ref = tuple(v[:n])
        if all(x is not None for x in ref) and ref in key_to_rowid and key_to_rowid[ref] != rid:
            parent[rid] = key_to_rowid[ref]
    placed, out, moved = set(), [], 0
    pending = list(range(len(inserts)))
    while pending:
        nxt = [i for i in pending if parent.get(rowid_of[i]) is None or parent[rowid_of[i]] in placed]
        if not nxt:  # 行之间有环：剩下的照原样
            nxt = pending[:]
        for i in nxt:
            if out and i < out[-1]:
                moved += 1
            out.append(i)
            placed.add(rowid_of[i])
        pending = [i for i in pending if i not in set(nxt)]
    return [inserts[i] for i in out], moved


def reorder(stmts):
    fks = schema(stmts)
    pre, creates, rest = [], [], []
    inserts = collections.OrderedDict()
    seen_create = False
    for s in stmts:
        if s.kind == 'CREATE TABLE':
            seen_create = True
            creates.append(s)
        elif s.kind == 'INSERT' and s.table != 'sqlite_sequence':
            inserts.setdefault(s.table, []).append(s)
        elif not seen_create and s.kind == 'PRAGMA':
            pre.append(s)
        else:
            rest.append(s)
    order = table_order(stmts, fks)
    create_text = {s.table: s.text for s in creates}
    body, notes = [], []
    for t in order:
        rows = inserts.get(t, [])
        self_fk = [f for f in fks.get(t, []) if f[1] == t]
        if rows and self_fk:
            rows, moved = self_ref_order(create_text[t], rows, self_fk)
            notes.append(f'{t} 自己引用自己，{len(rows)} 行里挪了 {moved} 行')
        body.extend(rows)
    leftover = [t for t in inserts if t not in order]
    for t in leftover:  # 有数据却没有建表语句：照原样放在数据最后，导入时自然报错
        body.extend(inserts[t])
    out = pre + creates + body + rest
    if sorted(s.text for s in out) != sorted(s.text for s in stmts):
        raise SystemExit('重排前后的语句对不上，没写输出')
    return out, order, notes, leftover


def late_children(stmts, fks):
    """子表有数据排在父表的数据前面：[(子表, 父表, 子表第一条的位置, 父表最后一条的位置)]"""
    first, last = {}, {}
    for s in stmts:
        if s.kind == 'INSERT' and s.table != 'sqlite_sequence':
            first.setdefault(s.table, s.pos)
            last[s.table] = s.pos
    bad = []
    for t, fl in fks.items():
        for (_, p, _) in fl:
            if p != t and t in first and p in last and first[t] < last[p]:
                bad.append((t, p))
    return sorted(set(bad))


def try_load(stmts, foreign_keys, one_transaction, skip_defer=False):
    db = sqlite3.connect(':memory:', isolation_level=None)
    db.execute(f'PRAGMA foreign_keys = {"ON" if foreign_keys else "OFF"}')
    errs = []
    if one_transaction:
        db.execute('BEGIN')
    for s in stmts:
        if skip_defer and s.kind == 'PRAGMA' and 'defer_foreign_keys' in s.text.lower():
            continue
        try:
            db.execute(s.text)
        except sqlite3.Error as e:
            errs.append((s, clean(e)))
    commit_err = None
    if one_transaction:
        try:
            db.execute('COMMIT')
        except sqlite3.Error as e:
            commit_err = clean(e)
    return db, errs, commit_err


def p(msg):
    print(f'诊断：{msg}', flush=True)


def kb(n):
    return f'{n / 1024:.0f}'


def inspect(path):
    raw, text, bad = read(path)
    stmts = split(text)
    p(f'明文 {kb(len(raw))} KB，{len(stmts)} 句；空字节 {raw.count(0)} 处，非法 UTF-8 {bad} 处')
    kinds = collections.Counter(s.kind for s in stmts)
    p('语句种类：' + '、'.join(f'{k} {n}' for k, n in kinds.most_common()))
    objs = [s.kind for s in stmts if s.kind in ('CREATE TRIGGER', 'CREATE VIEW')]
    p(f'触发器/视图：{len(objs) or "没有"}')
    fks = schema(stmts)
    created = [s.table for s in stmts if s.kind == 'CREATE TABLE']
    p('建表顺序：' + ', '.join(created))
    blocks = collections.OrderedDict()
    for s in stmts:
        if s.kind == 'INSERT':
            b = blocks.setdefault(s.table, [s.start, 0, 0])
            b[1] = s.start + s.size
            b[2] += 1
    p('数据在文件里的位置（KB）：' + ', '.join(f'{t} {kb(a)}–{kb(e)}（{n} 行）' for t, (a, e, n) in blocks.items()))
    late = late_children(stmts, fks)
    p('子表的数据排在父表前面：' + (', '.join(f'{c}→{par}' for c, par in late) or '没有'))
    selfref = [t for t, fl in fks.items() if any(f[1] == t for f in fl) and t in blocks]
    p('自己引用自己的表：' + (', '.join(selfref) or '没有'))
    top = sorted(stmts, key=lambda s: -s.size)[:5]
    p('最长的 5 句：' + ', '.join(f'{s.kind} {s.table or "-"} {s.size} 字节' for s in top))
    big = collections.Counter(s.table or s.kind for s in stmts if s.size > 100_000)
    p('超过 100000 字节的：' + (', '.join(f'{t} {n} 句' for t, n in big.items()) or '没有'))

    db, errs, _ = try_load(stmts, foreign_keys=False, one_transaction=False)
    p(f'（普通 SQLite，外键关着）逐句执行：{len(errs)} 句出错' + ''.join(
        f'；第 {s.pos} 句 {s.kind} {s.table}：{m}' for s, m in errs[:5]))
    try:
        viol = collections.Counter((r[0], r[2]) for r in db.execute('PRAGMA foreign_key_check'))
        p('（普通 SQLite）外键检查：' + (', '.join(f'{c}→{par} {n} 行' for (c, par), n in viol.items()) or '没有对不上的行'))
    except sqlite3.Error as e:
        p(f'（普通 SQLite）外键检查出错：{clean(e)}')
    p(f'（普通 SQLite）完整性检查：{db.execute("PRAGMA integrity_check").fetchone()[0][:100]}')
    _, errs, commit_err = try_load(stmts, foreign_keys=True, one_transaction=True)
    p('（普通 SQLite，外键开着）整份一个事务、推迟到提交时查：' + (
        f'{len(errs)} 句出错' if errs else '各句都过') + (f'；提交失败：{commit_err}' if commit_err else '；提交成功'))
    _, errs, _ = try_load(stmts, foreign_keys=True, one_transaction=False, skip_defer=True)
    by = collections.Counter(s.table for s, _ in errs)
    p('（普通 SQLite，外键开着）每句单独提交、立刻查：' + (
        f'{len(errs)} 句出错（' + ', '.join(f'{t} {n}' for t, n in by.most_common()) + f'；头一句：{errs[0][1]}）'
        if errs else '0 句出错'))
    out, order, notes, leftover = reorder(stmts)
    _, errs2, _ = try_load(out, foreign_keys=True, one_transaction=False, skip_defer=True)
    p(f'按外键先父后子重排之后，同样每句单独提交、立刻查：{len(errs2)} 句出错'
      + (f'（头一句：{errs2[0][1]}）' if errs2 else '') + (f'；{"；".join(notes)}' if notes else ''))


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == 'inspect':
        inspect(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == 'reorder':
        _, text, _ = read(sys.argv[2])
        stmts = split(text)
        out, order, notes, leftover = reorder(stmts)
        with open(sys.argv[3], 'wb') as f:
            for s in out:
                t = s.text if s.text.endswith('\n') else s.text + '\n'
                f.write(t.encode('utf-8', errors='surrogateescape'))
        print(f'建表语句 {sum(1 for s in out if s.kind == "CREATE TABLE")} 句放最前，数据按外键先父后子：' + ', '.join(
            t for t in order if any(s.kind == 'INSERT' and s.table == t for s in stmts)))
        for n in notes:
            print(n)
        if leftover:
            print('有数据却没有建表语句的表（照原样放在数据最后）：' + ', '.join(leftover))
    else:
        print('用法：d1-dump-tool.py inspect <导出文件> | reorder <导出文件> <输出>', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
