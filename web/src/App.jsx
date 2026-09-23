import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { SubjectProvider, useSubject } from './subject.jsx';
import Shell from './components/Shell.jsx';
import { Alert, Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import SubjectPicker from './pages/SubjectPicker.jsx';
import UserHome from './pages/UserHome.jsx';
import ExamNew from './pages/ExamNew.jsx';
import ExamTake from './pages/ExamTake.jsx';
import ExamReport from './pages/ExamReport.jsx';
import History from './pages/History.jsx';
import PracticeNew from './pages/PracticeNew.jsx';
import PracticeRun from './pages/PracticeRun.jsx';
import PracticeSummary from './pages/PracticeSummary.jsx';
import WrongBook from './pages/WrongBook.jsx';
import Assessment from './pages/Assessment.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import Subjects from './pages/admin/Subjects.jsx';
import BankList from './pages/admin/BankList.jsx';
import BankReview from './pages/admin/BankReview.jsx';
import Users from './pages/admin/Users.jsx';
import AISettings from './pages/admin/AISettings.jsx';
import SystemSettings from './pages/admin/SystemSettings.jsx';
import Students from './pages/admin/Students.jsx';
import Export from './pages/admin/Export.jsx';

const ADMIN_NAV = [
  { to: '/admin', label: '题库总览', end: true },
  { to: '/admin/subjects', label: '学科管理' },
  { to: '/admin/bank', label: '试卷与校对' },
  { to: '/admin/students', label: '学员学情' },
  { to: '/admin/users', label: '账号管理' },
  { to: '/admin/export', label: '数据导出' },
  { to: '/admin/ai', label: 'AI 配置' },
  { to: '/admin/settings', label: '系统参数' },
  { to: '/admin/password', label: '修改密码' },
];

// 学员导航按学科生成：不同学科的功能顺序不一样（生化的主路径是章节练习，
// 排在模考之前），所以这里接收学科而不是用一个写死的数组。
function userNav(subject) {
  const p = (rest) => `/app/${subject.code}${rest}`;
  const practiceFirst = subject.contentGroupKind === 'TEXTBOOK_CHAPTER';
  const exam = { to: p('/exam/new'), label: '模拟考试' };
  const practice = { to: p('/practice/new'), label: '专项练习' };
  return [
    { to: p(''), label: '学科首页', end: true },
    ...(practiceFirst ? [practice, exam] : [exam, practice]),
    { to: p('/wrongbook'), label: '错题本' },
    { to: p('/assessment'), label: '能力评估' },
    { to: p('/history'), label: '历史记录' },
    { to: '/app/password', label: '修改密码' },
  ];
}

function Guard({ role, children }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  const loginPath = role === 'SUPER_ADMIN' ? '/admin/login' : '/login';

  if (!ready) return <div className="empty"><Loading /></div>;
  if (!user) return <Navigate to={loginPath} replace state={{ from: location.pathname }} />;
  // 管理员访问学员区不拦截；学员访问后台一律弹回自己的首页
  if (role === 'SUPER_ADMIN' && user.role !== 'SUPER_ADMIN') return <Navigate to="/app" replace />;
  return children;
}

// 学科加载失败（不存在 / 已停用 / 无权限）时，把人送回选择页并说明原因。
// 不静默跳转：不解释的话学员只会看到自己莫名其妙被弹回来了。
function SubjectError({ error }) {
  return (
    <div className="content">
      <Alert>{error.message || '这个学科打不开'}</Alert>
      <p style={{ marginTop: 16 }}>
        <a className="btn sm" href="/app?pick=1">回到学科选择</a>
      </p>
    </div>
  );
}

// 学科外壳：等 SubjectProvider 把学科取回来，再用它生成导航
function SubjectShell({ children }) {
  const { loading, subject } = useSubject();
  if (loading || !subject) return <div className="empty"><Loading /></div>;
  return <Shell nav={userNav(subject)} title={subject.name} subject={subject}>{children}</Shell>;
}

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/admin/login" element={<Login admin />} />

      {/* 学科选择页：登录后的落地页。只有一个可访问学科时它会自动跳进去 */}
      <Route path="/app" element={<Guard><SubjectPicker /></Guard>} />

      {/* 静态段排在动态段之前，react-router 会优先匹配静态的，
          所以 /app/password 不会被当成一个叫 password 的学科 */}
      <Route path="/app/password" element={
        <Guard><Shell nav={[{ to: '/app?pick=1', label: '返回学科选择' }]} title="账号"><ChangePassword /></Shell></Guard>
      } />

      {/* 作答页不套外壳：全屏、无侧边栏，减少作答中误触退出 */}
      <Route path="/app/:subjectCode/exam/:attemptId/take" element={
        <Guard><ExamTake /></Guard>
      } />
      <Route path="/app/:subjectCode/practice/:attemptId/run" element={
        <Guard><PracticeRun /></Guard>
      } />

      <Route path="/app/:subjectCode/*" element={
        <Guard>
          <SubjectProvider renderError={(e) => <SubjectError error={e} />}>
            <SubjectShell>
              <Routes>
                <Route index element={<UserHome />} />
                <Route path="exam/new" element={<ExamNew />} />
                <Route path="exam/:attemptId/report" element={<ExamReport />} />
                <Route path="practice/new" element={<PracticeNew />} />
                <Route path="practice/:attemptId/summary" element={<PracticeSummary />} />
                <Route path="wrongbook" element={<WrongBook />} />
                <Route path="assessment" element={<Assessment />} />
                <Route path="history" element={<History />} />
                <Route path="*" element={<Navigate to="/app" replace />} />
              </Routes>
            </SubjectShell>
          </SubjectProvider>
        </Guard>
      } />

      <Route path="/admin/*" element={
        <Guard role="SUPER_ADMIN">
          <Shell nav={ADMIN_NAV} title="后台管理" admin>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="subjects" element={<Subjects />} />
              <Route path="bank" element={<BankList />} />
              <Route path="bank/:examId" element={<BankReview />} />
              <Route path="students" element={<Students />} />
              <Route path="export" element={<Export />} />
              <Route path="users" element={<Users />} />
              <Route path="ai" element={<AISettings />} />
              <Route path="settings" element={<SystemSettings />} />
              <Route path="password" element={<ChangePassword />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Shell>
        </Guard>
      } />

      <Route path="*" element={
        <Navigate to={user ? (user.role === 'SUPER_ADMIN' ? '/admin' : '/app') : '/login'} replace />
      } />
    </Routes>
  );
}
