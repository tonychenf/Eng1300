import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get } from './api.js';

// 当前学科的上下文。页面靠它知道"我在哪个学科下"，以及这个学科有哪些课程。
//
// 学科码只从 URL 取（useParams），不从别处传。这样浏览器前进后退、直接贴链接、
// 刷新页面，拿到的都是同一个学科——不会出现"地址栏写着 A、页面显示 B"。
// 服务端那边是同一条原则（§6.2.3）。
const SubjectContext = createContext(null);

export function SubjectProvider({ children, renderError }) {
  const { subjectCode } = useParams();
  const [state, setState] = useState({ loading: true, subject: null, courses: [], error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, subject: null, courses: [], error: null });
    Promise.all([get(`/s/${subjectCode}`), get(`/s/${subjectCode}/courses`)])
      .then(([a, b]) => {
        if (!cancelled) setState({ loading: false, subject: a.subject, courses: b.courses, error: null });
      })
      .catch((e) => {
        // 401 由 api.js 统一广播、AuthProvider 处理，这里不管
        if (!cancelled && e.status !== 401) {
          setState({ loading: false, subject: null, courses: [], error: e });
        }
      });
    return () => { cancelled = true; };
  }, [subjectCode]);

  const value = useMemo(() => ({
    ...state,
    code: subjectCode,
    // 拼本学科下的路径。页面里不要自己拼 `/app/${code}/xxx`，
    // 漏掉学科码的链接会把人踢回选择页，而且很难在 review 时看出来。
    path: (rest = '') => `/app/${subjectCode}${rest}`,
  }), [state, subjectCode]);

  if (state.error) return renderError ? renderError(state.error) : null;
  return <SubjectContext.Provider value={value}>{children}</SubjectContext.Provider>;
}

export function useSubject() {
  const ctx = useContext(SubjectContext);
  if (!ctx) throw new Error('useSubject 必须在 SubjectProvider 内使用');
  return ctx;
}
