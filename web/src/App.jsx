import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Shell from './components/Shell.jsx';
import { Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import UserHome from './pages/UserHome.jsx';
import ExamNew from './pages/ExamNew.jsx';
import ExamTake from './pages/ExamTake.jsx';
import ExamReport from './pages/ExamReport.jsx';
import History from './pages/History.jsx';
import PracticeNew from './pages/PracticeNew.jsx';
import PracticeRun from './pages/PracticeRun.jsx';
import PracticeSummary from './pages/PracticeSummary.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import BankList from './pages/admin/BankList.jsx';
import BankReview from './pages/admin/BankReview.jsx';
import Users from './pages/admin/Users.jsx';
import AISettings from './pages/admin/AISettings.jsx';
import SystemSettings from './pages/admin/SystemSettings.jsx';

const ADMIN_NAV = [
  { to: '/admin', label: '题库总览', end: true },
  { to: '/admin/bank', label: '试卷与校对' },
  { to: '/admin/users', label: '账号管理' },
  { to: '/admin/ai', label: 'AI 配置' },
  { to: '/admin/settings', label: '系统参数' },
  { to: '/admin/password', label: '修改密码' },
];

const USER_NAV = [
  { to: '/app', label: '我的课程', end: true },
  { to: '/app/exam/new', label: '模拟考试' },
  { to: '/app/practice/new', label: '专项练习' },
  { to: '/app/history', label: '历史记录' },
  { to: '/app/password', label: '修改密码' },
];

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

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/admin/login" element={<Login admin />} />

      {/* 作答页不套外壳：全屏、无侧边栏，减少作答中误触退出 */}
      <Route path="/app/exam/:attemptId/take" element={
        <Guard><ExamTake /></Guard>
      } />
      <Route path="/app/practice/:attemptId/run" element={
        <Guard><PracticeRun /></Guard>
      } />

      <Route path="/app/*" element={
        <Guard>
          <Shell nav={USER_NAV} title="英语真题练习">
            <Routes>
              <Route index element={<UserHome />} />
              <Route path="exam/new" element={<ExamNew />} />
              <Route path="exam/:attemptId/report" element={<ExamReport />} />
              <Route path="practice/new" element={<PracticeNew />} />
              <Route path="practice/:attemptId/summary" element={<PracticeSummary />} />
              <Route path="history" element={<History />} />
              <Route path="password" element={<ChangePassword />} />
              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
          </Shell>
        </Guard>
      } />

      <Route path="/admin/*" element={
        <Guard role="SUPER_ADMIN">
          <Shell nav={ADMIN_NAV} title="后台管理" admin>
            <Routes>
              <Route index element={<Dashboard />} />
              <Route path="bank" element={<BankList />} />
              <Route path="bank/:examId" element={<BankReview />} />
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
