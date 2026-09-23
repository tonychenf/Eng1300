import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { get } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Loading, PageHead } from '../components/ui.jsx';

const LAST_KEY = 'xlearn_last_subject';

export function rememberSubject(code) {
  try { localStorage.setItem(LAST_KEY, code); } catch { /* 隐私模式下不可用 */ }
}
function lastSubject() {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

function when(ts) {
  if (!ts) return '还没开始';
  const days = Math.floor((Date.now() - new Date(`${ts}Z`).getTime()) / 86400000);
  if (days <= 0) return '今天来过';
  if (days === 1) return '昨天来过';
  return `${days} 天前来过`;
}

export default function SubjectPicker() {
  const { user } = useAuth();
  // ?pick=1 表示"我就是要挑一个"，此时不做任何自动跳转。
  // 没有这个出口的话，记忆过学科的人会被永远重定向进去、再也看不到选择页——
  // 连"返回学科选择"那个链接都会当场把人弹回来。
  const [params] = useSearchParams();
  const forcePick = params.get('pick') === '1';
  const [subjects, setSubjects] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/me/subjects').then((r) => setSubjects(r.subjects)).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="content"><Alert>{error}</Alert></div>;
  if (!subjects) return <div className="empty"><Loading /></div>;

  // 只有一个学科时直接进去，不显示选择页（forcePick 时除外）。
  // 判断写"数量 > 1"而不是把学科码硬编码进来——将来加学科不用回头改这一页。
  // （蓝本处理"只有一门课程"时就是这么写的，这里沿用同一个思路。）
  if (!forcePick && subjects.length === 1) return <Navigate to={`/app/${subjects[0].code}`} replace />;

  // 多学科时落回上次进的那个，但要先确认它还在可访问列表里——
  // 权限被撤销或学科被停用之后，记忆里的那个就不能再用了
  if (!forcePick && subjects.length > 1) {
    const last = lastSubject();
    if (last && subjects.some((s) => s.code === last)) {
      return <Navigate to={`/app/${last}`} replace />;
    }
  }

  if (subjects.length === 0) {
    return (
      <div className="content">
        <PageHead title={`你好，${user?.username}`} />
        <div className="card card-pad">
          <p>管理员尚未为你开通任何学科，请联系管理员。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="content">
      <PageHead title={`你好，${user?.username}`} desc="选择一个学科开始" />
      <div className="grid-cards">
        {subjects.map((s) => (
          <div className="card card-pad" key={s.code}>
            <div className="spread" style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 16 }}>{s.name}</h2>
              {s.ready
                ? <span className="badge info">{s.publishedQuestions} 题</span>
                : <span className="badge">尚未开放</span>}
            </div>
            {s.description ? <p className="small muted" style={{ marginTop: 0 }}>{s.description}</p> : null}
            {s.ready ? (
              <p className="small">
                已考 <strong>{s.examCount}</strong> 次 ·
                待订正错题 <strong>{s.wrongOpen}</strong> 道 · {when(s.lastActivity)}
              </p>
            ) : (
              <p className="small muted">这个学科的题库还在准备中。</p>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              {s.ready
                ? <Link className="btn sm" to={`/app/${s.code}`} onClick={() => rememberSubject(s.code)}>进入</Link>
                : <button className="btn sm" disabled>进入</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
